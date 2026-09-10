import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';
import { TeachingSchedule } from './entities/teaching-schedule.entity';
import { TeachingSession } from './entities/teaching-session.entity';
import { Teacher } from './entities/teacher.entity';
import { Employee } from '../employee/employee.entity';
import { Subject } from '../subject/subject.entity';
import { SchoolClassService } from './school-class.service';
import {
  ConfirmTeachingScheduleDto,
  CreateTeachingScheduleDto,
  GenerateSessionsDto,
  QueryTeachingSchedulesDto,
  RemoveSchedulesBySchoolDto,
  UpdateTeachingScheduleDto,
} from './dto/teaching-schedule.dto';
import {
  ACTIVE_SESSION_STATUSES,
  AssignmentStatus,
  ConfirmationStatus,
  DAY_OF_WEEK_LABELS,
  SessionStatus,
} from './teaching.enum';
import { TeachingScope } from './teaching-roles';
import { findTeachingManagers } from './teaching-managers.util';
import {
  addDays,
  assertDateOrder,
  assertTimeOrder,
  dayOfWeekOf,
  listDatesForDayOfWeek,
  nullableNumber,
  toDateString,
  toDbTime,
  toDisplayTime,
} from './teaching.util';
import { NotificationService } from '../notifications/services/notification.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import { FcmService } from '../fcm/fcm.service';
import { EmployeeFcmTokenService } from '../employee-fcm-token/employee-fcm-token.service';
import {
  TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE,
  TEACHING_SCHEDULE_CONFIRM_MANAGER_URL,
  TEACHING_SCHEDULE_CONFIRM_REQUEST_KIND,
  TEACHING_SCHEDULE_CONFIRM_REQUEST_TITLE,
  TEACHING_SCHEDULE_CONFIRM_RESULT_KIND,
  TEACHING_SCHEDULE_CONFIRM_RESULT_TITLE,
  TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE,
  TEACHING_SCHEDULE_CONFIRM_TEACHER_URL,
} from '../notifications/constants/teaching-schedule-confirmation.constant';
import { TEACHING_MODULE } from '../notifications/constants/teaching-schedule.constant';
import { FuelAllowanceTierService } from './fuel-allowance-tier.service';
import { effectiveRatePerPeriod } from './teaching-rate.util';

const MAX_LIMIT = 100;

/** Chặn sinh buổi cho khoảng ngày quá dài (1 mẫu × 2 năm ≈ 104 buổi). */
const MAX_GENERATE_DAYS = 400;

/**
 * Kết quả đẩy thay đổi của mẫu lịch xuống màn Chấm công.
 *
 * Trả thẳng trong response của `PATCH /teaching-schedules/:id`: Giáo vụ cần
 * thấy ngay có bao nhiêu buổi bị dời và **bao nhiêu buổi không đụng được** vì
 * đã chấm công — đó là phần họ phải tự xử lý.
 */
export interface ScheduleSessionSync {
  /** Buổi được cập nhật tại chỗ (giờ, môn, lớp, số tiết, giáo viên). */
  updated: number;
  /** Buổi bị xoá vì rơi sai thứ hoặc ra ngoài khoảng hiệu lực mới. */
  removed: number;
  /** Buổi sinh lại ở ngày mới. */
  created: number;
  /** Buổi đã chấm công nên giữ nguyên — Giáo vụ phải xử lý tay. */
  skipped: number;
}

@Injectable()
export class TeachingScheduleService {
  private readonly logger = new Logger(TeachingScheduleService.name);

  constructor(
    @InjectRepository(TeachingSchedule)
    private readonly scheduleRepo: Repository<TeachingSchedule>,

    @InjectRepository(TeachingSession)
    private readonly sessionRepo: Repository<TeachingSession>,

    @InjectRepository(Teacher)
    private readonly teacherRepo: Repository<Teacher>,

    @InjectRepository(Subject)
    private readonly subjectRepo: Repository<Subject>,

    private readonly classService: SchoolClassService,

    private readonly dataSource: DataSource,

    // Đặt cuối danh sách: test dựng service bằng tham số vị trí, chèn vào
    // giữa là đẩy lệch mọi dependency phía sau (cùng quy ước với
    // TeachingSessionService).
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    private readonly notificationService: NotificationService,
    private readonly fcmService: FcmService,
    private readonly employeeFcmTokenService: EmployeeFcmTokenService,
    private readonly fuelAllowanceTierService: FuelAllowanceTierService,
  ) {}

  async create(dto: CreateTeachingScheduleDto) {
    assertTimeOrder(dto.startTime, dto.endTime);
    assertDateOrder(dto.effectiveFrom, dto.effectiveTo);

    // Trường suy ra từ lớp — Nhân sự chọn lớp, không chọn trường nữa.
    const schoolClass = await this.classService.resolveForScheduling(
      dto.classId,
      dto.schoolId,
    );
    const schoolId = schoolClass.schoolId;
    const schoolLocationId = schoolClass.schoolLocationId ?? null;

    const teacher = await this.assertTeacherActive(dto.teacherId);
    await this.assertSubjectBelongsToSchool(dto.subjectId, schoolId);
    await this.assertNoScheduleConflict(dto);
    await this.assertNoClassConflict(dto);

    const schedule = this.scheduleRepo.create({
      teacherId: dto.teacherId,
      schoolId,
      schoolLocationId,
      classId: dto.classId,
      subjectId: dto.subjectId,
      dayOfWeek: dto.dayOfWeek,
      startTime: toDbTime(dto.startTime),
      endTime: toDbTime(dto.endTime),
      periods: dto.periods ?? 1,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo ?? null,
      isActive: dto.isActive ?? true,
      note: dto.note ?? null,
    });

    const saved = await this.scheduleRepo.save(schedule);
    await this.notifyConfirmationRequest(saved, teacher);
    // Trả cùng shape với GET (giờ dạng "07:30", kèm tên trường/môn/giáo viên).
    return this.findOne(saved.id);
  }

