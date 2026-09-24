import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  DataSource,
  EntityManager,
  In,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Teacher } from './entities/teacher.entity';
import { TeachingSession } from './entities/teaching-session.entity';
import { Employee } from '../employee/employee.entity';
import {
  CreateTeacherDto,
  QueryTeachersDto,
  UpdateTeacherDto,
} from './dto/teacher.dto';
import {
  TEACHER_COLLABORATOR_ROLE,
  TEACHER_ROLES,
  TEACHER_STAFF_ROLE,
} from './teaching-roles';
import { SchoolsService } from '../school/schools.service';
import { Ward } from '../ward/ward.entity';
import { SubjectCatalog } from '../subject-catalog/subject-catalog.entity';
import { UpdateTeacherProfileDto } from './dto/teacher-profile.dto';
import { AvatarStorageService } from './avatar-storage.service';
import {
  TeacherLocationChange,
  TeacherLocationChangeStatus,
} from './entities/teacher-location-change.entity';
import {
  TeacherAccountRequest,
  TeacherAccountRequestStatus,
} from './entities/teacher-account-request.entity';
import {
  CaptureTeacherLocationDto,
  QueryTeacherLocationChangesDto,
  ReviewTeacherLocationDto,
} from './dto/teacher-location.dto';
import {
  QueryTeacherAccountRequestsDto,
  ReviewTeacherAccountRequestDto,
} from './dto/teacher-account-request.dto';
import { NotificationService } from '../notifications/services/notification.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import { FcmService } from '../fcm/fcm.service';
import { EmployeeFcmTokenService } from '../employee-fcm-token/employee-fcm-token.service';
import {
  findTeacherAccountApprovers,
  findTeachingManagers,
} from './teaching-managers.util';
import { FuelAllowanceTierService } from './fuel-allowance-tier.service';
import { vnToday } from '../suggest/utils/vn-date';

const MAX_LIMIT = 100;

/**
 * Một nguồn phân loại duy nhất cho cả response và bộ lọc. Nếu dữ liệu cũ bị
 * gán nhầm đồng thời hai role thì ưu tiên giáo viên công ty, nhờ vậy một hồ sơ
 * không thể xuất hiện ở cả hai tab.
 */
const TEACHER_ROLE_SQL = `CASE
  WHEN '${TEACHER_STAFF_ROLE}' = ANY(e.roles) THEN '${TEACHER_STAFF_ROLE}'
  WHEN '${TEACHER_COLLABORATOR_ROLE}' = ANY(e.roles) THEN '${TEACHER_COLLABORATOR_ROLE}'
  ELSE NULL
END`;

type PreparedTeacherCreate = {
  dto: CreateTeacherDto;
  preferences: { wards: Ward[]; subjectCatalogs: SubjectCatalog[] };
  passwordHash: string | null;
  coordinates: { latitude: number | null; longitude: number | null };
};

@Injectable()
export class TeacherService {
  private readonly logger = new Logger(TeacherService.name);

  constructor(
    @InjectRepository(Teacher)
    private readonly teacherRepo: Repository<Teacher>,

    @InjectRepository(TeachingSession)
    private readonly sessionRepo: Repository<TeachingSession>,

    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,

    private readonly dataSource: DataSource,

    @InjectRepository(Ward)
    private readonly wardRepo: Repository<Ward>,

    @InjectRepository(SubjectCatalog)
    private readonly subjectCatalogRepo: Repository<SubjectCatalog>,
    private readonly avatarStorage: AvatarStorageService,

    /**
     * Đặt cuối danh sách tham số: các test dựng service bằng vị trí, chèn vào
     * giữa sẽ lệch toàn bộ repo phía sau.
     */
    private readonly schoolsService: SchoolsService,

    @InjectRepository(TeacherLocationChange)
    private readonly locationChangeRepo: Repository<TeacherLocationChange>,

    private readonly notificationService: NotificationService,
    private readonly fcmService: FcmService,
    private readonly employeeFcmTokenService: EmployeeFcmTokenService,

    @InjectRepository(TeacherAccountRequest)
    private readonly accountRequestRepo: Repository<TeacherAccountRequest>,

    /**
     * Điền phụ cấp xăng cho các buổi đang trống khi giáo viên có vị trí/trở
     * thành giáo viên công ty. Test dựng service bằng vị trí nên có thể thiếu
     * — gọi qua `recomputeGasAllowances()` để khỏi vỡ các test cũ.
     */
    private readonly fuelAllowanceTierService?: FuelAllowanceTierService,
  ) {}

  /**
   * Phụ cấp xăng chỉ được chốt lúc tạo buổi, nên buổi tạo ra khi giáo viên
   * chưa có vị trí sẽ trống mãi — mỗi lần vị trí/loại giáo viên đổi thì điền
   * lại các chỗ trống đó. Lỗi chỉ ghi log, không làm hỏng thao tác chính.
   */
  private async recomputeGasAllowances(teacherId: number): Promise<void> {
    await this.fuelAllowanceTierService?.recomputeMissingGasAllowancesSafely({
      teacherId,
    });
  }

  /**
   * Vị trí nhà mới có hiệu lực TỪ NGÀY DUYỆT: tính lại phụ cấp mọi buổi từ
   * ngày đó (kể cả buổi đã chốt theo nhà cũ), rồi điền nốt các buổi còn trống.
   */
  private async applyNewLocation(
    teacherId: number,
    effectiveAt: Date,
  ): Promise<void> {
    await this.fuelAllowanceTierService?.reapplyTeacherLocationSafely(
      teacherId,
      vnToday(effectiveAt),
    );
    await this.recomputeGasAllowances(teacherId);
  }

  async create(dto: CreateTeacherDto) {
    const prepared = await this.prepareCreate(dto);
    const teacherId = await this.runCreate(prepared);
    return this.findOne(teacherId);
  }

  /**
   * Kiểm tra trùng, giải toạ độ và băm mật khẩu — mọi việc làm được **ngoài**
   * transaction. Tách riêng vì luồng duyệt hồ sơ của Nhân sự phải chạy lại
   * đúng các bước này ở thời điểm duyệt: hồ sơ nằm chờ vài ngày thì số điện
   * thoại có thể đã bị hồ sơ khác chiếm mất.
   *
   * `passwordHash` truyền vào khi mật khẩu đã được băm sẵn lúc gửi đề nghị —
   * mật khẩu thô không bao giờ được lưu lại để dùng ở bước duyệt.
   */
  private async prepareCreate(
    dto: CreateTeacherDto,
    passwordHash?: string | null,
  ) {
    if ((dto.password || passwordHash) && dto.employeeId) {
      throw new BadRequestException(
        'Không thể vừa tạo tài khoản mới vừa gắn tài khoản có sẵn',
      );
    }

    await this.assertPhoneAvailable(dto.phone);
    await this.assertEmailAvailable(dto.email);
    await this.assertZaloUidAvailable(dto.zaloUid);
    await this.assertZaloUserIdAvailable(dto.zaloUserId);

    const preferences = await this.resolvePreferences(
      dto.wardIds,
      dto.subjectCatalogIds,
    );

    const hash =
      passwordHash ??
      (dto.password ? await bcrypt.hash(dto.password, 10) : null);

    if (!hash) {
      await this.assertEmployeeLinkable(dto.employeeId);
    }

    return {
      dto,
      preferences,
      passwordHash: hash,
      // Gọi mạng ngoài (giải link Google Maps) — cố ý làm trước khi mở
      // transaction để không giữ khoá bảng suốt thời gian chờ HTTP.
      coordinates: await this.resolveTeacherCoordinates(dto.googleMapsUrl),
    };
  }