  /**
   * `scope` chỉ dùng để **thu hẹp** kết quả, không bao giờ mở rộng: kinh doanh
   * (`own-schools`) chỉ thấy lịch của trường mình phụ trách và bị ẩn đơn giá.
   */
  async findAll(query: QueryTeachingSchedulesDto, scope?: TeachingScope) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, MAX_LIMIT);

    const qb = this.buildScheduleQuery();

    if (scope?.kind === 'own-schools') {
      qb.andWhere(
        's.schoolId IN (SELECT id FROM schools WHERE employee_id = :ownerId)',
        { ownerId: scope.employeeId },
      );
    }

    if (query.teacherId) {
      qb.andWhere('s.teacherId = :teacherId', {
        teacherId: query.teacherId,
      });
    }
    if (query.schoolId) {
      qb.andWhere('s.schoolId = :schoolId', { schoolId: query.schoolId });
    }
    if (query.provinceId) {
      // Khu vực là của trường → xã/phường → tỉnh; mẫu lịch không tự giữ.
      qb.leftJoin('sc.ward', 'wd').andWhere('wd.province_id = :provinceId', {
        provinceId: query.provinceId,
      });
    }
    if (query.schoolLocationId) {
      qb.andWhere('s.schoolLocationId = :schoolLocationId', {
        schoolLocationId: query.schoolLocationId,
      });
    }
    if (query.classId) {
      qb.andWhere('s.classId = :classId', { classId: query.classId });
    }
    if (query.subjectId) {
      qb.andWhere('s.subjectId = :subjectId', {
        subjectId: query.subjectId,
      });
    }
    if (query.dayOfWeek) {
      qb.andWhere('s.dayOfWeek = :dayOfWeek', {
        dayOfWeek: query.dayOfWeek,
      });
    }
    if (query.isActive !== undefined) {
      qb.andWhere('s.isActive = :isActive', { isActive: query.isActive });
    }
    if (query.confirmationStatus) {
      qb.andWhere('s.confirmationStatus = :confirmationStatus', {
        confirmationStatus: query.confirmationStatus,
      });
    }

    const total = await qb.getCount();

    const rows = await qb
      .orderBy('s.dayOfWeek', 'ASC')
      .addOrderBy('s.startTime', 'ASC')
      .addOrderBy('s.id', 'ASC')
      .limit(limit)
      .offset((page - 1) * limit)
      .getRawMany();

    const hideRate = scope?.kind === 'own-schools';

    return {
      data: rows.map((row) => {
        const item = this.toScheduleItem(row);
        if (!hideRate) return item;
        // Đơn giá tiết là dữ liệu tiền công của giáo viên — kinh doanh
        // xem TKB thì không cần và không được thấy.
        const { subjectRatePerPeriod: _rate, ...rest } = item;
        return rest;
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /** Mẫu lịch tuần của chính giáo viên đang đăng nhập. */
  async findMine(employeeId: number, query: QueryTeachingSchedulesDto) {
    const teacher = await this.teacherRepo.findOne({
      where: { employeeId },
    });

    if (!teacher) {
      throw new NotFoundException(
        'Tài khoản này chưa được gắn với hồ sơ giáo viên nào',
      );
    }

    // 🔒 teacherId lấy từ token, bỏ qua teacherId FE gửi lên.
    return this.findAll({ ...query, teacherId: teacher.id });
  }

  async findOne(id: number) {
    const row = await this.buildScheduleQuery()
      .andWhere('s.id = :id', { id })
      .getRawOne();

    if (!row) {
      throw new NotFoundException('Lịch dạy không tồn tại');
    }

    return this.toScheduleItem(row);
  }

  async update(id: number, dto: UpdateTeachingScheduleDto) {
    const schedule = await this.getEntity(id);

    // Chốt giá trị cũ trước khi `Object.assign` ghi đè — cần để biết buổi đã
    // sinh còn rơi đúng thứ/khoảng hiệu lực nữa không.
    const before = {
      dayOfWeek: schedule.dayOfWeek,
      effectiveFrom: toDateString(schedule.effectiveFrom) as string,
      effectiveTo: toDateString(schedule.effectiveTo),
    };

    // Đổi lớp thì trường đổi theo; giữ nguyên lớp cũ (kể cả null) nếu không gửi classId.
    const classId = dto.classId ?? schedule.classId ?? null;
    const schoolClass = dto.classId
      ? await this.classService.resolveForScheduling(dto.classId, dto.schoolId)
      : null;

    const merged = {
      teacherId: dto.teacherId ?? schedule.teacherId,
      schoolId: schoolClass?.schoolId ?? dto.schoolId ?? schedule.schoolId,
      // Điểm trường thuộc về lớp. Khi chuyển lớp trong cùng một trường phải
      // cập nhật cả cơ sở, nếu không mẫu lịch và các buổi dạy sẽ trỏ hai nơi
      // khác nhau.
      schoolLocationId:
        schoolClass?.schoolLocationId ?? schedule.schoolLocationId ?? null,
      classId,
      subjectId: dto.subjectId ?? schedule.subjectId,
      dayOfWeek: dto.dayOfWeek ?? schedule.dayOfWeek,
      startTime: dto.startTime ?? schedule.startTime,
      endTime: dto.endTime ?? schedule.endTime,
      effectiveFrom:
        dto.effectiveFrom ?? (toDateString(schedule.effectiveFrom) as string),
      effectiveTo:
        dto.effectiveTo !== undefined
          ? dto.effectiveTo
          : toDateString(schedule.effectiveTo),
    };

    assertTimeOrder(merged.startTime, merged.endTime);
    assertDateOrder(merged.effectiveFrom, merged.effectiveTo);

    // Đổi sang giáo viên khác (không phải sửa nhẹ ngày/giờ) là giao lịch mới
    // trên thực tế — phải xác nhận lại từ đầu.
    const teacherChanged =
      dto.teacherId !== undefined && dto.teacherId !== schedule.teacherId;
    let newTeacher: Teacher | null = null;

    if (dto.teacherId !== undefined) {
      newTeacher = await this.assertTeacherActive(merged.teacherId);
    }

    if (
      dto.subjectId !== undefined ||
      dto.schoolId !== undefined ||
      dto.classId !== undefined
    ) {
      await this.assertSubjectBelongsToSchool(
        merged.subjectId,
        merged.schoolId,
      );
    }

    await this.assertNoScheduleConflict(merged, id);
    await this.assertNoClassConflict(merged, id);

    Object.assign(schedule, {
      ...merged,
      startTime: toDbTime(merged.startTime),
      endTime: toDbTime(merged.endTime),
      effectiveTo: merged.effectiveTo ?? null,
    });

    if (dto.isActive !== undefined) schedule.isActive = dto.isActive;
    if (dto.note !== undefined) schedule.note = dto.note ?? null;
    if (dto.periods !== undefined) schedule.periods = dto.periods;

    if (teacherChanged) {
      schedule.confirmationStatus = ConfirmationStatus.PENDING;
      schedule.confirmedAt = null;
      schedule.rejectionReason = null;
      schedule.confirmationAlertAt = null;
    }

    const saved = await this.scheduleRepo.save(schedule);

    const sessionSync = await this.syncSessionsToSchedule(
      saved,
      before,
      teacherChanged ? newTeacher : null,
    );

    if (teacherChanged && newTeacher) {
      await this.notifyConfirmationRequest(saved, newTeacher);
    }

    return { ...(await this.findOne(id)), sessionSync };
  }

  /**
   * Đẩy mọi thay đổi của mẫu lịch xuống các buổi đã sinh (màn Chấm công).
   *
   * Trước đây chỉ đồng bộ khi đổi giáo viên, nên sửa giờ/thứ/môn/lớp là mẫu
   * lịch một đằng, chấm công một nẻo: giáo viên mới bấm check-in thì bị chặn
   * vì buổi vẫn đứng tên người cũ, còn đổi thứ thì buổi nằm ở ngày cũ nên
   * không ai check-in được ngày nào cả (check-in chỉ cho phép trong ngày dạy).
   *
   * Buổi đã có dấu vết chấm công thì **không bao giờ** đụng tới — trả về số
   * lượng trong `skipped` để Giáo vụ tự xử lý riêng.
   */
  private async syncSessionsToSchedule(
    schedule: TeachingSchedule,
    before: {
      dayOfWeek: number;
      effectiveFrom: string;
      effectiveTo: string | null;
    },
    newTeacher: Teacher | null,
  ): Promise<ScheduleSessionSync> {
    const sessions = await this.sessionRepo.find({
      where: { scheduleId: schedule.id },
    });

    // Buổi đã qua ngày là lịch sử, không phải phân công sắp tới: người dạy hôm
    // đó là người đã đứng lớp thật, đổi tên trên bảng công thành người mới là
    // ghi sai công. Chỉ đồng bộ từ hôm nay trở đi.
    const today = this.todayDateString();
    const upcoming = sessions.filter(
      (session) => (toDateString(session.date) as string) >= today,
    );

    const locked = upcoming.filter((session) =>
      this.isAttendanceLocked(session),
    );
    const editable = upcoming.filter(
      (session) => !this.isAttendanceLocked(session),
    );

    const effectiveFrom = toDateString(schedule.effectiveFrom) as string;
    const effectiveTo = toDateString(schedule.effectiveTo);

    // Buổi không còn hợp lệ sau khi sửa: rơi sai thứ, hoặc văng ra ngoài
    // khoảng hiệu lực vừa thu hẹp.
    const stale = editable.filter((session) => {
      const date = toDateString(session.date) as string;
      return (
        dayOfWeekOf(date) !== schedule.dayOfWeek ||
        date < effectiveFrom ||
        (effectiveTo !== null && date > effectiveTo)
      );
    });

    const fields: Partial<TeachingSession> = {
      schoolId: schedule.schoolId,
      schoolLocationId: schedule.schoolLocationId ?? null,
      classId: schedule.classId ?? null,
      subjectId: schedule.subjectId,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      periods: schedule.periods ?? 1,
    };

    // Đổi giáo viên là giao lịch mới trên thực tế: phải chốt lại đơn giá và
    // phụ cấp xăng của người mới, và bắt xác nhận lại từ đầu.
    if (newTeacher) {
      const { isCompanyTeacher, distanceToSchoolKm, gasAllowance } =
        await this.fuelAllowanceTierService.computeForTeacherSchool(
          newTeacher.id,
          schedule.schoolId,
          schedule.schoolLocationId,
        );
      Object.assign(fields, {
        teacherId: newTeacher.id,
        assignmentStatus: AssignmentStatus.ASSIGNED,
        recommendedTeacherId: newTeacher.id,
        declinedTeacherId: null,
        declinedAt: null,
        declineReason: null,
        ratePerPeriod: effectiveRatePerPeriod(newTeacher, isCompanyTeacher),
        distanceToSchoolKm,
        gasAllowance,
        confirmationStatus: ConfirmationStatus.PENDING,
        confirmedAt: null,
        rejectionReason: null,
      });
    }

    const staleIds = new Set(stale.map((session) => session.id));
    const keptIds = editable
      .filter((session) => !staleIds.has(session.id))
      .map((session) => session.id);

    if (keptIds.length) {
      await this.sessionRepo.update({ id: In(keptIds) }, fields);
    }
    if (staleIds.size) {
      await this.sessionRepo.delete({ id: In([...staleIds]) });
    }

    const created = await this.regenerateMovedSessions(
      schedule,
      sessions,
      before,
    );

    return {
      updated: keptIds.length,
      removed: staleIds.size,
      created,
      skipped: locked.length,
    };
  }

  /**
   * Sinh lại buổi cho đúng thứ mới, trong **đúng khoảng mà mẫu này đã từng
   * sinh** — không tự ý nới rộng ra cả năm học chỉ vì Giáo vụ sửa một chữ.
   *
   * Mẫu chưa sinh buổi nào thì không sinh gì cả: việc sinh buổi là thao tác có
   * chủ đích của Giáo vụ, sửa lịch không phải là lúc thay họ quyết định.
   */
  private async regenerateMovedSessions(
    schedule: TeachingSchedule,
    previous: TeachingSession[],
    before: {
      dayOfWeek: number;
      effectiveFrom: string;
      effectiveTo: string | null;
    },
  ): Promise<number> {
    const unchanged =
      before.dayOfWeek === schedule.dayOfWeek &&
      before.effectiveFrom === toDateString(schedule.effectiveFrom) &&
      before.effectiveTo === toDateString(schedule.effectiveTo);

    if (unchanged || !previous.length || !schedule.isActive) return 0;

    const dates = previous.map(
      (session) => toDateString(session.date) as string,
    );
    const earliest = dates.reduce((a, b) => (a < b ? a : b));
    const toDate = dates.reduce((a, b) => (a > b ? a : b));

    // Không sinh bù vào quá khứ: buổi đã qua mà chưa ai chấm thì để nguyên,
    // sinh thêm buổi cho một ngày đã trôi qua chỉ tạo ra công ma.
    const today = this.todayDateString();
    const fromDate = earliest > today ? earliest : today;

    if (fromDate > toDate) return 0;

    // `generateSessions` tự cắt theo khoảng hiệu lực mới, bỏ qua ngày đã có
    // buổi và né các ô lịch đã bị mẫu khác chiếm.
    const { created } = await this.generateSessions(schedule.id, {
      fromDate,
      toDate,
    } as GenerateSessionsDto);

    return created;
  }

  /** Hôm nay theo giờ địa phương, dạng `YYYY-MM-DD`. */
  private todayDateString(): string {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  }

  /**
   * Buổi đã đụng tới chấm công thì bất khả xâm phạm.
   *
   * `status` **không** đủ để nhận biết: check-in/check-out của giáo viên không
   * đổi `status`, chỉ Giáo vụ chấm công mới đổi. Xét mỗi `status` thì một buổi
   * giáo viên vừa check-in xong vẫn bị coi là chưa ai đụng và bị ghi đè.
   */
  private isAttendanceLocked(session: TeachingSession): boolean {
    return (
      session.status !== SessionStatus.SCHEDULED ||
      !!session.checkinAt ||
      !!session.checkoutAt ||
      !!session.lessonSubmittedAt
    );
  }

  /** Xoá một tiết khỏi thời khoá biểu. Xem `removeSchedules`. */
  async remove(id: number) {
    const schedule = await this.getEntity(id);
    return this.removeSchedules([schedule]);
  }

  /**
   * Xoá toàn bộ lịch của một trường, lọc thêm theo môn nếu có.
   *
   * Giáo vụ nhập nhầm cả thời khoá biểu của một trường thì việc xoá tay từng
   * tiết là hàng trăm lần bấm — và bấm tay thì kiểu gì cũng sót vài tiết, để
   * lại lịch rác không ai nhớ vì sao còn đó.
   *
   * Quy tắc giữ buổi cũ y hệt xoá một tiết: tiết đã qua ngày và tiết đã chấm
   * công không bao giờ bị đụng tới.
   */
  async removeBySchool(dto: RemoveSchedulesBySchoolDto) {
    const where: FindOptionsWhere<TeachingSchedule> = {
      schoolId: dto.schoolId,
    };
    if (dto.subjectId) where.subjectId = dto.subjectId;

    const schedules = await this.scheduleRepo.find({ where });

    if (!schedules.length) {
      // Không ném lỗi: "không có gì để xoá" là kết quả hợp lệ, không phải sự cố.
      return {
        deleted: true,
        deletedSchedules: 0,
        sessions: { kept: 0, removed: 0 },
      };
    }

    return this.removeSchedules(schedules);
  }

  /**
   * Xoá mẫu lịch khỏi thời khoá biểu, giữ nguyên phần đã thành lịch sử.
   *
   * Thời khoá biểu chỉ áp cho **hiện tại và tương lai**: xoá một tiết nghĩa là
   * "từ nay không dạy tiết này nữa", không phải "tiết này chưa từng tồn tại".
   * Buổi đã qua ngày là công đã dạy — có ảnh check-in, có báo giảng — nên phải
   * còn nguyên trên bảng chấm công sau khi mẫu lịch biến mất.
   *
   * Khoá ngoại `schedule_id` là `ON DELETE CASCADE`, nên phải **gỡ liên kết**
   * các buổi cần giữ trước khi xoá mẫu, nếu không chúng bị xoá theo. Cột này
   * vốn cho phép null (buổi lẻ, buổi dạy bù) và index unique là partial
   * `WHERE schedule_id IS NOT NULL`, nên gỡ ra là hợp lệ, không phải lách.
   *
   * Làm theo lô chứ không lặp từng mẫu: xoá cả thời khoá biểu của một trường
   * là hàng trăm mẫu và hàng nghìn buổi, chạy từng cái sẽ là hàng nghìn lượt
   * truy vấn trong một transaction.
   */
  private async removeSchedules(schedules: TeachingSchedule[]) {
    const today = this.todayDateString();
    const scheduleIds = schedules.map((schedule) => schedule.id);

    const sessions = await this.sessionRepo.find({
      where: { scheduleId: In(scheduleIds) },
    });

    // Giữ lại: buổi đã qua ngày, và buổi đã có dấu vết chấm công dù ở tương
    // lai (giáo viên đã check-in sáng nay thì công đó là thật).
    const keptIds: number[] = [];
    const removedIds: number[] = [];

    for (const session of sessions) {
      const past = (toDateString(session.date) as string) < today;
      (past || this.isAttendanceLocked(session) ? keptIds : removedIds).push(
        session.id,
      );
    }

    // Cả ba bước phải cùng thành công: gỡ liên kết xong mà xoá mẫu hỏng thì
    // buổi cũ mồ côi, còn xoá mẫu trước khi gỡ thì CASCADE cuốn sạch.
    await this.dataSource.transaction(async (manager) => {
      const sessionRepo = manager.getRepository(TeachingSession);

      if (keptIds.length) {
        await sessionRepo.update({ id: In(keptIds) }, { scheduleId: null });
      }
      if (removedIds.length) {
        await sessionRepo.delete({ id: In(removedIds) });
      }

      await manager.getRepository(TeachingSchedule).delete({
        id: In(scheduleIds),
      });
    });

    return {
      deleted: true,
      deletedSchedules: scheduleIds.length,
      sessions: { kept: keptIds.length, removed: removedIds.length },
    };
  }

  /**
   * Giáo viên xác nhận hoặc từ chối mẫu lịch được giao. Chỉ chính giáo viên
   * đứng tên mới gọi được, và chỉ khi còn PENDING — xử lý rồi thì không đổi
   * ý qua API này nữa (Giáo vụ/Nhân sự phải sửa lịch nếu cần giao lại).
   */
  async confirm(
    id: number,
    employeeId: number,
    dto: ConfirmTeachingScheduleDto,
  ) {
    if (dto.status === ConfirmationStatus.REJECTED && !dto.reason?.trim()) {
      throw new BadRequestException('Vui lòng nhập lý do từ chối');
    }

    // Khoá đúng dòng lịch: hai request do retry mạng sẽ chạy tuần tự; request
    // thứ hai thấy trạng thái đã xử lý và không sinh buổi/thông báo lần nữa.
    const schedule = await this.dataSource.transaction(async (manager) => {
      const scheduleRepo = manager.getRepository(TeachingSchedule);
      const locked = await scheduleRepo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked) throw new NotFoundException('Lịch dạy không tồn tại');

      const teacher = await manager
        .getRepository(Teacher)
        .findOne({ where: { id: locked.teacherId } });
      if (teacher?.employeeId !== employeeId) {
        throw new ForbiddenException('Bạn không phải giáo viên của lịch này');
      }
      if (locked.confirmationStatus !== ConfirmationStatus.PENDING) {
        throw new ConflictException('Lịch này đã được xử lý');
      }

      locked.confirmationStatus = dto.status;
      locked.confirmedAt = new Date();
      locked.rejectionReason =
        dto.status === ConfirmationStatus.REJECTED ? dto.reason!.trim() : null;
      return scheduleRepo.save(locked);
    });

    if (dto.status === ConfirmationStatus.CONFIRMED) {
      await this.onScheduleConfirmed(schedule);
    }

    await this.notifyConfirmationResult(schedule);

    return this.findOne(id);
  }

  /**
   * Giáo viên vừa đồng ý lịch: tự động sinh buổi dạy cho cả thời hạn hiệu
   * lực của mẫu (không bắt Giáo vụ/Nhân sự phải vào sinh tay), và chốt luôn
   * các buổi lỡ được sinh từ trước lúc mẫu còn PENDING (ít gặp — thường chỉ
   * xảy ra nếu ai đó bấm "Sinh buổi" thủ công trước khi giáo viên xác nhận).
   */
  private async onScheduleConfirmed(schedule: TeachingSchedule): Promise<void> {
    try {
      await this.sessionRepo.update(
        {
          scheduleId: schedule.id,
          confirmationStatus: ConfirmationStatus.PENDING,
        },
        {
          confirmationStatus: ConfirmationStatus.CONFIRMED,
          confirmedAt: schedule.confirmedAt,
        },
      );

      const effectiveFrom = toDateString(schedule.effectiveFrom) as string;
      const effectiveTo = toDateString(schedule.effectiveTo);
      // effectiveTo để trống hoặc quá xa (>400 ngày) thì cắt ở mốc an
      // toàn của generateSessions() thay vì để nó ném lỗi "khoảng quá dài".
      const cappedTo = addDays(effectiveFrom, MAX_GENERATE_DAYS);
      const toDate =
        effectiveTo && effectiveTo < cappedTo ? effectiveTo : cappedTo;

      await this.generateSessions(schedule.id, {
        fromDate: effectiveFrom,
        toDate,
      });
    } catch (error) {
      // Xác nhận lịch đã lưu thành công rồi — sinh buổi lỗi thì log để
      // Giáo vụ/Nhân sự vào sinh tay bù, không làm hỏng thao tác của giáo viên.
      this.logger.error(
        `Tự động sinh buổi cho lịch #${schedule.id} sau khi xác nhận lỗi`,
        error as any,
      );
    }
  }

  /**
   * Sinh buổi dạy cụ thể từ mẫu lặp cho khoảng ngày.
   * Idempotent: chạy lại không nhân đôi (unique schedule_id + date),
   * buổi đã tồn tại được bỏ qua thay vì ghi đè — không mất dữ liệu chấm công.
   */
  async generateSessions(id: number, dto: GenerateSessionsDto) {
    assertDateOrder(
      dto.fromDate,
      dto.toDate,
      'fromDate phải nhỏ hơn hoặc bằng toDate',
    );

    const spanDays =
      (Date.parse(`${dto.toDate}T00:00:00Z`) -
        Date.parse(`${dto.fromDate}T00:00:00Z`)) /
      86_400_000;

    if (spanDays > MAX_GENERATE_DAYS) {
      throw new BadRequestException(
        `Khoảng ngày tối đa ${MAX_GENERATE_DAYS} ngày mỗi lần sinh`,
      );
    }

    const schedule = await this.getEntity(id);

    if (!schedule.isActive) {
      throw new BadRequestException(
        'Lịch đang ngừng áp dụng, không sinh buổi dạy được',
      );
    }

    // Chỉ sinh trong phần giao giữa khoảng yêu cầu và khoảng hiệu lực của mẫu.
    const effectiveFrom = toDateString(schedule.effectiveFrom) as string;
    const effectiveTo = toDateString(schedule.effectiveTo);

    const from = dto.fromDate > effectiveFrom ? dto.fromDate : effectiveFrom;
    const to =
      effectiveTo && dto.toDate > effectiveTo ? effectiveTo : dto.toDate;

    if (from > to) {
      return { created: 0, skipped: 0, dates: [] as string[] };
    }

    const dates = listDatesForDayOfWeek(from, to, schedule.dayOfWeek);

    if (dates.length === 0) {
      return { created: 0, skipped: 0, dates: [] as string[] };
    }

    const existing = await this.sessionRepo
      .createQueryBuilder('ss')
      .select('ss.date', 'date')
      .where('ss.scheduleId = :id', { id })
      .andWhere('ss.date IN (:...dates)', { dates })
      .getRawMany();

    const existingDates = new Set(
      existing.map((row) => toDateString(row.date) as string),
    );

    const candidateDates = dates.filter((date) => !existingDates.has(date));

    /**
     * Chặn trùng ô lịch **trước khi** chèn.
     *
     * `existingDates` chỉ chống nhân đôi buổi của CHÍNH mẫu này (unique
     * schedule_id + date). Hai mẫu lịch khác nhau — vd cùng một giáo viên được
     * xếp ở hai trường cùng khung giờ — vẫn lọt qua và sinh ra hai buổi chồng
     * giờ, đúng kiểu dữ liệu rác mà không ai phát hiện cho tới lúc chấm công.
     *
     * Ngày nào vướng thì **bỏ qua ngày đó** và trả về trong `conflicts`, thay
     * vì ném lỗi cho cả lượt sinh: một ngày kẹt không nên chặn cả học kỳ.
     */
    const conflicts = await this.findSlotConflicts(schedule, candidateDates);
    const conflictDates = new Set(conflicts.map((c) => c.date));
    const toCreate = candidateDates.filter((date) => !conflictDates.has(date));

    if (toCreate.length > 0) {
      // Chốt đơn giá mặc định hiện tại của giáo viên vào từng buổi mới sinh —
      // đổi đơn giá sau đó không được làm lệch giá đã chốt của buổi đã sinh.
      const teacher = await this.teacherRepo.findOne({
        where: { id: schedule.teacherId },
      });

      // Giáo viên công ty không nhận theo rate_per_period — chốt luôn phụ
      // cấp xăng theo khoảng cách vào từng buổi sinh thay vào đó
      // (teacherId/schoolId cố định theo cả mẫu lịch nên chỉ cần tính 1 lần).
      const { isCompanyTeacher, distanceToSchoolKm, gasAllowance } =
        await this.fuelAllowanceTierService.computeForTeacherSchool(
          schedule.teacherId,
          schedule.schoolId,
          schedule.schoolLocationId,
        );
      const ratePerPeriod = effectiveRatePerPeriod(teacher, isCompanyTeacher);

      // Buổi sinh ra kế thừa trạng thái xác nhận của mẫu lịch tại thời điểm
      // sinh: mẫu đã CONFIRMED thì buổi cũng CONFIRMED luôn, khỏi bắt giáo
      // viên xác nhận lại từng buổi của một lịch đã nhận.
      const inheritedConfirmation =
        schedule.confirmationStatus === ConfirmationStatus.CONFIRMED
          ? {
              confirmationStatus: ConfirmationStatus.CONFIRMED,
              confirmedAt: schedule.confirmedAt ?? new Date(),
            }
          : { confirmationStatus: ConfirmationStatus.PENDING };

      await this.sessionRepo.insert(
        toCreate.map((date) => ({
          scheduleId: schedule.id,
          teacherId: schedule.teacherId,
          schoolId: schedule.schoolId,
          // Điểm trường phải chép sang buổi dạy: Mini App đọc điểm trường của
          // BUỔI (để hiện tên cơ sở và đo GPS check-in theo đúng cơ sở đó),
          // không đọc ngược lên mẫu lịch. Thiếu dòng này thì buổi sinh từ mẫu
          // mất sạch cơ sở — giáo viên không biết phải đến điểm trường nào.
          schoolLocationId: schedule.schoolLocationId ?? null,
          classId: schedule.classId ?? null,
          subjectId: schedule.subjectId,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          periods: schedule.periods ?? 1,
          ratePerPeriod,
          distanceToSchoolKm,
          gasAllowance,
          status: SessionStatus.SCHEDULED,
          ...inheritedConfirmation,
        })),
      );
    }

    return {
      created: toCreate.length,
      skipped: dates.length - toCreate.length,
      dates: toCreate,
      conflicts,
    };
  }

  /**
   * Các ngày mà giáo viên hoặc lớp đã bận trong đúng khung giờ của mẫu lịch.
   *
   * Một tiết / một khung giờ chỉ được có **một lớp và một giáo viên**: giáo
   * viên không phân thân sang trường khác, học sinh không ngồi hai lớp cùng lúc.
   */
  private async findSlotConflicts(
    schedule: TeachingSchedule,
    dates: string[],
  ): Promise<{ date: string; reason: string }[]> {
    if (!dates.length) return [];

    const rows = await this.sessionRepo
      .createQueryBuilder('ss')
      .leftJoin('ss.teacher', 't')
      .leftJoin('ss.class', 'cl')
      .leftJoin('ss.school', 'sc')
      .select([
        'ss.date AS "date"',
        'ss.teacherId AS "teacherId"',
        'ss.classId AS "classId"',
        't.name AS "teacherName"',
        'cl.name AS "className"',
        'sc.name AS "schoolName"',
      ])
      .where('ss.date IN (:...dates)', { dates })
      .andWhere('ss.status IN (:...statuses)', {
        statuses: ACTIVE_SESSION_STATUSES,
      })
      // Buổi của chính mẫu này không tính là trùng — sinh lại vẫn phải chạy được.
      .andWhere('(ss.scheduleId IS NULL OR ss.scheduleId != :scheduleId)', {
        scheduleId: schedule.id,
      })
      .andWhere(
        '(ss.teacherId = :teacherId OR (:classId::int IS NOT NULL AND ss.classId = :classId))',
        { teacherId: schedule.teacherId, classId: schedule.classId ?? null },
      )
      .andWhere('ss.startTime < :endTime', { endTime: schedule.endTime })
      .andWhere('ss.endTime > :startTime', { startTime: schedule.startTime })
      .getRawMany();

    const seen = new Map<string, string>();

    for (const row of rows) {
      const date = toDateString(row.date) as string;
      if (seen.has(date)) continue;

      seen.set(
        date,
        row.teacherId === schedule.teacherId
          ? `Giáo viên ${row.teacherName ?? ''} đã có buổi tại ${row.schoolName ?? 'trường khác'}`.trim()
          : `Lớp ${row.className ?? ''} đã có buổi khác cùng giờ`.trim(),
      );
    }

    return [...seen.entries()].map(([date, reason]) => ({ date, reason }));
  }

  private async getEntity(id: number): Promise<TeachingSchedule> {
    const schedule = await this.scheduleRepo.findOne({ where: { id } });

    if (!schedule) {
      throw new NotFoundException('Lịch dạy không tồn tại');
    }

    return schedule;
  }

  /** Báo cho giáo viên: có mẫu lịch mới (hoặc đổi giáo viên) cần xác nhận. */
  private async notifyConfirmationRequest(
    schedule: TeachingSchedule,
    teacher: Teacher,
  ): Promise<void> {
    // Giáo viên thuê ngoài không có tài khoản đăng nhập — không có ai để báo.
    if (!teacher.employeeId) return;

    const message =
      `Bạn được xếp lịch dạy ${DAY_OF_WEEK_LABELS[schedule.dayOfWeek] ?? ''} ` +
      `${toDisplayTime(schedule.startTime)}–${toDisplayTime(schedule.endTime)}, ` +
      `bắt đầu từ ${toDateString(schedule.effectiveFrom)}. Vui lòng xác nhận hoặc từ chối.`;
    const pushData = {
      kind: TEACHING_SCHEDULE_CONFIRM_REQUEST_KIND,
      module: TEACHING_MODULE,
      route: TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE,
      url: TEACHING_SCHEDULE_CONFIRM_TEACHER_URL,
    };

    try {
      await this.notificationService.create({
        receiverId: teacher.employeeId,
        type: NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
        message,
        meta: {
          ...pushData,
          entityType: 'schedule',
          scheduleId: schedule.id,
        },
      });

      const tokens = await this.employeeFcmTokenService.getTokens([
        teacher.employeeId,
      ]);
      if (tokens.length) {
        await this.fcmService.sendToMultiple(
          tokens.map((t) => t.token),
          TEACHING_SCHEDULE_CONFIRM_REQUEST_TITLE,
          message,
          pushData,
        );
      }
    } catch (error) {
      this.logger.error(
        'Gửi thông báo yêu cầu xác nhận lịch dạy lỗi',
        error as any,
      );
    }
  }

  /** Báo kết quả xác nhận/từ chối cho Giáo vụ, Nhân sự và chính giáo viên. */
  private async notifyConfirmationResult(
    schedule: TeachingSchedule,
  ): Promise<void> {
    const confirmed =
      schedule.confirmationStatus === ConfirmationStatus.CONFIRMED;
    const scheduleFull = await this.scheduleRepo.findOne({
      where: { id: schedule.id },
      relations: ['teacher', 'school', 'class', 'subject'],
    });
    const teacherName = scheduleFull?.teacher?.name ?? 'Giáo viên';
    const schoolName = scheduleFull?.school?.name ?? '';
    const className = scheduleFull?.class?.name ?? '';
    const subjectName = scheduleFull?.subject?.name ?? '';
    const placeLabel = [schoolName, className].filter(Boolean).join(' - ');
    const timeLabel =
      `${DAY_OF_WEEK_LABELS[schedule.dayOfWeek] ?? ''} ` +
      `${toDisplayTime(schedule.startTime)}–${toDisplayTime(schedule.endTime)}` +
      `${subjectName ? ` môn ${subjectName}` : ''}` +
      `${placeLabel ? ` tại ${placeLabel}` : ''}`;

    const managerMessage = confirmed
      ? `${teacherName} đã xác nhận lịch dạy ${timeLabel}.`
      : `${teacherName} đã từ chối lịch dạy ${timeLabel}. Lý do: ${schedule.rejectionReason}`;
    const teacherMessage = confirmed
      ? 'Bạn đã xác nhận lịch dạy thành công.'
      : 'Bạn đã từ chối lịch dạy này.';
    const pushData = {
      kind: TEACHING_SCHEDULE_CONFIRM_RESULT_KIND,
      module: TEACHING_MODULE,
      route: TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE,
      url: TEACHING_SCHEDULE_CONFIRM_MANAGER_URL,
    };
    const meta = {
      ...pushData,
      entityType: 'schedule',
      scheduleId: schedule.id,
      status: schedule.confirmationStatus,
      reason: schedule.rejectionReason,
      teacherName,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      dayOfWeek: schedule.dayOfWeek,
      schoolId: scheduleFull?.schoolId,
      schoolName,
      classId: scheduleFull?.classId,
      className,
      subjectId: scheduleFull?.subjectId,
      subjectName,
    };

    try {
      const managers = await findTeachingManagers(this.employeeRepo);
      const receiverIds = managers.map((m) => m.id);

      for (const receiverId of receiverIds) {
        await this.notificationService.create({
          receiverId,
          type: NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT,
          message: managerMessage,
          meta,
        });
      }

      if (scheduleFull?.teacher?.employeeId) {
        await this.notificationService.create({
          receiverId: scheduleFull.teacher.employeeId,
          type: NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT,
          message: teacherMessage,
          meta: {
            ...pushData,
            route: TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE,
            url: TEACHING_SCHEDULE_CONFIRM_TEACHER_URL,
            entityType: 'schedule',
            scheduleId: schedule.id,
            status: schedule.confirmationStatus,
          },
        });
      }

      if (receiverIds.length) {
        const tokens =
          await this.employeeFcmTokenService.getTokens(receiverIds);
        if (tokens.length) {
          await this.fcmService.sendToMultiple(
            tokens.map((t) => t.token),
            TEACHING_SCHEDULE_CONFIRM_RESULT_TITLE,
            managerMessage,
            pushData,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'Gửi thông báo kết quả xác nhận lịch dạy lỗi',
        error as any,
      );
    }
  }

  private buildScheduleQuery() {
    return (
      this.scheduleRepo
        .createQueryBuilder('s')
        .innerJoin('s.teacher', 't')
        .innerJoin('s.school', 'sc')
        // Lịch cũ chưa gắn lớp vẫn phải xuất hiện trong danh sách.
        .leftJoin('s.class', 'cl')
        // Lịch của trường không chia cơ sở không có điểm trường -> leftJoin.
        .leftJoin('s.schoolLocation', 'sl')
        .innerJoin('s.subject', 'sub')
        .select([
          's.id AS "id"',
          's.teacherId AS "teacherId"',
          't.name AS "teacherName"',
          's.schoolId AS "schoolId"',
          'sc.name AS "schoolName"',
          's.schoolLocationId AS "schoolLocationId"',
          'sl.name AS "locationName"',
          's.classId AS "classId"',
          'cl.name AS "className"',
          'cl.gradeLevel AS "classGradeLevel"',
          's.subjectId AS "subjectId"',
          'sub.name AS "subjectName"',
          'sub.school_year AS "schoolYear"',
          's.dayOfWeek AS "dayOfWeek"',
          's.startTime AS "startTime"',
          's.endTime AS "endTime"',
          's.periods AS "periods"',
          'sub.ratePerPeriod AS "subjectRatePerPeriod"',
          's.effectiveFrom AS "effectiveFrom"',
          's.effectiveTo AS "effectiveTo"',
          's.isActive AS "isActive"',
          's.note AS "note"',
          's.confirmationStatus AS "confirmationStatus"',
          's.confirmedAt AS "confirmedAt"',
          's.rejectionReason AS "rejectionReason"',
        ])
    );
  }

  private toScheduleItem(row: Record<string, any>) {
    return {
      id: Number(row.id),
      teacherId: Number(row.teacherId),
      teacherName: row.teacherName,
      schoolId: Number(row.schoolId),
      schoolName: row.schoolName,
      schoolLocationId:
        row.schoolLocationId == null ? null : Number(row.schoolLocationId),
      locationName: row.locationName ?? null,
      classId:
        row.classId === null || row.classId === undefined
          ? null
          : Number(row.classId),
      className: row.className ?? null,
      classGradeLevel:
        row.classGradeLevel === null || row.classGradeLevel === undefined
          ? null
          : Number(row.classGradeLevel),
      subjectId: Number(row.subjectId),
      subjectName: row.subjectName,
      schoolYear: row.schoolYear ?? null,
      dayOfWeek: Number(row.dayOfWeek),
      dayOfWeekLabel: DAY_OF_WEEK_LABELS[Number(row.dayOfWeek)] ?? null,
      startTime: toDisplayTime(row.startTime),
      endTime: toDisplayTime(row.endTime),
      periods: row.periods === null ? null : Number(row.periods),
      /** Đơn giá của môn học — chỉ để tham khảo, không lưu ở mẫu lịch. */
      subjectRatePerPeriod: nullableNumber(row.subjectRatePerPeriod),
      effectiveFrom: toDateString(row.effectiveFrom),
      effectiveTo: toDateString(row.effectiveTo),
      isActive: row.isActive,
      note: row.note ?? null,
      confirmationStatus: row.confirmationStatus,
      confirmedAt: row.confirmedAt ?? null,
      rejectionReason: row.rejectionReason ?? null,
    };
  }

  private async assertTeacherActive(teacherId: number): Promise<Teacher> {
    const teacher = await this.teacherRepo.findOne({
      where: { id: teacherId },
    });

    if (!teacher) {
      throw new BadRequestException('Giáo viên không tồn tại');
    }

    if (!teacher.isActive) {
      throw new BadRequestException(
        `Giáo viên "${teacher.name}" đang ngừng hoạt động`,
      );
    }

    return teacher;
  }

  private async assertSubjectBelongsToSchool(
    subjectId: number,
    schoolId: number,
  ) {
    const subject = await this.subjectRepo.findOne({
      where: { id: subjectId },
    });

    if (!subject) {
      throw new BadRequestException('Môn học không tồn tại');
    }

    if (subject.schoolId !== schoolId) {
      throw new BadRequestException('Môn học không thuộc trường đã chọn');
    }
  }

  /**
   * Một giáo viên không thể có 2 mẫu lịch cùng thứ, khung giờ giao nhau
   * và khoảng hiệu lực giao nhau.
   */
  private async assertNoScheduleConflict(
    candidate: {
      teacherId: number;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
    },
    exceptId?: number,
  ) {
    const qb = this.scheduleRepo
      .createQueryBuilder('s')
      .innerJoin('s.school', 'sc')
      .select([
        's.id AS "id"',
        's.startTime AS "startTime"',
        's.endTime AS "endTime"',
        'sc.name AS "schoolName"',
      ])
      .where('s.teacherId = :teacherId', {
        teacherId: candidate.teacherId,
      })
      .andWhere('s.dayOfWeek = :dayOfWeek', {
        dayOfWeek: candidate.dayOfWeek,
      })
      .andWhere('s.isActive = true')
      // Lịch giáo viên đã từ chối chỉ giữ lại để Giáo vụ thấy và xếp lại;
      // nó không còn chiếm giờ của giáo viên.
      .andWhere('s.confirmationStatus != :rejectedStatus', {
        rejectedStatus: ConfirmationStatus.REJECTED,
      })
      // Khoảng hiệu lực giao nhau (effectiveTo NULL = vô hạn).
      .andWhere('s.effectiveFrom <= :candidateTo', {
        candidateTo: candidate.effectiveTo ?? '9999-12-31',
      })
      .andWhere('(s.effectiveTo IS NULL OR s.effectiveTo >= :candidateFrom)', {
        candidateFrom: candidate.effectiveFrom,
      })
      // Khung giờ giao nhau.
      .andWhere('s.startTime < :endTime', {
        endTime: toDbTime(candidate.endTime),
      })
      .andWhere('s.endTime > :startTime', {
        startTime: toDbTime(candidate.startTime),
      });

    if (exceptId) {
      qb.andWhere('s.id != :exceptId', { exceptId });
    }

    const conflict = await qb.getRawOne();

    if (conflict) {
      throw new ConflictException(
        `Giáo viên đã có lịch ${DAY_OF_WEEK_LABELS[candidate.dayOfWeek]} ` +
          `${toDisplayTime(conflict.startTime)}–${toDisplayTime(conflict.endTime)} ` +
          `tại ${conflict.schoolName} trong khoảng thời gian này`,
      );
    }
  }

  /**
   * Một lớp không thể học 2 môn cùng thứ, cùng khung giờ trong cùng khoảng
   * hiệu lực — học sinh chỉ ngồi được ở một chỗ.
   * Lịch cũ chưa gắn lớp (classId = null) không kiểm tra.
   */
  private async assertNoClassConflict(
    candidate: {
      classId?: number | null;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
    },
    exceptId?: number,
  ) {
    if (!candidate.classId) return;

    const qb = this.scheduleRepo
      .createQueryBuilder('s')
      .innerJoin('s.teacher', 't')
      .innerJoin('s.subject', 'sub')
      .select([
        's.id AS "id"',
        's.startTime AS "startTime"',
        's.endTime AS "endTime"',
        't.name AS "teacherName"',
        'sub.name AS "subjectName"',
      ])
      .where('s.classId = :classId', { classId: candidate.classId })
      .andWhere('s.dayOfWeek = :dayOfWeek', {
        dayOfWeek: candidate.dayOfWeek,
      })
      .andWhere('s.isActive = true')
      .andWhere('s.confirmationStatus != :rejectedStatus', {
        rejectedStatus: ConfirmationStatus.REJECTED,
      })
      .andWhere('s.effectiveFrom <= :candidateTo', {
        candidateTo: candidate.effectiveTo ?? '9999-12-31',
      })
      .andWhere('(s.effectiveTo IS NULL OR s.effectiveTo >= :candidateFrom)', {
        candidateFrom: candidate.effectiveFrom,
      })
      .andWhere('s.startTime < :endTime', {
        endTime: toDbTime(candidate.endTime),
      })
      .andWhere('s.endTime > :startTime', {
        startTime: toDbTime(candidate.startTime),
      });

    if (exceptId) {
      qb.andWhere('s.id != :exceptId', { exceptId });
    }

    const conflict = await qb.getRawOne();

    if (conflict) {
      throw new ConflictException(
        `Lớp này đã có lịch ${DAY_OF_WEEK_LABELS[candidate.dayOfWeek]} ` +
          `${toDisplayTime(conflict.startTime)}–${toDisplayTime(conflict.endTime)} ` +
          `môn ${conflict.subjectName} (GV ${conflict.teacherName}) trong khoảng thời gian này`,
      );
    }
  }
}