  /**
   * `manager` có giá trị khi việc tạo giáo viên phải nằm chung transaction với
   * thao tác khác (Nhân sự duyệt hồ sơ: tạo giáo viên và đóng hồ sơ phải cùng
   * ăn hoặc cùng huỷ).
   */
  private async runCreate(
    prepared: PreparedTeacherCreate,
    manager?: EntityManager,
  ): Promise<number> {
    const run = (m: EntityManager) => this.insertTeacher(m, prepared);

    try {
      return manager
        ? await run(manager)
        : await this.dataSource.transaction(run);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as any).code === '23505'
      ) {
        const detail = String((error as any).detail || '');
        if (detail.includes('(phone)')) {
          throw new ConflictException('Số điện thoại đã được sử dụng');
        }
        if (detail.includes('(email)')) {
          throw new ConflictException('Email đã được sử dụng');
        }
      }
      throw error;
    }
  }

  private async insertTeacher(
    manager: EntityManager,
    { dto, preferences, passwordHash, coordinates }: PreparedTeacherCreate,
  ): Promise<number> {
    const teacherRepo = manager.getRepository(Teacher);
    let employeeId = dto.employeeId ?? null;

    if (passwordHash) {
      const employeeRepo = manager.getRepository(Employee);

      const [employeeByPhone, employeeByEmail] = await Promise.all([
        employeeRepo.findOne({ where: { phone: dto.phone } }),
        employeeRepo.findOne({ where: { email: dto.email } }),
      ]);
      if (employeeByPhone) {
        throw new ConflictException('Số điện thoại đã được sử dụng');
      }
      if (employeeByEmail) {
        throw new ConflictException('Email đã được sử dụng');
      }

      const employee = await employeeRepo.save(
        employeeRepo.create({
          name: dto.name,
          phone: dto.phone,
          email: dto.email,
          password: passwordHash,
          roles: [dto.teacherRole ?? TEACHER_STAFF_ROLE],
          department: { id: 1 },
        }),
      );
      employeeId = employee.id ?? null;
    }

    const teacher = await teacherRepo.save(
      teacherRepo.create({
        name: dto.name,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        employeeId,
        isActive: dto.isActive ?? true,
        maxPeriodsPerWeek: dto.maxPeriodsPerWeek ?? null,
        defaultRatePerPeriod: dto.defaultRatePerPeriod ?? null,
        note: dto.note ?? null,
        googleMapsUrl: dto.googleMapsUrl ?? null,
        zaloUid: dto.zaloUid ?? null,
        zaloUserId: dto.zaloUserId ?? null,
        ...coordinates,
        allowedWards: preferences.wards,
        teachableSubjectCatalogs: preferences.subjectCatalogs,
      }),
    );

    return teacher.id;
  }

  async resetPassword(id: number, password = '123456') {
    const teacher = await this.getEntity(id);
    if (!teacher.employeeId) {
      throw new BadRequestException('Giáo viên chưa có tài khoản đăng nhập');
    }

    const employee = await this.employeeRepo.findOne({
      where: { id: teacher.employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Tài khoản nhân viên không tồn tại');
    }

    employee.password = await bcrypt.hash(password, 10);
    await this.employeeRepo.save(employee);
    return { password };
  }

  async findAll(query: QueryTeachersDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, MAX_LIMIT);

    const qb = this.buildTeacherQuery();

    if (query.isActive !== undefined) {
      qb.andWhere('t.isActive = :isActive', { isActive: query.isActive });
    }

    if (query.schoolId) {
      // Chỉ giáo viên đang có mẫu lịch còn hiệu lực ở trường này.
      qb.andWhere(
        `EXISTS (
                    SELECT 1 FROM teaching_schedules s
                    WHERE s.teacher_id = t.id
                      AND s.school_id = :schoolId
                      AND s.is_active = true
                )`,
        { schoolId: query.schoolId },
      );
    }

    if (query.teacherRole) {
      qb.andWhere(`${TEACHER_ROLE_SQL} = :teacherRole`, {
        teacherRole: query.teacherRole,
      });
    }

    if (query.search) {
      const term = `%${query.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      qb.andWhere(
        new Brackets((b) => {
          b.where('LOWER(t.name) LIKE :term', { term })
            .orWhere('LOWER(t.phone) LIKE :term', { term })
            .orWhere('LOWER(t.email) LIKE :term', { term });
        }),
      );
    }

    const total = await qb.getCount();

    const rows = await qb
      .orderBy('t.name', 'ASC')
      .addOrderBy('t.id', 'ASC')
      .limit(limit)
      .offset((page - 1) * limit)
      .getRawMany();

    const preferences = await this.loadPreferenceMap(
      rows.map((row) => Number(row.id)),
    );

    return {
      data: rows.map((row) => this.toTeacherItem(row, preferences)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Trả về cùng một shape với danh sách. Không dùng `relations: ['employee']`
   * vì nó kéo theo cả `password` băm và `fcmToken` của tài khoản.
   */
  async findOne(id: number) {
    const row = await this.buildTeacherQuery()
      .where('t.id = :id', { id })
      .getRawOne();

    if (!row) {
      throw new NotFoundException('Giáo viên không tồn tại');
    }

    const preferences = await this.loadPreferenceMap([Number(row.id)]);
    return this.toTeacherItem(row, preferences);
  }

  async update(id: number, dto: UpdateTeacherDto, actorId?: number) {
    const teacher = await this.getEntity(id);
    const previousLatitude = teacher.latitude ?? null;
    const previousLongitude = teacher.longitude ?? null;

    if (dto.phone !== undefined) {
      await this.assertPhoneAvailable(dto.phone, id);
      teacher.phone = dto.phone ?? null;
    }

    if (dto.email !== undefined) {
      await this.assertEmailAvailable(dto.email, id);
      teacher.email = dto.email ?? null;
    }

    if (dto.employeeId !== undefined) {
      await this.assertEmployeeLinkable(dto.employeeId, id);
      teacher.employeeId = dto.employeeId ?? null;
    }

    if (dto.teacherRole !== undefined && teacher.employeeId) {
      await this.changeTeacherRole(teacher.employeeId, dto.teacherRole);
    }

    if (dto.name !== undefined) teacher.name = dto.name;
    if (dto.isActive !== undefined) teacher.isActive = dto.isActive;
    if (dto.note !== undefined) teacher.note = dto.note ?? null;
    if (dto.googleMapsUrl !== undefined) {
      teacher.googleMapsUrl = dto.googleMapsUrl ?? null;
      const coords = await this.resolveTeacherCoordinates(dto.googleMapsUrl);
      teacher.latitude = coords.latitude;
      teacher.longitude = coords.longitude;
    }
    if (dto.maxPeriodsPerWeek !== undefined) {
      teacher.maxPeriodsPerWeek = dto.maxPeriodsPerWeek ?? null;
    }
    if (dto.defaultRatePerPeriod !== undefined) {
      teacher.defaultRatePerPeriod = dto.defaultRatePerPeriod;
    }

    if (dto.zaloUid !== undefined) {
      await this.assertZaloUidAvailable(dto.zaloUid, id);
      teacher.zaloUid = dto.zaloUid ?? null;
    }

    if (dto.zaloUserId !== undefined) {
      await this.assertZaloUserIdAvailable(dto.zaloUserId, id);
      teacher.zaloUserId = dto.zaloUserId ?? null;
    }

    if (dto.wardIds !== undefined || dto.subjectCatalogIds !== undefined) {
      const preferences = await this.resolvePreferences(
        dto.wardIds,
        dto.subjectCatalogIds,
      );
      if (dto.wardIds !== undefined) {
        teacher.allowedWards = preferences.wards;
      }
      if (dto.subjectCatalogIds !== undefined) {
        teacher.teachableSubjectCatalogs = preferences.subjectCatalogs;
      }
    }

    await this.teacherRepo.save(teacher);

    const locationChanged =
      dto.googleMapsUrl !== undefined &&
      (Number(teacher.latitude ?? NaN) !== Number(previousLatitude ?? NaN) ||
        Number(teacher.longitude ?? NaN) !== Number(previousLongitude ?? NaN));

    if (locationChanged) {
      const now = new Date();
      // Nhân sự sửa thẳng trong hồ sơ cũng là một lần đổi nhà — phải để lại
      // lịch sử thì mới biết các ngày trước đó giáo viên ở đâu.
      if (teacher.latitude != null && teacher.longitude != null) {
        await this.locationChangeRepo.save(
          this.locationChangeRepo.create({
            teacherId: id,
            latitude: teacher.latitude,
            longitude: teacher.longitude,
            previousLatitude,
            previousLongitude,
            status: TeacherLocationChangeStatus.APPROVED,
            reviewedBy: actorId ?? null,
            reviewNote: 'Nhân sự sửa vị trí trong hồ sơ giáo viên',
            reviewedAt: now,
          }),
        );
      }
      await this.applyNewLocation(id, now);
    } else if (dto.teacherRole !== undefined || dto.employeeId !== undefined) {
      await this.recomputeGasAllowances(id);
    }

    return this.findOne(id);
  }

  /**
   * Chỉ xoá cứng khi chưa từng có buổi dạy — còn dữ liệu chấm công thì
   * phải giữ lịch sử, hướng người dùng sang ngừng hoạt động.
   */
  async remove(id: number): Promise<{ deleted: true }> {
    const teacher = await this.getEntity(id);

    const sessionCount = await this.sessionRepo.count({
      where: { teacherId: id },
    });

    if (sessionCount > 0) {
      throw new ConflictException(
        `Giáo viên đã có ${sessionCount} buổi dạy, không xoá được. Hãy đặt isActive = false để ngừng hoạt động.`,
      );
    }

    await this.teacherRepo.remove(teacher);
    return { deleted: true };
  }

  /** Hồ sơ giáo viên gắn với tài khoản đang đăng nhập. */
  async findByEmployeeId(employeeId: number) {
    const row = await this.buildTeacherQuery()
      .where('t.employee_id = :employeeId', { employeeId })
      .getRawOne();

    if (!row) {
      throw new NotFoundException(
        'Tài khoản này chưa được gắn với hồ sơ giáo viên nào',
      );
    }

    const pending = await this.locationChangeRepo.findOne({
      where: {
        teacherId: Number(row.id),
        status: TeacherLocationChangeStatus.PENDING,
      },
    });

    return {
      ...this.toProfile(row),
      locationChangeStatus: pending ? 'pending' : null,
      pendingLocation: pending
        ? { latitude: pending.latitude, longitude: pending.longitude }
        : null,
    };
  }

  async updateMine(
    employeeId: number,
    dto: UpdateTeacherProfileDto,
    avatar?: Express.Multer.File,
  ) {
    if (avatar && dto.removeAvatar) {
      throw new BadRequestException(
        'Không thể vừa tải ảnh mới vừa yêu cầu xóa ảnh đại diện',
      );
    }

    const teacher = await this.teacherRepo.findOne({ where: { employeeId } });
    if (!teacher)
      throw new NotFoundException(
        'Tài khoản này chưa được gắn với hồ sơ giáo viên nào',
      );

    let newAvatarUrl: string | undefined;
    if (avatar) newAvatarUrl = await this.avatarStorage.store(avatar);
    const oldAvatarUrl = teacher.avatarUrl;

    try {
      await this.dataSource.transaction(async (manager) => {
        const teachers = manager.getRepository(Teacher);
        const employees = manager.getRepository(Employee);
        const current = await teachers.findOne({ where: { id: teacher.id } });
        const employee = await employees.findOne({ where: { id: employeeId } });
        if (!current || !employee)
          throw new NotFoundException(
            'Tài khoản này chưa được gắn với hồ sơ giáo viên nào',
          );

        if (dto.phone !== undefined) {
          const [otherTeacher, otherEmployee] = await Promise.all([
            teachers.findOne({
              where: { phone: dto.phone, id: Not(current.id) },
            }),
            employees.findOne({
              where: { phone: dto.phone, id: Not(employeeId) },
            }),
          ]);
          if (otherTeacher || otherEmployee)
            throw new ConflictException('Số điện thoại đã được sử dụng');
          current.phone = employee.phone = dto.phone;
        }
        if (dto.email !== undefined) {
          const [otherTeacher, otherEmployee] = await Promise.all([
            teachers.findOne({
              where: { email: dto.email, id: Not(current.id) },
            }),
            employees.findOne({
              where: { email: dto.email, id: Not(employeeId) },
            }),
          ]);
          if (otherTeacher || otherEmployee)
            throw new ConflictException('Email đã được sử dụng');
          current.email = employee.email = dto.email;
        }
        if (dto.name !== undefined) current.name = employee.name = dto.name;
        if (newAvatarUrl) current.avatarUrl = newAvatarUrl;
        if (dto.removeAvatar) current.avatarUrl = null;
        await employees.save(employee);
        await teachers.save(current);
      });
    } catch (error) {
      if (newAvatarUrl) await this.avatarStorage.remove(newAvatarUrl);
      if (
        error instanceof QueryFailedError &&
        (error as any).code === '23505'
      ) {
        const detail = String((error as any).detail || '');
        if (detail.includes('phone'))
          throw new ConflictException('Số điện thoại đã được sử dụng');
        if (detail.includes('email'))
          throw new ConflictException('Email đã được sử dụng');
      }
      throw error;
    }

    if ((newAvatarUrl || dto.removeAvatar) && oldAvatarUrl)
      await this.avatarStorage.remove(oldAvatarUrl);
    return this.findByEmployeeId(employeeId);
  }

  /** Lần đầu ghi trực tiếp; các lần sau chỉ tạo/cập nhật yêu cầu chờ duyệt. */
  async captureMyLocation(employeeId: number, dto: CaptureTeacherLocationDto) {
    const result = await this.dataSource.transaction(async (manager) => {
      const teachers = manager.getRepository(Teacher);
      const changes = manager.getRepository(TeacherLocationChange);
      const teacher = await teachers.findOne({
        where: { employeeId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!teacher) {
        throw new NotFoundException(
          'Tài khoản này chưa được gắn với hồ sơ giáo viên nào',
        );
      }

      if (
        teacher.latitude === null ||
        teacher.latitude === undefined ||
        teacher.longitude === null ||
        teacher.longitude === undefined
      ) {
        teacher.latitude = dto.latitude;
        teacher.longitude = dto.longitude;
        teacher.googleMapsUrl = null;
        await teachers.save(teacher);
        // Lần khai đầu không cần duyệt nhưng vẫn ghi lịch sử — mốc bắt đầu để
        // tra vị trí nhà theo từng ngày dạy.
        await changes.save(
          changes.create({
            teacherId: teacher.id,
            latitude: dto.latitude,
            longitude: dto.longitude,
            previousLatitude: null,
            previousLongitude: null,
            status: TeacherLocationChangeStatus.APPROVED,
            reviewedBy: null,
            reviewNote: 'Giáo viên khai vị trí lần đầu',
            reviewedAt: new Date(),
          }),
        );
        return {
          status: 'captured',
          teacherId: teacher.id,
          requiresApproval: false,
          latitude: dto.latitude,
          longitude: dto.longitude,
        };
      }

      let request = await changes.findOne({
        where: {
          teacherId: teacher.id,
          status: TeacherLocationChangeStatus.PENDING,
        },
      });
      if (!request) {
        request = changes.create({
          teacherId: teacher.id,
          previousLatitude: teacher.latitude,
          previousLongitude: teacher.longitude,
          status: TeacherLocationChangeStatus.PENDING,
          reviewedBy: null,
          reviewNote: null,
          reviewedAt: null,
        });
      }
      request.latitude = dto.latitude;
      request.longitude = dto.longitude;
      const saved = await changes.save(request);
      return { status: 'pending', requiresApproval: true, requestId: saved.id };
    });

    if (result.status === 'pending' && result.requestId !== undefined) {
      await this.notifyLocationChangeRequest(result.requestId, employeeId);
    }
    if (result.status === 'captured' && result.teacherId !== undefined) {
      await this.recomputeGasAllowances(result.teacherId);
    }
    return result;
  }

  /** Gửi cùng một thông báo cho toàn bộ Nhân sự và Giáo vụ đang hoạt động. */
  private async notifyLocationChangeRequest(
    requestId: number,
    teacherEmployeeId: number,
  ): Promise<void> {
    try {
      const [managers, teacher] = await Promise.all([
        findTeachingManagers(this.employeeRepo),
        this.teacherRepo.findOne({ where: { employeeId: teacherEmployeeId } }),
      ]);
      const receiverIds = [...new Set(managers.map((manager) => manager.id))];
      if (!receiverIds.length) return;

      const message = `${teacher?.name ?? 'Giáo viên'} đã gửi yêu cầu thay đổi vị trí. Vui lòng xác nhận để cập nhật.`;
      const meta = {
        kind: 'teacher_location_change_request',
        module: 'teaching',
        route: '/teaching/teachers/location-change-requests',
        url: '/teaching/teachers/location-change-requests',
        requestId,
        teacherId: teacher?.id ?? null,
      };

      await Promise.all(
        receiverIds.map((receiverId) =>
          this.notificationService.create({
            receiverId,
            type: NotificationType.TEACHER_LOCATION_CHANGE_REQUEST,
            message,
            entityId: requestId,
            meta,
          }),
        ),
      );

      const tokens = await this.employeeFcmTokenService.getTokens(receiverIds);
      if (tokens.length) {
        await this.fcmService.sendToMultiple(
          tokens.map((token) => token.token),
          'Yêu cầu thay đổi vị trí giáo viên',
          message,
          {
            kind: meta.kind,
            module: meta.module,
            route: meta.route,
            url: meta.url,
            requestId: String(requestId),
          },
        );
      }
    } catch (error) {
      // Yêu cầu đã lưu không được rollback chỉ vì một kênh thông báo lỗi.
      this.logger.error('Gửi thông báo đổi vị trí giáo viên lỗi', error as any);
    }
  }

  async findLocationChanges(query: QueryTeacherLocationChangesDto) {
    const status = query.status ?? TeacherLocationChangeStatus.PENDING;
    const rows = await this.locationChangeRepo.find({
      where: { status },
      relations: ['teacher', 'reviewer'],
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => ({
      id: row.id,
      teacherId: row.teacherId,
      teacherName: row.teacher?.name ?? null,
      latitude: row.latitude,
      longitude: row.longitude,
      previousLatitude: row.previousLatitude,
      previousLongitude: row.previousLongitude,
      status: row.status,
      reviewedBy: row.reviewedBy,
      reviewerName: row.reviewer?.name ?? null,
      reviewNote: row.reviewNote,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
    }));
  }

  async reviewLocationChange(
    id: number,
    reviewerId: number,
    approved: boolean,
    dto: ReviewTeacherLocationDto,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const changes = manager.getRepository(TeacherLocationChange);
      const request = await changes.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request)
        throw new NotFoundException('Yêu cầu đổi vị trí không tồn tại');
      if (request.status !== TeacherLocationChangeStatus.PENDING) {
        throw new ConflictException('Yêu cầu đổi vị trí đã được xử lý');
      }

      if (approved) {
        const teacher = await manager.getRepository(Teacher).findOne({
          where: { id: request.teacherId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!teacher) throw new NotFoundException('Giáo viên không tồn tại');
        teacher.latitude = request.latitude;
        teacher.longitude = request.longitude;
        teacher.googleMapsUrl = null;
        await manager.getRepository(Teacher).save(teacher);
      }

      request.status = approved
        ? TeacherLocationChangeStatus.APPROVED
        : TeacherLocationChangeStatus.REJECTED;
      request.reviewedBy = reviewerId;
      request.reviewNote = dto.note || null;
      request.reviewedAt = new Date();
      await changes.save(request);
      return {
        id: request.id,
        status: request.status,
        teacherId: request.teacherId,
        reviewedAt: request.reviewedAt,
      };
    });

    if (approved) {
      await this.applyNewLocation(result.teacherId, result.reviewedAt ?? new Date());
    }
    await this.notifyLocationChangeResult(result.teacherId, approved, dto.note);

    return { id: result.id, status: result.status };
  }

  /** Báo lại cho chính giáo viên khi yêu cầu đổi vị trí của họ được duyệt/từ chối. */
  private async notifyLocationChangeResult(
    teacherId: number,
    approved: boolean,
    note?: string | null,
  ): Promise<void> {
    try {
      const teacher = await this.teacherRepo.findOne({
        where: { id: teacherId },
      });
      if (!teacher?.employeeId) return;

      const message = approved
        ? 'Yêu cầu đổi vị trí của bạn đã được duyệt. Vị trí mới đã được cập nhật.'
        : `Yêu cầu đổi vị trí của bạn đã bị từ chối.${note ? ` Lý do: ${note}` : ''}`;
      const meta = {
        kind: 'teacher_location_change_result',
        module: 'teaching',
        route: '/giao-vien/lich-day',
        url: '/giao-vien/lich-day',
        teacherId: teacher.id,
        approved,
      };

      await this.notificationService.create({
        receiverId: teacher.employeeId,
        type: NotificationType.TEACHER_LOCATION_CHANGE_RESULT,
        message,
        meta,
      });

      const tokens = await this.employeeFcmTokenService.getTokens([
        teacher.employeeId,
      ]);
      if (tokens.length) {
        await this.fcmService.sendToMultiple(
          tokens.map((token) => token.token),
          approved
            ? '✅ Yêu cầu đổi vị trí đã được duyệt'
            : '❌ Yêu cầu đổi vị trí bị từ chối',
          message,
          {
            kind: meta.kind,
            module: meta.module,
            route: meta.route,
            url: meta.url,
          },
        );
      }
    } catch (error) {
      this.logger.error(
        'Gửi thông báo kết quả đổi vị trí giáo viên lỗi',
        error as any,
      );
    }
  }

  /**
   * Giáo vụ đề nghị mở tài khoản giáo viên.
   *
   * Cố ý **không** tạo trước rồi khoá lại (`isActive = false`): hồ sơ nháp nằm
   * trong bảng `teachers` sẽ chiếm mất số điện thoại/email, lọt vào danh sách
   * xếp lịch và vào cả thống kê — trong khi Nhân sự còn chưa đồng ý. Hồ sơ nằm
   * riêng ở `teacher_account_requests` cho tới lúc được duyệt.
   */
  async requestCreate(dto: CreateTeacherDto, requestedBy: number) {
    // Soát trùng ngay lúc gửi để Giáo vụ sửa liền, thay vì để Nhân sự bấm
    // duyệt rồi mới báo lỗi. Bước duyệt vẫn soát lại một lần nữa.
    const prepared = await this.prepareCreate(dto);
    await this.assertNoPendingAccountRequest(dto.phone, dto.email);

    const { password: _password, ...payload } = dto;
    const saved = await this.accountRequestRepo.save(
      this.accountRequestRepo.create({
        payload,
        passwordHash: prepared.passwordHash,
        teacherId: null,
        name: dto.name,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        requestedBy,
        status: TeacherAccountRequestStatus.PENDING,
        reviewedBy: null,
        reviewNote: null,
        reviewedAt: null,
        createdTeacherId: null,
      }),
    );

    await this.notifyAccountRequest(saved);

    return {
      status: TeacherAccountRequestStatus.PENDING,
      requiresApproval: true,
      requestId: saved.id,
      message:
        'Đã gửi Nhân sự duyệt. Tài khoản chỉ được tạo sau khi Nhân sự xác nhận.',
    };
  }

  /**
   * Cấp tài khoản đăng nhập cho một hồ sơ giáo viên **đã có sẵn** (giáo viên
   * nhập từ thời chưa có tài khoản). Nhân sự gọi là có ngay.
   */
  async createAccountForTeacher(teacherId: number, dto: UpdateTeacherDto) {
    const teacher = await this.getEntity(teacherId);
    const passwordHash = await this.hashNewAccountPassword(dto.password);

    await this.dataSource.transaction((manager) =>
      this.attachAccount(manager, {
        teacherId: teacher.id,
        name: dto.name ?? teacher.name,
        phone: dto.phone ?? teacher.phone,
        email: dto.email ?? teacher.email,
        teacherRole: dto.teacherRole,
        passwordHash,
      }),
    );

    // Có tài khoản giáo viên công ty rồi mới được trả phụ cấp xăng.
    await this.recomputeGasAllowances(teacher.id);
    return this.findOne(teacher.id);
  }

  /** Giáo vụ đề nghị cấp tài khoản cho hồ sơ giáo viên đã có sẵn. */
  async requestAccountForTeacher(
    teacherId: number,
    dto: UpdateTeacherDto,
    requestedBy: number,
  ) {
    const teacher = await this.getEntity(teacherId);
    const name = dto.name ?? teacher.name;
    const phone = dto.phone ?? teacher.phone;
    const email = dto.email ?? teacher.email;

    await this.assertAccountAttachable(teacher, phone, email);
    await this.assertNoPendingAccountRequest(phone, email);

    const saved = await this.accountRequestRepo.save(
      this.accountRequestRepo.create({
        payload: { name, phone, email, teacherRole: dto.teacherRole },
        passwordHash: await this.hashNewAccountPassword(dto.password),
        teacherId: teacher.id,
        name: name ?? '',
        phone: phone ?? null,
        email: email ?? null,
        requestedBy,
        status: TeacherAccountRequestStatus.PENDING,
        reviewedBy: null,
        reviewNote: null,
        reviewedAt: null,
        createdTeacherId: null,
      }),
    );

    await this.notifyAccountRequest(saved);

    return {
      status: TeacherAccountRequestStatus.PENDING,
      requiresApproval: true,
      requestId: saved.id,
      message:
        'Đã gửi Nhân sự duyệt. Tài khoản chỉ được tạo sau khi Nhân sự xác nhận.',
    };
  }

  /**
   * Tạo tài khoản `employee` rồi gắn vào hồ sơ giáo viên có sẵn.
   *
   * Cố ý **không** dùng lại `prepareCreate`: hàm đó soát trùng số điện thoại
   * trên bảng `teachers`, mà ở đây chính hồ sơ đang được cấp tài khoản đã giữ
   * số đó — soát kiểu ấy thì không bao giờ cấp được.
   */
  private async attachAccount(
    manager: EntityManager,
    input: {
      teacherId: number;
      name?: string | null;
      phone?: string | null;
      email?: string | null;
      teacherRole?: string;
      passwordHash: string;
    },
  ): Promise<number> {
    const teachers = manager.getRepository(Teacher);
    const employees = manager.getRepository(Employee);

    const teacher = await teachers.findOne({
      where: { id: input.teacherId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!teacher) throw new NotFoundException('Giáo viên không tồn tại');
    await this.assertAccountAttachable(teacher, input.phone, input.email);

    const employee = await employees.save(
      employees.create({
        name: input.name ?? teacher.name,
        phone: input.phone ?? undefined,
        email: input.email ?? undefined,
        password: input.passwordHash,
        roles: [input.teacherRole ?? TEACHER_STAFF_ROLE],
        department: { id: 1 },
      }),
    );

    teacher.employeeId = employee.id ?? null;
    await teachers.save(teacher);

    return teacher.id;
  }

  /** Chuỗi rỗng vẫn băm ra một hash hợp lệ, nên chặn thẳng thay vì để lọt. */
  private hashNewAccountPassword(password?: string): Promise<string> {
    if (!password?.trim()) {
      throw new BadRequestException('Cần mật khẩu để tạo tài khoản đăng nhập');
    }
    return bcrypt.hash(password, 10);
  }

  private async assertAccountAttachable(
    teacher: Teacher,
    phone?: string | null,
    email?: string | null,
  ) {
    if (teacher.employeeId) {
      throw new ConflictException('Giáo viên này đã có tài khoản đăng nhập');
    }
    if (!phone) {
      throw new BadRequestException(
        'Cần số điện thoại để tạo tài khoản đăng nhập',
      );
    }

    const [byPhone, byEmail] = await Promise.all([
      this.employeeRepo.findOne({ where: { phone } }),
      email
        ? this.employeeRepo.findOne({ where: { email } })
        : Promise.resolve(null),
    ]);
    if (byPhone) throw new ConflictException('Số điện thoại đã được sử dụng');
    if (byEmail) throw new ConflictException('Email đã được sử dụng');
  }

  /** Nhân sự thấy tất cả; Giáo vụ chỉ thấy đề nghị do chính mình gửi. */
  async findAccountRequests(
    query: QueryTeacherAccountRequestsDto,
    viewerId: number,
    canApprove: boolean,
  ) {
    const where: Record<string, unknown> = {
      status: query.status ?? TeacherAccountRequestStatus.PENDING,
    };
    // Người không có quyền duyệt không được xem hồ sơ của người khác, kể cả
    // khi tự truyền `requestedBy` của người đó lên.
    if (!canApprove) where.requestedBy = viewerId;
    else if (query.requestedBy) where.requestedBy = query.requestedBy;

    const rows = await this.accountRequestRepo.find({
      where,
      relations: ['requester', 'reviewer'],
      order: { createdAt: 'ASC' },
    });

    return rows.map((row) => this.toAccountRequestItem(row));
  }

  async findAccountRequest(id: number, viewerId: number, canApprove: boolean) {
    const row = await this.accountRequestRepo.findOne({
      where: { id },
      relations: ['requester', 'reviewer'],
    });
    if (!row || (!canApprove && row.requestedBy !== viewerId)) {
      throw new NotFoundException(
        'Đề nghị mở tài khoản giáo viên không tồn tại',
      );
    }
    return this.toAccountRequestItem(row);
  }

  /**
   * Nhân sự duyệt/từ chối. Việc tạo giáo viên và việc đóng hồ sơ nằm chung một
   * transaction: nếu số điện thoại đã bị chiếm trong lúc chờ, cả hai cùng huỷ
   * và hồ sơ vẫn ở trạng thái chờ để Nhân sự xử lý lại, thay vì bị đánh dấu
   * "đã duyệt" mà chẳng có tài khoản nào.
   */
  async reviewAccountRequest(
    id: number,
    reviewerId: number,
    approved: boolean,
    dto: ReviewTeacherAccountRequestDto,
  ) {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const requests = manager.getRepository(TeacherAccountRequest);
      const request = await requests.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) {
        throw new NotFoundException(
          'Đề nghị mở tài khoản giáo viên không tồn tại',
        );
      }
      if (request.status !== TeacherAccountRequestStatus.PENDING) {
        throw new ConflictException('Đề nghị này đã được xử lý');
      }

      let teacherId: number | null = null;
      if (approved && request.teacherId) {
        teacherId = await this.attachAccount(manager, {
          teacherId: request.teacherId,
          name: request.name,
          phone: request.phone,
          email: request.email,
          teacherRole: (request.payload as CreateTeacherDto).teacherRole,
          passwordHash: request.passwordHash ?? '',
        });
      } else if (approved) {
        const prepared = await this.prepareCreate(
          request.payload as CreateTeacherDto,
          request.passwordHash,
        );
        teacherId = await this.runCreate(prepared, manager);
      }

      request.status = approved
        ? TeacherAccountRequestStatus.APPROVED
        : TeacherAccountRequestStatus.REJECTED;
      request.reviewedBy = reviewerId;
      request.reviewNote = dto.note || null;
      request.reviewedAt = new Date();
      request.createdTeacherId = teacherId;
      await requests.save(request);

      return { request, teacherId };
    });

    if (outcome.teacherId) await this.recomputeGasAllowances(outcome.teacherId);
    await this.notifyAccountResult(outcome.request, approved, dto.note);

    return {
      id: outcome.request.id,
      status: outcome.request.status,
      teacherId: outcome.teacherId,
      teacher: outcome.teacherId ? await this.findOne(outcome.teacherId) : null,
    };
  }

  /** Chặn hai Giáo vụ cùng gửi một người, để Nhân sự không phải đoán bản nào thật. */
  private async assertNoPendingAccountRequest(
    phone?: string | null,
    email?: string | null,
  ) {
    const duplicates = await this.accountRequestRepo.find({
      where: [
        ...(phone
          ? [{ phone, status: TeacherAccountRequestStatus.PENDING }]
          : []),
        ...(email
          ? [{ email, status: TeacherAccountRequestStatus.PENDING }]
          : []),
      ],
    });

    if (duplicates.length) {
      throw new ConflictException(
        'Đã có một đề nghị mở tài khoản cho số điện thoại/email này đang chờ Nhân sự duyệt',
      );
    }
  }

  private toAccountRequestItem(row: TeacherAccountRequest) {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      /** Toàn bộ hồ sơ Giáo vụ đã khai — không bao giờ chứa mật khẩu. */
      payload: row.payload,
      /** Duyệt xong có tạo kèm tài khoản đăng nhập hay chỉ gắn tài khoản có sẵn. */
      createsLogin: Boolean(row.passwordHash),
      /** Có giá trị = cấp tài khoản cho hồ sơ giáo viên này, không tạo hồ sơ mới. */
      teacherId: row.teacherId,
      status: row.status,
      requestedBy: row.requestedBy,
      requesterName: row.requester?.name ?? null,
      reviewedBy: row.reviewedBy,
      reviewerName: row.reviewer?.name ?? null,
      reviewNote: row.reviewNote,
      reviewedAt: row.reviewedAt,
      createdTeacherId: row.createdTeacherId,
      createdAt: row.createdAt,
    };
  }

  /** Báo cho toàn bộ Nhân sự: có hồ sơ giáo viên đang chờ xác nhận. */
  private async notifyAccountRequest(
    request: TeacherAccountRequest,
  ): Promise<void> {
    try {
      const [approvers, requester] = await Promise.all([
        findTeacherAccountApprovers(this.employeeRepo),
        this.employeeRepo.findOne({ where: { id: request.requestedBy } }),
      ]);
      const receiverIds = [...new Set(approvers.map((item) => item.id))];
      if (!receiverIds.length) return;

      const message =
        `${requester?.name ?? 'Giáo vụ'} đề nghị mở tài khoản giáo viên cho ` +
        `${request.name}${request.phone ? ` (${request.phone})` : ''}. ` +
        'Tài khoản chỉ được tạo sau khi bạn xác nhận.';
      const meta = {
        kind: 'teacher_account_request',
        module: 'teaching',
        route: '/teaching/teachers/account-requests',
        url: '/teaching/teachers/account-requests',
        requestId: request.id,
        requestedBy: request.requestedBy,
      };

      await Promise.all(
        receiverIds.map((receiverId) =>
          this.notificationService.create({
            receiverId,
            senderId: request.requestedBy,
            type: NotificationType.TEACHER_ACCOUNT_REQUEST,
            message,
            entityId: request.id,
            meta,
          }),
        ),
      );

      const tokens = await this.employeeFcmTokenService.getTokens(receiverIds);
      if (tokens.length) {
        await this.fcmService.sendToMultiple(
          tokens.map((token) => token.token),
          'Đề nghị mở tài khoản giáo viên',
          message,
          {
            kind: meta.kind,
            module: meta.module,
            route: meta.route,
            url: meta.url,
            requestId: String(request.id),
          },
        );
      }
    } catch (error) {
      // Hồ sơ đã lưu không được rollback chỉ vì một kênh thông báo lỗi.
      this.logger.error(
        'Gửi thông báo đề nghị mở tài khoản giáo viên lỗi',
        error as any,
      );
    }
  }

  /** Báo lại cho đúng Giáo vụ đã gửi đề nghị. */
  private async notifyAccountResult(
    request: TeacherAccountRequest,
    approved: boolean,
    note?: string | null,
  ): Promise<void> {
    try {
      const message = approved
        ? `Nhân sự đã duyệt mở tài khoản giáo viên cho ${request.name}. Tài khoản đã được tạo.`
        : `Nhân sự đã từ chối mở tài khoản giáo viên cho ${request.name}.${note ? ` Lý do: ${note}` : ''}`;
      const meta = {
        kind: 'teacher_account_result',
        module: 'teaching',
        route: '/teaching/teachers',
        url: '/teaching/teachers',
        requestId: request.id,
        teacherId: request.createdTeacherId,
        approved,
      };

      await this.notificationService.create({
        receiverId: request.requestedBy,
        senderId: request.reviewedBy ?? undefined,
        type: NotificationType.TEACHER_ACCOUNT_RESULT,
        message,
        entityId: request.id,
        meta,
      });

      const tokens = await this.employeeFcmTokenService.getTokens([
        request.requestedBy,
      ]);
      if (tokens.length) {
        await this.fcmService.sendToMultiple(
          tokens.map((token) => token.token),
          approved
            ? '✅ Tài khoản giáo viên đã được duyệt'
            : '❌ Đề nghị mở tài khoản bị từ chối',
          message,
          {
            kind: meta.kind,
            module: meta.module,
            route: meta.route,
            url: meta.url,
            requestId: String(request.id),
          },
        );
      }
    } catch (error) {
      this.logger.error(
        'Gửi thông báo kết quả duyệt tài khoản giáo viên lỗi',
        error as any,
      );
    }
  }

  private async getEntity(id: number): Promise<Teacher> {
    const teacher = await this.teacherRepo.findOne({ where: { id } });

    if (!teacher) {
      throw new NotFoundException('Giáo viên không tồn tại');
    }

    return teacher;
  }

  private buildTeacherQuery() {
    return this.teacherRepo
      .createQueryBuilder('t')
      .leftJoin('t.employee', 'e')
      .select([
        't.id AS "id"',
        't.name AS "name"',
        't.phone AS "phone"',
        't.email AS "email"',
        't.employee_id AS "employeeId"',
        'e.name AS "employeeName"',
        `${TEACHER_ROLE_SQL} AS "teacherRole"`,
        't.is_active AS "isActive"',
        't.note AS "note"',
        't.maxPeriodsPerWeek AS "maxPeriodsPerWeek"',
        't.defaultRatePerPeriod AS "defaultRatePerPeriod"',
        't.google_maps_url AS "googleMapsUrl"',
        't.zalo_uid AS "zaloUid"',
        't.zalo_user_id AS "zaloUserId"',
        't.avatar_url AS "avatarUrl"',
        't.latitude AS "latitude"',
        't.longitude AS "longitude"',
        't.updated_at AS "updatedAt"',
      ]);
  }

  private toProfile(row: Record<string, any>) {
    return {
      id: Number(row.id),
      name: row.name,
      phone: row.phone ?? null,
      email: row.email ?? null,
      avatarUrl: this.avatarStorage.publicUrl(row.avatarUrl),
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      defaultRatePerPeriod:
        row.defaultRatePerPeriod === null
          ? null
          : Number(row.defaultRatePerPeriod),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private toTeacherItem(
    row: Record<string, any>,
    preferenceMap = new Map<
      number,
      {
        wards: Array<{ id: number; name: string }>;
        schools: Array<{ id: number; name: string }>;
        subjectCatalogs: Array<{
          id: number;
          name: string;
          code: string | null;
        }>;
      }
    >(),
  ) {
    const preferences = preferenceMap.get(Number(row.id)) ?? {
      wards: [],
      schools: [],
      subjectCatalogs: [],
    };
    return {
      id: Number(row.id),
      name: row.name,
      phone: row.phone ?? null,
      email: row.email ?? null,
      employeeId: row.employeeId === null ? null : Number(row.employeeId),
      employeeName: row.employeeName ?? null,
      /** null chỉ xảy ra với hồ sơ cũ/thuê ngoài chưa gắn tài khoản. */
      teacherRole: row.teacherRole ?? null,
      isActive: row.isActive,
      note: row.note ?? null,
      googleMapsUrl: row.googleMapsUrl ?? null,
      zaloUid: row.zaloUid ?? null,
      zaloUserId: row.zaloUserId ?? null,
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      wardIds: preferences.wards.map((ward) => ward.id),
      allowedWards: preferences.wards,
      // Suy ra động từ các xã/phường đã gán — không phải danh sách chốt cứng,
      // trường thêm/xoá khỏi xã/phường sau này tự đổi theo mà không cần sửa
      // hồ sơ giáo viên. Giữ 2 field này để không phải sửa lại các chỗ đang
      // dùng (gợi ý lịch dạy, FE hiển thị) vốn kiểm tra theo trường.
      schoolIds: preferences.schools.map((school) => school.id),
      allowedSchools: preferences.schools,
      subjectCatalogIds: preferences.subjectCatalogs.map(
        (subject) => subject.id,
      ),
      teachableSubjects: preferences.subjectCatalogs,
      maxPeriodsPerWeek:
        row.maxPeriodsPerWeek === null ? null : Number(row.maxPeriodsPerWeek),
      defaultRatePerPeriod:
        row.defaultRatePerPeriod === null
          ? null
          : Number(row.defaultRatePerPeriod),
    };
  }

  /** Gộp trường của nhiều xã/phường, loại trùng (1 trường không thuộc 2 xã/phường trong thực tế nhưng vẫn phòng hờ). */
  private schoolsOfWards(wards: Ward[]): Array<{ id: number; name: string }> {
    const byId = new Map<number, { id: number; name: string }>();
    wards.forEach((ward) => {
      (ward.schools ?? []).forEach((school) => {
        byId.set(school.id, { id: school.id, name: school.name });
      });
    });
    return [...byId.values()];
  }

  private async resolvePreferences(
    wardIds?: number[],
    subjectCatalogIds?: number[],
  ) {
    const [wards, subjectCatalogs] = await Promise.all([
      wardIds?.length
        ? this.wardRepo.find({
            where: { id: In(wardIds) },
            relations: ['schools'],
          })
        : Promise.resolve([]),
      subjectCatalogIds?.length
        ? this.subjectCatalogRepo.find({ where: { id: In(subjectCatalogIds) } })
        : Promise.resolve([]),
    ]);

    if (wardIds && wards.length !== wardIds.length) {
      const foundIds = new Set(wards.map((ward) => ward.id));
      const missing = wardIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Xã/phường không tồn tại: ${missing.join(', ')}`,
      );
    }
    if (
      subjectCatalogIds &&
      subjectCatalogs.length !== subjectCatalogIds.length
    ) {
      const foundIds = new Set(subjectCatalogs.map((subject) => subject.id));
      const missing = subjectCatalogIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Môn học trong danh mục không tồn tại: ${missing.join(', ')}`,
      );
    }

    return { wards, subjectCatalogs };
  }

  private async loadPreferenceMap(teacherIds: number[]) {
    const result = new Map<
      number,
      {
        wards: Array<{ id: number; name: string }>;
        schools: Array<{ id: number; name: string }>;
        subjectCatalogs: Array<{
          id: number;
          name: string;
          code: string | null;
        }>;
      }
    >();
    if (!teacherIds.length) return result;

    const teachers = await this.teacherRepo.find({
      where: { id: In(teacherIds) },
      relations: [
        'allowedWards',
        'allowedWards.schools',
        'teachableSubjectCatalogs',
      ],
    });

    teachers.forEach((teacher) => {
      const wards = teacher.allowedWards ?? [];
      result.set(teacher.id, {
        wards: wards
          .map((ward) => ({ id: ward.id, name: ward.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'vi')),
        schools: this.schoolsOfWards(wards).sort((a, b) =>
          a.name.localeCompare(b.name, 'vi'),
        ),
        subjectCatalogs: (teacher.teachableSubjectCatalogs ?? [])
          .map((subject) => ({
            id: subject.id,
            name: subject.name,
            code: subject.code ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'vi')),
      });
    });
    return result;
  }

  private async assertPhoneAvailable(phone?: string | null, exceptId?: number) {
    if (!phone) return;

    const existed = await this.teacherRepo.findOne({
      where: exceptId ? { phone, id: Not(exceptId) } : { phone },
    });

    if (existed) {
      throw new ConflictException(
        `Số điện thoại ${phone} đã dùng cho giáo viên khác`,
      );
    }
  }

  private async assertEmailAvailable(email?: string | null, exceptId?: number) {
    if (!email) return;
    const existed = await this.teacherRepo.findOne({
      where: exceptId ? { email, id: Not(exceptId) } : { email },
    });
    if (existed) {
      throw new ConflictException(`Email ${email} đã dùng cho giáo viên khác`);
    }
  }

  private async assertZaloUidAvailable(
    zaloUid?: string | null,
    exceptId?: number,
  ) {
    if (!zaloUid) return;
    const existed = await this.teacherRepo.findOne({
      where: exceptId ? { zaloUid, id: Not(exceptId) } : { zaloUid },
    });
    if (existed) {
      throw new ConflictException(
        `Zalo UID ${zaloUid} đã dùng cho giáo viên khác`,
      );
    }
  }

  private async assertZaloUserIdAvailable(
    zaloUserId?: string | null,
    exceptId?: number,
  ) {
    if (!zaloUserId) return;
    const existed = await this.teacherRepo.findOne({
      where: exceptId ? { zaloUserId, id: Not(exceptId) } : { zaloUserId },
    });
    if (existed) {
      throw new ConflictException(
        `Zalo User ID ${zaloUserId} đã dùng cho giáo viên khác`,
      );
    }
  }

  private async assertEmployeeLinkable(
    employeeId?: number | null,
    exceptTeacherId?: number,
  ) {
    if (!employeeId) return;

    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new BadRequestException('Tài khoản nhân viên không tồn tại');
    }

    if (!employee.roles?.some((r) => TEACHER_ROLES.includes(r))) {
      throw new BadRequestException(
        `Tài khoản này chưa có role giáo viên (${TEACHER_ROLES.join(' hoặc ')}), không gắn làm giáo viên được`,
      );
    }

    const linked = await this.teacherRepo.findOne({
      where: exceptTeacherId
        ? { employeeId, id: Not(exceptTeacherId) }
        : { employeeId },
    });

    if (linked) {
      throw new ConflictException(
        `Tài khoản này đã gắn với giáo viên "${linked.name}"`,
      );
    }
  }

  /**
   * Đổi giáo viên công ty <-> cộng tác viên cho tài khoản đã gắn — giữ nguyên
   * mọi role khác tài khoản đang có (VD kiêm nhiệm nhansu), chỉ thay đúng
   * role giáo viên cũ bằng role mới.
   */
  private async changeTeacherRole(employeeId: number, newRole: string) {
    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId },
    });
    if (!employee) return;

    const otherRoles = (employee.roles ?? []).filter(
      (r) => !TEACHER_ROLES.includes(r),
    );
    employee.roles = [...otherRoles, newRole];
    await this.employeeRepo.save(employee);
  }

  /**
   * Giải toạ độ từ link Google Maps của giáo viên, tái dùng bộ giải của
   * `SchoolsService` (đã chặn SSRF: chỉ https, allowlist host, tối đa 5 redirect,
   * timeout 5s) thay vì nhân bản đoạn code nhạy cảm đó.
   *
   * **Link hỏng không chặn việc lưu hồ sơ.** Nhân sự đang tạo giáo viên, không
   * phải đang khai vị trí; bắt họ sửa link mới lưu được tên và số điện thoại là
   * vô lý. Giải không ra thì để toạ độ null, và khi xếp lịch sẽ báo thẳng "chưa
   * có vị trí giáo viên" chứ không coi như ở xa.
   */
  private async resolveTeacherCoordinates(
    url?: string | null,
  ): Promise<{ latitude: number | null; longitude: number | null }> {
    if (!url?.trim()) return { latitude: null, longitude: null };

    try {
      const { latitude, longitude } =
        await this.schoolsService.resolveGoogleMaps(url.trim());
      return { latitude, longitude };
    } catch {
      return { latitude: null, longitude: null };
    }
  }
}
