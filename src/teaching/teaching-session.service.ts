import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import {
  DataSource,
  In,
  MoreThan,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import nodemailer from 'nodemailer';
import { TeachingSession } from './entities/teaching-session.entity';
import { Teacher } from './entities/teacher.entity';
import { Subject } from '../subject/subject.entity';
import { School } from '../school/schools.entity';
import { SchoolLocation } from '../school-location/entities/school-location.entity';
import { TeachingApplication } from './entities/teaching-application.entity';
import { SchoolClassService } from './school-class.service';
import { EntityManager } from 'typeorm';
import {
  BulkCheckAttendanceDto,
  BulkAssignTeachingSessionDto,
  ApplyTeachingSessionDto,
  AssignTeachingSessionDto,
  CheckAttendanceDto,
  CheckinTeachingSessionDto,
  CheckoutTeachingSessionDto,
  ConfirmTeachingSessionDto,
  CreateTeachingSessionDto,
  DeclineTeachingSessionDto,
  QueryAttendanceSummaryDto,
  QueryTravelReviewDto,
  QueryTeachingSessionsDto,
  NotifyTeachingScheduleDto,
  SubmitLessonDto,
  UpdateTeachingSessionDto,
} from './dto/teaching-session.dto';
import {
  ACTIVE_SESSION_STATUSES,
  AssignmentStatus,
  CHECKED_STATUSES,
  ConfirmationStatus,
  DAY_OF_WEEK_LABELS,
  SESSION_STATUS_LABELS,
  SessionStatus,
  TeachingApplicationStatus,
} from './teaching.enum';
import {
  amountOf,
  assertDateOrder,
  assertTimeOrder,
  computeDayBlocks,
  sessionBlockIds,
  isBlockCheckedIn,
  dayOfWeekOf,
  toDateString,
  toDbTime,
  toDisplayTime,
  type DayBlockFlags,
} from './teaching.util';
import { TeachingScheduleNotificationLog } from './entities/teaching-schedule-notification-log.entity';
import { NotificationService } from '../notifications/services/notification.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import {
  TEACHING_MODULE,
  TEACHING_SCHEDULE_KIND,
  TEACHING_SCHEDULE_ROUTE,
  TEACHING_SCHEDULE_URL,
} from '../notifications/constants/teaching-schedule.constant';
import {
  TEACHING_CHECKIN_ALERT_KIND,
  TEACHING_CHECKIN_ALERT_LATE_MINUTES,
  TEACHING_CHECKIN_ALERT_LEAD_MINUTES,
  TEACHING_CHECKIN_ALERT_ROUTE,
  TEACHING_CHECKIN_ALERT_TITLE,
  TEACHING_CHECKIN_ALERT_URL,
  isTeachingCheckinAlertZaloEnabled,
  TEACHING_CHECKIN_ALERT_ZALO_PREFIX,
} from '../notifications/constants/teaching-checkin-alert.constant';
import {
  TEACHING_SCHEDULE_CONFIRM_ALERT_KIND,
  TEACHING_SCHEDULE_CONFIRM_ALERT_LEAD_MINUTES,
  TEACHING_SCHEDULE_CONFIRM_ALERT_MANAGER_TITLE,
  TEACHING_SCHEDULE_CONFIRM_ALERT_TEACHER_TITLE,
  TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE,
  TEACHING_SCHEDULE_CONFIRM_MANAGER_URL,
  TEACHING_SCHEDULE_CONFIRM_REQUEST_KIND,
  TEACHING_SCHEDULE_CONFIRM_REQUEST_TITLE,
  TEACHING_SCHEDULE_CONFIRM_RESULT_KIND,
  TEACHING_SCHEDULE_CONFIRM_RESULT_TITLE,
  TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE,
  TEACHING_SCHEDULE_CONFIRM_TEACHER_URL,
} from '../notifications/constants/teaching-schedule-confirmation.constant';
import {
  TEACHING_SESSION_DECLINE_KIND,
  TEACHING_SESSION_DECLINE_ROUTE,
  TEACHING_SESSION_DECLINE_TITLE,
  TEACHING_SESSION_DECLINE_URL,
} from '../notifications/constants/teaching-session-decline.constant';
import { Employee } from '../employee/employee.entity';
import { NotifyService } from '../notify-zalo/notify.service';
import {
  buildMissingAllowanceReport,
  diagnoseGasAllowance,
  FuelAllowanceTierService,
  homeAtDate,
  type MissingAllowanceEntry,
} from './fuel-allowance-tier.service';
import { effectiveRatePerPeriod } from './teaching-rate.util';
import { findTeachingManagers as findTeachingManagersUtil } from './teaching-managers.util';
import { FcmService } from '../fcm/fcm.service';
import { EmployeeFcmTokenService } from '../employee-fcm-token/employee-fcm-token.service';
import { LessonImageStorageService } from './lesson-image-storage.service';
import { haversineKm } from './teacher-matching.service';
import {
  buildTravelBlocks,
  type LatLngPoint,
} from './teacher-travel.util';
import { LessonImage } from './lesson-image.type';
import {
  LESSON_REPORT_IMAGE_TYPE,
  LessonImageEntity,
} from './entities/lesson-image.entity';
import { isCronLeader } from '../utils/is-cron-leader';
import { TEACHER_STAFF_ROLE, TeachingScope } from './teaching-roles';
import {
  TEACHING_LESSON_REPORT_ALERT_KIND,
  TEACHING_LESSON_REPORT_ALERT_MANAGER_TITLE,
  TEACHING_LESSON_REPORT_ALERT_TITLE,
  TEACHING_LESSON_REPORT_MANAGER_ROUTE,
  TEACHING_LESSON_REPORT_MANAGER_URL,
  TEACHING_LESSON_REPORT_ROUTE,
  TEACHING_LESSON_REPORT_URL,
} from '../notifications/constants/teaching-lesson-report.constant';

const MAX_LIMIT = 200;

/** Ngữ cảnh ghi log khi check-out hỏng — không chứa token hay dữ liệu ảnh. */
interface CheckoutTrace {
  requestId: string;
  sessionId: number;
  employeeId: number;
  teacherId: number | null;
  imageCount: number;
}

/** Một dòng trong bảng lịch dạy gửi kèm email. */
interface ScheduleDetailRow {
  date: string;
  startTime: string | null;
  endTime: string | null;
  periods: number;
  schoolName: string;
  className: string | null;
  subjectName: string;
}

@Injectable()
export class TeachingSessionService {
  private readonly logger = new Logger(TeachingSessionService.name);

  constructor(
    @InjectRepository(TeachingSession)
    private readonly sessionRepo: Repository<TeachingSession>,

    @InjectRepository(Teacher)
    private readonly teacherRepo: Repository<Teacher>,

    @InjectRepository(Subject)
    private readonly subjectRepo: Repository<Subject>,

    @InjectRepository(TeachingApplication)
    private readonly applicationRepo: Repository<TeachingApplication>,

    @InjectRepository(TeachingScheduleNotificationLog)
    private readonly scheduleNotificationLogRepo: Repository<TeachingScheduleNotificationLog>,

    private readonly classService: SchoolClassService,

    private readonly dataSource: DataSource,
    private readonly notificationService: NotificationService,
    private readonly fcmService: FcmService,
    private readonly employeeFcmTokenService: EmployeeFcmTokenService,
    private readonly lessonImageStorage: LessonImageStorageService,

    // Đặt cuối danh sách: test dựng service bằng tham số vị trí, chèn vào giữa
    // là đẩy lệch mọi dependency phía sau.
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,

    private readonly zaloNotifyService: NotifyService,
    private readonly fuelAllowanceTierService: FuelAllowanceTierService,

    // Đặt CUỐI danh sách theo đúng quy ước ở trên — test dựng service bằng
    // tham số vị trí nên chèn vào giữa là đẩy lệch mọi dependency phía sau.
    @InjectRepository(SchoolLocation)
    private readonly schoolLocationRepo: Repository<SchoolLocation>,

    @InjectRepository(School)
    private readonly schoolRepo: Repository<School>,
  ) {}

  // ==================== LỊCH DẠY ====================

  /**
   * `includeBlockFlags`: tính `checkinRequired`/`checkoutRequired` theo block
   * cùng trường — tốn thêm 1 query nhỏ mỗi cặp (giáo viên, ngày) xuất hiện
   * trong trang kết quả. Bật cho `findMine` (luôn đúng 1 giáo viên, rẻ), tắt
   * cho danh sách quản lý (`GET /teaching-sessions` có thể trải nhiều giáo
   * viên/nhiều ngày cùng lúc) để tránh N+1 trên bảng rộng của Giáo vụ.
   */
  async findAll(query: QueryTeachingSessionsDto, includeBlockFlags = false) {
    assertDateOrder(
      query.fromDate,
      query.toDate,
      'fromDate phải nhỏ hơn hoặc bằng toDate',
    );

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, MAX_LIMIT);

    const qb = this.applyFilters(this.buildSessionQuery(), query);

    const total = await qb.getCount();

    const rows = await qb
      .orderBy('ss.date', 'ASC')
      .addOrderBy('ss.startTime', 'ASC')
      .addOrderBy('ss.id', 'ASC')
      .limit(limit)
      .offset((page - 1) * limit)
      .getRawMany();

    const items = rows.map((row) => this.toSessionItem(row));

    return {
      data: includeBlockFlags ? await this.enrichWithBlockFlags(items) : items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async notifySchedule(dto: NotifyTeachingScheduleDto, senderId: number) {
    assertDateOrder(
      dto.fromDate,
      dto.toDate,
      'fromDate phải nhỏ hơn hoặc bằng toDate',
    );

    const signature = [
      senderId,
      dto.fromDate,
      dto.toDate,
      dto.teacherId ?? '',
      dto.schoolId ?? '',
      dto.classId ?? '',
      dto.subjectId ?? '',
    ].join(':');
    const duplicate = await this.scheduleNotificationLogRepo.findOne({
      where: {
        signature,
        createdAt: MoreThan(new Date(Date.now() - 60_000)),
      },
      order: { createdAt: 'DESC' },
    });
    if (duplicate) {
      throw new HttpException(
        'Lịch này vừa được gửi. Vui lòng thử lại sau 1 phút',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const qb = this.sessionRepo
      .createQueryBuilder('session')
      .innerJoin('session.teacher', 'teacher')
      .leftJoin('teacher.employee', 'employee')
      .select([
        'teacher.id AS "teacherId"',
        'teacher.name AS "teacherName"',
        'teacher.employeeId AS "employeeId"',
        'COALESCE(teacher.email, employee.email) AS "email"',
        'COUNT(session.id)::int AS "sessionCount"',
        'COALESCE(SUM(session.periods), 0)::int AS "periodCount"',
      ])
      .where('session.date BETWEEN :fromDate AND :toDate', {
        fromDate: dto.fromDate,
        toDate: dto.toDate,
      })
      .andWhere('session.assignmentStatus = :assigned', {
        assigned: AssignmentStatus.ASSIGNED,
      });
    if (dto.teacherId)
      qb.andWhere('session.teacherId = :teacherId', {
        teacherId: dto.teacherId,
      });
    if (dto.schoolId)
      qb.andWhere('session.schoolId = :schoolId', { schoolId: dto.schoolId });
    if (dto.classId)
      qb.andWhere('session.classId = :classId', { classId: dto.classId });
    if (dto.subjectId)
      qb.andWhere('session.subjectId = :subjectId', {
        subjectId: dto.subjectId,
      });
    const rows = await qb
      .groupBy('teacher.id')
      .addGroupBy('employee.email')
      .orderBy('teacher.name', 'ASC')
      .getRawMany();

    const range = `${this.formatVietnameseDate(dto.fromDate)} – ${this.formatVietnameseDate(dto.toDate)}`;
    const recipients = rows.filter((row) => Number(row.employeeId) > 0);
    const teacherResults = recipients.map((row) => ({
      id: Number(row.teacherId),
      name: row.teacherName as string,
      sessionCount: Number(row.sessionCount),
    }));

    for (const row of recipients) {
      const body = this.buildScheduleMessage(
        range,
        Number(row.sessionCount),
        Number(row.periodCount),
        dto.message,
      );
      await this.notificationService.create({
        receiverId: Number(row.employeeId),
        senderId,
        // Type riêng: giáo viên lấy thông báo lịch dạy bằng
        // GET /notifications/teaching-schedule, không lẫn với SYSTEM.
        type: NotificationType.TEACHING_SCHEDULE,
        message: body,
        meta: {
          kind: TEACHING_SCHEDULE_KIND,
          module: TEACHING_MODULE,
          route: TEACHING_SCHEDULE_ROUTE,
          url: TEACHING_SCHEDULE_URL,
          fromDate: dto.fromDate,
          toDate: dto.toDate,
          sessionCount: Number(row.sessionCount),
          periodCount: Number(row.periodCount),
        },
      });
    }

    const employeeIds = recipients.map((row) => Number(row.employeeId));
    const tokens = employeeIds.length
      ? await this.employeeFcmTokenService.getTokens(employeeIds)
      : [];
    await Promise.allSettled(
      recipients.map((row) => {
        const body = this.buildScheduleMessage(
          range,
          Number(row.sessionCount),
          Number(row.periodCount),
          dto.message,
        );
        return this.fcmService.sendToMultiple(
          tokens
            .filter((token) => token.employeeId === Number(row.employeeId))
            .map((token) => token.token),
          'Lịch dạy mới',
          body,
          {
            kind: TEACHING_SCHEDULE_KIND,
            module: TEACHING_MODULE,
            route: TEACHING_SCHEDULE_ROUTE,
            url: TEACHING_SCHEDULE_URL,
          },
        );
      }),
    );

    const scheduleDetails = await this.loadScheduleDetails(
      dto,
      recipients.filter((row) => row.email).map((row) => Number(row.teacherId)),
    );
    const emailSentCount = await this.sendScheduleEmails(
      recipients,
      range,
      scheduleDetails,
      dto.message,
    );
    const sessionCount = rows.reduce(
      (sum, row) => sum + Number(row.sessionCount),
      0,
    );
    const skippedWithoutAccount = rows.length - recipients.length;
    await this.scheduleNotificationLogRepo.save({
      senderId,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      signature,
      filters: {
        teacherId: dto.teacherId,
        schoolId: dto.schoolId,
        subjectId: dto.subjectId,
      },
      notifiedCount: recipients.length,
      sessionCount,
      skippedWithoutAccount,
      emailSentCount,
    });
    this.logger.log(
      `Gửi lịch ${dto.fromDate}..${dto.toDate} bởi employee=${senderId}: ` +
        `${recipients.length} người, ${sessionCount} buổi, ${emailSentCount} email`,
    );

    return {
      notified: recipients.length,
      sessionCount,
      teachers: teacherResults,
      skippedWithoutAccount,
      emailSent: emailSentCount,
    };
  }

  /** Lịch dạy của chính giáo viên đang đăng nhập. */
  async findMine(employeeId: number, query: QueryTeachingSessionsDto) {
    const teacher = await this.teacherRepo.findOne({ where: { employeeId } });

    if (!teacher) {
      throw new NotFoundException(
        'Tài khoản này chưa được gắn với hồ sơ giáo viên nào',
      );
    }

    // 🔒 teacherId lấy từ token, bỏ qua teacherId FE gửi lên.
    return this.findAll({ ...query, teacherId: teacher.id }, true);
  }

  async findOpen(employeeId: number, query: QueryTeachingSessionsDto) {
    const teacher = await this.getTeacherByEmployee(employeeId);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, MAX_LIMIT);
    const qb = this.applyFilters(this.buildSessionQuery(teacher.id), {
      ...query,
      teacherId: undefined,
    });
    qb.andWhere('ss.assignmentStatus = :openStatus', {
      openStatus: AssignmentStatus.OPEN,
    });
    qb.andWhere('ss.date >= :today', { today: this.todayDateString() });

    const total = await qb.getCount();
    const rows = await qb
      .orderBy('ss.date', 'ASC')
      .addOrderBy('ss.startTime', 'ASC')
      .limit(limit)
      .offset((page - 1) * limit)
      .getRawMany();
    return {
      data: rows.map((row) => this.toSessionItem(row)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Chi tiết một buổi dạy, thu hẹp theo phạm vi của người gọi — cùng luật với
   * `findAll` / thư viện ảnh:
   *   - manage / view : mọi buổi.
   *   - self (giáo viên): buổi của chính mình, buổi đang mở tuyển (để xem
   *     trước khi ứng tuyển), hoặc buổi được gợi ý cho mình.
   *   - own-schools (kinh doanh): buổi ở trường mình phụ trách.
   * Ngoài phạm vi trả **404** chứ không 403: không để lộ buổi dạy đó tồn tại.
   *
   * Trước đây endpoint này chỉ mở cho role quản lý; mini app giáo viên gọi
   * để xem chi tiết buổi dạy và bị 403 ~500 lần/ngày.
   */
  async findOne(id: number, scope: TeachingScope = { kind: 'manage' }) {
    const row = await this.buildSessionQuery()
      .andWhere('ss.id = :id', { id })
      .getRawOne();

    if (!row) {
      throw new NotFoundException('Buổi dạy không tồn tại');
    }

    const [item] = await this.enrichWithBlockFlags([this.toSessionItem(row)]);
    if (!(await this.inScope(item, scope))) {
      throw new NotFoundException('Buổi dạy không tồn tại');
    }
    return item;
  }

  private async inScope(
    item: { teacherId: number | null; schoolId: number; assignmentStatus: string; recommendedTeacherId?: number | null },
    scope: TeachingScope,
  ): Promise<boolean> {
    switch (scope.kind) {
      case 'manage':
      case 'view':
        return true;
      case 'self': {
        const teacher = await this.teacherRepo.findOne({
          where: { employeeId: scope.employeeId },
        });
        if (!teacher) return false;
        return (
          item.teacherId === teacher.id ||
          item.recommendedTeacherId === teacher.id ||
          item.assignmentStatus === AssignmentStatus.OPEN
        );
      }
      case 'own-schools':
        return (
          (await this.sessionRepo.manager.count(School, {
            where: { id: item.schoolId, employee: { id: scope.employeeId } },
          })) > 0
        );
    }
  }

  /** Tạo buổi lẻ hoặc buổi dạy bù (không thuộc mẫu lặp). */
  async create(dto: CreateTeachingSessionDto) {
    assertTimeOrder(dto.startTime, dto.endTime);

    const assignmentStatus =
      dto.assignmentStatus ??
      (dto.teacherId ? AssignmentStatus.ASSIGNED : AssignmentStatus.OPEN);
    this.assertAssignment(assignmentStatus, dto.teacherId);

    const teacher = dto.teacherId
      ? await this.teacherRepo.findOne({ where: { id: dto.teacherId } })
      : null;

    if (dto.teacherId && !teacher) {
      throw new BadRequestException('Giáo viên không tồn tại');
    }

    if (teacher && !teacher.isActive) {
      throw new BadRequestException(
        `Giáo viên "${teacher.name}" đang ngừng hoạt động`,
      );
    }

    let makeupFor: TeachingSession | null = null;

    if (dto.makeupForSessionId) {
      makeupFor = await this.sessionRepo.findOne({
        where: { id: dto.makeupForSessionId },
      });

      if (!makeupFor) {
        throw new BadRequestException('Buổi được dạy bù không tồn tại');
      }
    }

    // Buổi dạy bù kế thừa lớp của buổi gốc khi FE không gửi kèm classId.
    const classId = dto.classId ?? makeupFor?.classId ?? null;

    const schoolClass = classId
      ? await this.classService.resolveForScheduling(classId, dto.schoolId)
      : null;

    const schoolId = schoolClass?.schoolId ?? dto.schoolId;
    // Điểm trường suy từ lớp, cùng cách suy `schoolId` — buổi lẻ/dạy bù không
    // gắn lớp thì để null và check-in lùi về toạ độ trường.
    const schoolLocationId = schoolClass?.schoolLocationId ?? null;

    if (!schoolId) {
      throw new BadRequestException('Vui lòng chọn lớp học cho buổi dạy');
    }

    const subject = await this.subjectRepo.findOne({
      where: { id: dto.subjectId },
    });

    if (!subject) {
      throw new BadRequestException('Môn học không tồn tại');
    }

    if (subject.schoolId !== schoolId) {
      throw new BadRequestException('Môn học không thuộc trường đã chọn');
    }

    if (dto.teacherId) {
      await this.assertTeacherFree(
        dto.teacherId,
        dto.date,
        dto.startTime,
        dto.endTime,
      );
    }

    await this.assertClassFree(classId, dto.date, dto.startTime, dto.endTime);

    // Giáo viên công ty không nhận theo rate_per_period — chốt phụ cấp xăng
    // theo khoảng cách thay vào đó (null nếu là cộng tác viên/chưa có vị trí).
    const { isCompanyTeacher, distanceToSchoolKm, gasAllowance } =
      await this.fuelAllowanceTierService.computeForTeacherSchool(
        dto.teacherId,
        schoolId,
        schoolLocationId,
      );

    const session = this.sessionRepo.create({
      scheduleId: null,
      teacherId: dto.teacherId ?? null,
      assignmentStatus,
      schoolId,
      schoolLocationId,
      classId,
      subjectId: dto.subjectId,
      date: dto.date,
      startTime: toDbTime(dto.startTime),
      endTime: toDbTime(dto.endTime),
      periods: dto.periods ?? 1,
      // Chốt đơn giá mặc định của GIÁO VIÊN ngay tại thời điểm tạo buổi — trừ
      // giáo viên công ty, họ không nhận theo tiết (nhận phụ cấp xăng).
      ratePerPeriod: effectiveRatePerPeriod(teacher, isCompanyTeacher),
      distanceToSchoolKm,
      gasAllowance,
      status: SessionStatus.SCHEDULED,
      isMakeup: Boolean(makeupFor),
      makeupForSessionId: makeupFor?.id ?? null,
      note: dto.note ?? null,
    });

    const saved = await this.sessionRepo.save(session);

    if (saved.teacherId && teacher) {
      await this.notifyConfirmationRequest(saved, teacher);
    }

    return this.findOne(saved.id);
  }

  async update(id: number, dto: UpdateTeachingSessionDto) {
    const session = await this.getEntity(id);
    let assignedTeacher: Teacher | null = null;

    if (
      dto.teacherId !== undefined &&
      dto.teacherId !== session.teacherId &&
      CHECKED_STATUSES.includes(session.status)
    ) {
      throw new ConflictException(
        'Buổi đã chấm công, không thể đổi giáo viên hoặc đơn giá đã chốt',
      );
    }

    // Đổi thời gian buổi đã có dữ liệu chấm công thì ảnh check-in, giờ
    // check-out và báo giảng đã gắn với khung giờ cũ, sửa giờ là làm sai lệch
    // chính những bằng chứng đó. Cùng điều kiện với `remove()`.
    const timeChanged =
      (dto.date !== undefined &&
        dto.date !== (toDateString(session.date) as string)) ||
      (dto.startTime !== undefined &&
        toDbTime(dto.startTime) !== session.startTime) ||
      (dto.endTime !== undefined &&
        toDbTime(dto.endTime) !== session.endTime);

    if (
      timeChanged &&
      (CHECKED_STATUSES.includes(session.status) ||
        session.checkinAt ||
        session.checkoutAt ||
        session.lessonSubmittedAt)
    ) {
      throw new ConflictException(
        'Buổi đã có dữ liệu chấm công, không đổi được ngày/giờ dạy',
      );
    }

    const merged = {
      teacherId:
        dto.teacherId !== undefined ? dto.teacherId : session.teacherId,
      assignmentStatus: dto.assignmentStatus ?? session.assignmentStatus,
      classId: dto.classId ?? session.classId ?? null,
      date: dto.date ?? (toDateString(session.date) as string),
      startTime: dto.startTime ?? session.startTime,
      endTime: dto.endTime ?? session.endTime,
    };

    assertTimeOrder(merged.startTime, merged.endTime);
    this.assertAssignment(merged.assignmentStatus, merged.teacherId);

    // Đổi lớp chỉ trong cùng trường: buổi đã gắn môn/trường, đổi trường là tạo buổi khác.
    if (dto.classId !== undefined) {
      const nextClass = await this.classService.resolveForScheduling(
        dto.classId,
        session.schoolId,
      );
      // Đổi lớp là đổi luôn cơ sở dạy: phải suy lại, không thì buổi giữ điểm
      // trường cũ và check-in bị đo sai địa điểm.
      session.schoolLocationId = nextClass?.schoolLocationId ?? null;
    }

    if (dto.teacherId !== undefined && dto.teacherId !== null) {
      const teacher = await this.teacherRepo.findOne({
        where: { id: dto.teacherId },
      });

      if (!teacher) {
        throw new BadRequestException('Giáo viên không tồn tại');
      }

      if (!teacher.isActive) {
        throw new BadRequestException(
          `Giáo viên "${teacher.name}" đang ngừng hoạt động`,
        );
      }
      assignedTeacher = teacher;
    }

    if (
      dto.teacherId !== undefined ||
      dto.date !== undefined ||
      dto.startTime !== undefined ||
      dto.endTime !== undefined
    ) {
      if (merged.teacherId)
        await this.assertTeacherFree(
          merged.teacherId,
          merged.date,
          merged.startTime,
          merged.endTime,
          id,
        );
    }

    if (
      dto.classId !== undefined ||
      dto.date !== undefined ||
      dto.startTime !== undefined ||
      dto.endTime !== undefined
    ) {
      await this.assertClassFree(
        merged.classId,
        merged.date,
        merged.startTime,
        merged.endTime,
        id,
      );
    }

    session.teacherId = merged.teacherId;
    session.assignmentStatus = merged.assignmentStatus;
    session.classId = merged.classId;
    session.date = merged.date;
    session.startTime = toDbTime(merged.startTime);
    session.endTime = toDbTime(merged.endTime);

    if (dto.note !== undefined) session.note = dto.note ?? null;

    if (dto.periods !== undefined && dto.periods !== session.periods) {
      // Cùng điều kiện với remove()/đổi giờ: buổi đã qua ngày hoặc đã có dấu
      // vết chấm công thì số tiết là căn cứ tính công/phụ cấp đã thực tế xảy
      // ra, sửa lại sẽ làm sai lệch bảng công đã/sắp chốt.
      const past = (toDateString(session.date) as string) < this.todayDateString();
      if (
        past ||
        session.checkinAt ||
        session.checkoutAt ||
        session.lessonSubmittedAt
      ) {
        throw new ConflictException(
          'Buổi đã qua ngày hoặc đã có dấu vết chấm công, không đổi được số tiết',
        );
      }
      session.periods = dto.periods;
    }

    // Chỉ đổi snapshot khi người dùng chủ động gán/đổi giáo viên. Các chỉnh sửa
    // khác tuyệt đối không tra lại giá hiện tại, nhờ vậy lịch sử không biến động.
    if (dto.teacherId !== undefined && dto.teacherId !== null) {
      const allowance =
        await this.fuelAllowanceTierService.computeForTeacherSchool(
          dto.teacherId,
          session.schoolId,
          session.schoolLocationId,
        );
      session.ratePerPeriod = effectiveRatePerPeriod(
        assignedTeacher,
        allowance.isCompanyTeacher,
      );
      session.distanceToSchoolKm = allowance.distanceToSchoolKm;
      session.gasAllowance = allowance.gasAllowance;
    }

    // Giáo viên xác nhận theo khung giờ cụ thể, đổi giờ là một lịch khác nên
    // phải hỏi lại từ đầu. Đổi giáo viên đã tự reset ở `assign()`, ở đây chỉ
    // lo nhánh giữ nguyên người mà đổi lịch.
    const needsReconfirm =
      timeChanged &&
      dto.teacherId === undefined &&
      session.teacherId != null &&
      session.confirmationStatus !== ConfirmationStatus.PENDING;

    if (needsReconfirm) {
      session.confirmationStatus = ConfirmationStatus.PENDING;
      session.confirmedAt = null;
      session.rejectionReason = null;
      session.confirmationAlertAt = null;
    }

    await this.sessionRepo.save(session);

    if (needsReconfirm) {
      const teacher =
        assignedTeacher ??
        (await this.teacherRepo.findOne({ where: { id: session.teacherId! } }));
      if (teacher) {
        await this.notifyConfirmationRequest(session, teacher, 'rescheduled');
      }
    }

    return this.findOne(id);
  }

  async remove(id: number) {
    const session = await this.getEntity(id);

    // `status` KHÔNG đủ để biết buổi đã được chấm công hay chưa: check-in,
    // check-out và báo giảng của giáo viên không đổi `status`, chỉ Giáo vụ
    // chấm công mới đổi. Xét mỗi `status` thì một buổi đã dạy xong, có ảnh
    // check-in và báo giảng, vẫn xoá được sạch chỉ vì Giáo vụ chưa duyệt.
    if (
      CHECKED_STATUSES.includes(session.status) ||
      session.checkinAt ||
      session.checkoutAt ||
      session.lessonSubmittedAt
    ) {
      throw new ConflictException(
        'Buổi đã có dữ liệu chấm công, không xoá được. Hãy chuyển trạng thái sang "Huỷ buổi" nếu cần.',
      );
    }

    await this.sessionRepo.remove(session);
    return { deleted: true };
  }

  // ==================== CHẤM CÔNG ====================

  async checkAttendance(
    id: number,
    dto: CheckAttendanceDto,
    checkedById: number,
  ) {
    const session = await this.getEntity(id);

    this.applyAttendance(
      session,
      dto.status,
      dto.attendanceNote,
      dto.otherCosts,
      checkedById,
    );

    await this.sessionRepo.save(session);
    return this.findOne(id);
  }

  async applyForSession(
    id: number,
    dto: ApplyTeachingSessionDto,
    employeeId: number,
  ) {
    const teacher = await this.getTeacherByEmployee(employeeId);
    if (!teacher.isActive)
      throw new BadRequestException('Hồ sơ giáo viên đang ngừng hoạt động');

    const session = await this.getSessionWithSchool(id);
    if (session.assignmentStatus !== AssignmentStatus.OPEN) {
      throw new ConflictException('Tiết này không còn mở đăng ký');
    }
    if ((toDateString(session.date) as string) < this.todayDateString()) {
      throw new BadRequestException('Tiết dạy đã qua ngày đăng ký');
    }

    const existing = await this.applicationRepo.findOne({
      where: { sessionId: id, teacherId: teacher.id },
    });
    if (existing && existing.status !== TeachingApplicationStatus.WITHDRAWN) {
      throw new ConflictException('Bạn đã đăng ký tiết dạy này');
    }
    if (await this.hasScheduleConflict(teacher.id, session)) {
      throw new ConflictException(
        'Tiết dạy bị trùng với lịch đã được phân công',
      );
    }

    const quota = await this.weeklyQuota(teacher, session, id);
    const periods = session.periods ?? 1;
    if (
      quota.maxPeriodsPerWeek !== null &&
      quota.assignedPeriodsInWeek + quota.pendingPeriodsInWeek + periods >
        quota.maxPeriodsPerWeek
    ) {
      throw new ConflictException('Vượt quá số tiết tối đa trong tuần');
    }

    const location = await this.calculateApplicationDistance(
      session,
      dto.latitude,
      dto.longitude,
    );
    const application =
      existing ??
      this.applicationRepo.create({
        sessionId: id,
        teacherId: teacher.id,
      });
    Object.assign(application, {
      status: TeachingApplicationStatus.PENDING,
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracy: dto.accuracy ?? null,
      distance: location,
      note: dto.note ?? null,
    });
    const saved = await this.applicationRepo.save(application);
    await this.refreshRecommendedTeacher(id);
    return {
      id: saved.id,
      status: saved.status,
      distance: saved.distance ?? null,
      assignedPeriodsInWeek: quota.assignedPeriodsInWeek,
      pendingPeriodsInWeek: quota.pendingPeriodsInWeek + periods,
      maxPeriodsPerWeek: quota.maxPeriodsPerWeek,
      remainingPeriodsInWeek:
        quota.maxPeriodsPerWeek === null
          ? null
          : Math.max(
              0,
              quota.maxPeriodsPerWeek -
                quota.assignedPeriodsInWeek -
                quota.pendingPeriodsInWeek -
                periods,
            ),
    };
  }

  async withdrawApplication(id: number, employeeId: number) {
    const teacher = await this.getTeacherByEmployee(employeeId);
    const application = await this.applicationRepo.findOne({
      where: { sessionId: id, teacherId: teacher.id },
    });
    if (!application) throw new NotFoundException('Không tìm thấy đăng ký');
    if (application.status !== TeachingApplicationStatus.PENDING) {
      throw new ConflictException('Chỉ được rút đăng ký đang chờ duyệt');
    }
    application.status = TeachingApplicationStatus.WITHDRAWN;
    await this.applicationRepo.save(application);
    await this.refreshRecommendedTeacher(id);
    return { withdrawn: true };
  }

  async suggestions(id: number) {
    const session = await this.getSessionWithSchool(id);
    const applications = await this.applicationRepo.find({
      where: { sessionId: id, status: TeachingApplicationStatus.PENDING },
      relations: ['teacher'],
      order: { createdAt: 'ASC' },
    });

    const items = await Promise.all(
      applications.map(async (application) => {
        const quota = await this.weeklyQuota(application.teacher, session, id);
        return {
          id: application.id,
          sessionId: id,
          teacherId: application.teacherId,
          teacherName: application.teacher.name,
          status: application.status,
          latitude: application.latitude,
          longitude: application.longitude,
          accuracy: application.accuracy ?? null,
          distance: application.distance ?? null,
          hasScheduleConflict: await this.hasScheduleConflict(
            application.teacherId,
            session,
          ),
          ...quota,
          remainingPeriodsInWeek:
            quota.maxPeriodsPerWeek === null
              ? null
              : Math.max(
                  0,
                  quota.maxPeriodsPerWeek -
                    quota.assignedPeriodsInWeek -
                    quota.pendingPeriodsInWeek,
                ),
          appliedAt: application.createdAt.toISOString(),
          note: application.note ?? null,
          isRecommended: session.recommendedTeacherId === application.teacherId,
        };
      }),
    );

    items.sort(
      (a, b) =>
        Number(a.hasScheduleConflict) - Number(b.hasScheduleConflict) ||
        (a.distance ?? Number.MAX_SAFE_INTEGER) -
          (b.distance ?? Number.MAX_SAFE_INTEGER) ||
        a.assignedPeriodsInWeek - b.assignedPeriodsInWeek ||
        a.appliedAt.localeCompare(b.appliedAt),
    );
    return items.map((item, index) => ({ ...item, suggestionRank: index + 1 }));
  }

  async assignTeacher(id: number, dto: AssignTeachingSessionDto) {
    await this.assignTeacherCore(id, dto);
    return this.findOne(id);
  }

  /**
   * Đổi/gán giáo viên cho **nhiều buổi cùng lúc** — màn Chấm công chọn nhiều
   * tiết rồi đổi giáo viên hàng loạt. Buổi nào lỗi bị bỏ qua và báo lại
   * riêng, các buổi còn lại vẫn thực hiện — cùng cách làm với
   * `applyEffectiveRange` của mẫu lịch, một tiết kẹt không nên chặn cả lượt đổi.
   *
   * Tự động **đổi chéo** khi giáo viên đích đang bận đúng khung giờ đó (ví
   * dụ 2 giáo viên dạy song song cùng giờ ở 2 lớp khác nhau — rất phổ biến ở
   * lịch công ty): thay vì chặn 409 "trùng lịch", buổi đang chiếm chỗ của
   * giáo viên đích được đẩy ngược về giáo viên nguồn. Không có buổi nào
   * chiếm chỗ thì chỉ là gán một chiều như cũ.
   */
  async bulkAssignTeacher(dto: BulkAssignTeachingSessionDto) {
    const uniqueIds = [...new Set(dto.sessionIds)];

    const results: {
      sessionId: number;
      status: 'UPDATED' | 'FAILED';
      message?: string;
      swapped?: boolean;
    }[] = [];

    for (const sessionId of uniqueIds) {
      try {
        const swapped = await this.assignOrSwapTeacher(
          sessionId,
          dto.teacherId,
        );
        results.push({ sessionId, status: 'UPDATED', swapped });
      } catch (error) {
        const message =
          (error as any)?.response?.message ??
          (error as Error)?.message ??
          String(error);
        results.push({
          sessionId,
          status: 'FAILED',
          message: Array.isArray(message) ? message.join(', ') : message,
        });
      }
    }

    return {
      total: uniqueIds.length,
      updated: results.filter((r) => r.status === 'UPDATED').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      swapped: results.filter((r) => r.swapped).length,
      results,
    };
  }

  /**
   * Gán 1 buổi cho giáo viên đích; nếu đích đang có buổi khác trùng đúng
   * khung giờ đó thì đẩy buổi đó ngược về giáo viên nguồn trước (đổi chéo)
   * rồi mới gán — tránh báo trùng lịch giả khi bản chất là 2 người tráo chỗ
   * cho nhau. Trả về `true` nếu có đổi chéo, `false` nếu chỉ gán một chiều.
   */
  private async assignOrSwapTeacher(
    id: number,
    targetTeacherId: number,
  ): Promise<boolean> {
    const session = await this.getSessionWithSchool(id);
    if (CHECKED_STATUSES.includes(session.status)) {
      throw new ConflictException(
        'Buổi đã chấm công, không thể đổi giáo viên hoặc đơn giá đã chốt',
      );
    }
    if (session.teacherId === targetTeacherId) return false;

    const targetTeacher = await this.teacherRepo.findOne({
      where: { id: targetTeacherId },
    });
    if (!targetTeacher || !targetTeacher.isActive) {
      throw new BadRequestException(
        'Giáo viên không tồn tại hoặc đã ngừng hoạt động',
      );
    }

    const conflictSession = await this.sessionRepo
      .createQueryBuilder('c')
      .where('c.teacherId = :teacherId', { teacherId: targetTeacherId })
      .andWhere('c.id != :sessionId', { sessionId: id })
      .andWhere('c.date = :date', { date: toDateString(session.date) })
      .andWhere('c.assignmentStatus = :assigned', {
        assigned: AssignmentStatus.ASSIGNED,
      })
      .andWhere('c.status IN (:...statuses)', {
        statuses: ACTIVE_SESSION_STATUSES,
      })
      .andWhere('c.startTime < :endTime', { endTime: session.endTime })
      .andWhere('c.endTime > :startTime', { startTime: session.startTime })
      .getOne();

    if (!conflictSession) {
      await this.assignTeacherCore(id, { teacherId: targetTeacherId });
      return false;
    }

    if (CHECKED_STATUSES.includes(conflictSession.status)) {
      throw new ConflictException(
        `${targetTeacher.name} đang bận buổi khác đã chấm công cùng khung giờ, không đổi chéo được`,
      );
    }

    // Buổi OPEN (chưa có giáo viên) thì không có ai để nhận lại buổi đang
    // chiếm chỗ của giáo viên đích — đây là trùng lịch thật, không tráo được.
    if (session.teacherId == null) {
      throw new ConflictException(
        `${targetTeacher.name} bị trùng lịch dạy đã phân công`,
      );
    }

    const sourceTeacherId = session.teacherId;
    // `override: true` vì lúc này cả 2 buổi tạm thời vẫn đứng tên người cũ —
    // kiểm tra trùng lịch bình thường sẽ thấy đúng cặp đang tráo và chặn
    // nhầm; đã tự xác định đây là tráo chỗ hợp lệ ở bước tìm `conflictSession`.
    await this.assignTeacherCore(conflictSession.id, {
      teacherId: sourceTeacherId,
      override: true,
    });
    await this.assignTeacherCore(id, {
      teacherId: targetTeacherId,
      override: true,
    });
    return true;
  }

  /** Logic gán/đổi giáo viên cho một buổi — dùng chung bởi `assignTeacher` và `bulkAssignTeacher`. */
  private async assignTeacherCore(
    id: number,
    dto: { teacherId: number; override?: boolean },
  ): Promise<void> {
    const session = await this.getSessionWithSchool(id);
    if (CHECKED_STATUSES.includes(session.status)) {
      throw new ConflictException(
        'Buổi đã chấm công, không thể đổi giáo viên hoặc đơn giá đã chốt',
      );
    }
    const teacher = await this.teacherRepo.findOne({
      where: { id: dto.teacherId },
    });
    if (!teacher || !teacher.isActive)
      throw new BadRequestException(
        'Giáo viên không tồn tại hoặc đã ngừng hoạt động',
      );

    const conflict = await this.hasScheduleConflict(teacher.id, session);
    const quota = await this.weeklyQuota(teacher, session, id);
    const overQuota =
      quota.maxPeriodsPerWeek !== null &&
      quota.assignedPeriodsInWeek + (session.periods ?? 1) >
        quota.maxPeriodsPerWeek;
    if ((conflict || overQuota) && !dto.override) {
      throw new ConflictException({
        message: conflict
          ? 'Giáo viên bị trùng lịch dạy đã phân công'
          : 'Giáo viên vượt quá số tiết tối đa trong tuần',
        requiresOverride: true,
      });
    }

    // Phụ cấp xăng phụ thuộc CHÍNH giáo viên (không như đơn giá môn học) nên
    // phải tính lại mỗi lần gán/đổi giáo viên — buổi OPEN trước đó chưa có ai
    // nên chưa tính được, còn đổi sang giáo viên khác thì khoảng cách cũng
    // đổi theo.
    const { isCompanyTeacher, distanceToSchoolKm, gasAllowance } =
      await this.fuelAllowanceTierService.computeForTeacherSchool(
        teacher.id,
        session.schoolId,
        session.schoolLocationId,
      );
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(TeachingSession).update(id, {
        teacherId: teacher.id,
        assignmentStatus: AssignmentStatus.ASSIGNED,
        recommendedTeacherId: teacher.id,
        // Đơn giá chốt theo giáo viên nên đổi người là chốt lại theo đơn giá
        // mặc định của người mới; gán sang giáo viên công ty thì về null vì họ
        // không nhận theo tiết dù buổi đã chốt giá nào trước đó.
        ratePerPeriod: effectiveRatePerPeriod(teacher, isCompanyTeacher),
        distanceToSchoolKm,
        gasAllowance,
        // Gán giáo viên (mới hoặc đổi người) luôn cần xác nhận lại từ đầu.
        confirmationStatus: ConfirmationStatus.PENDING,
        confirmedAt: null,
        rejectionReason: null,
        confirmationAlertAt: null,
      });
      await manager
        .getRepository(TeachingApplication)
        .createQueryBuilder()
        .update()
        .set({ status: TeachingApplicationStatus.NOT_SELECTED })
        .where('session_id = :id AND status = :pending', {
          id,
          pending: TeachingApplicationStatus.PENDING,
        })
        .execute();
      await manager
        .getRepository(TeachingApplication)
        .update(
          { sessionId: id, teacherId: teacher.id },
          { status: TeachingApplicationStatus.SELECTED },
        );
    });

    const updated = await this.sessionRepo.findOne({ where: { id } });
    if (updated) {
      await this.notifyConfirmationRequest(updated, teacher);
    }
  }

  /**
   * Giáo viên xác nhận hoặc từ chối buổi dạy được giao. Chỉ chính giáo viên
   * đứng tên mới gọi được, và chỉ khi còn PENDING.
   */
  async confirmSession(
    id: number,
    employeeId: number,
    dto: ConfirmTeachingSessionDto,
  ) {
    if (dto.status === ConfirmationStatus.REJECTED && !dto.reason?.trim()) {
      throw new BadRequestException('Vui lòng nhập lý do từ chối');
    }

    const session = await this.dataSource.transaction(async (manager) => {
      const sessionRepo = manager.getRepository(TeachingSession);
      const locked = await sessionRepo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked) throw new NotFoundException('Buổi dạy không tồn tại');

      const teacher = locked.teacherId
        ? await manager
            .getRepository(Teacher)
            .findOne({ where: { id: locked.teacherId } })
        : null;
      if (teacher?.employeeId !== employeeId) {
        throw new ForbiddenException(
          'Bạn không phải giáo viên của buổi dạy này',
        );
      }
      if (locked.confirmationStatus !== ConfirmationStatus.PENDING) {
        throw new ConflictException('Buổi dạy này đã được xử lý');
      }

      locked.confirmationStatus = dto.status;
      locked.confirmedAt = new Date();
      locked.rejectionReason =
        dto.status === ConfirmationStatus.REJECTED ? dto.reason!.trim() : null;
      return sessionRepo.save(locked);
    });
    await this.notifyConfirmationResult(session);
    await this.notificationService.markTeachingSessionConfirmationAsRead(
      employeeId,
      session.id,
    );

    return this.findOne(id);
  }

  /**
   * Giáo viên xin rút khỏi buổi đã phân công vì có việc đột xuất. Khác với
   * `confirmSession(REJECTED)`: đây là buổi đã nhận, không phải từ chối lúc
   * mới giao. Khoá dòng buổi dạy trong transaction để tránh đổi giáo viên
   * (`assignTeacher`) và từ chối chạy chồng nhau gỡ nhầm người vừa được gán.
   */
  async declineSession(
    id: number,
    employeeId: number,
    dto: DeclineTeachingSessionDto,
  ) {
    const { declinedTeacherName } = await this.dataSource.transaction(
      async (manager) => {
        const sessionRepo = manager.getRepository(TeachingSession);
        // Không JOIN giáo viên khi khoá dòng: Postgres cấm FOR UPDATE ở vế
        // nullable của outer join (buổi OPEN không có teacher_id).
        const session = await sessionRepo
          .createQueryBuilder('ss')
          .where('ss.id = :id', { id })
          .setLock('pessimistic_write')
          .getOne();

        if (!session) {
          throw new NotFoundException('Buổi dạy không tồn tại');
        }

        const teacher = session.teacherId
          ? await manager
              .getRepository(Teacher)
              .findOne({ where: { id: session.teacherId } })
          : null;

        if (teacher?.employeeId !== employeeId) {
          throw new ForbiddenException(
            'Bạn không phải giáo viên của buổi dạy này',
          );
        }

        if (
          session.assignmentStatus !== AssignmentStatus.ASSIGNED ||
          session.status !== SessionStatus.SCHEDULED ||
          session.checkinAt ||
          session.declinedAt ||
          (toDateString(session.date) as string) < this.todayDateString()
        ) {
          throw new ConflictException(
            'Buổi dạy này không còn đủ điều kiện từ chối',
          );
        }

        const declinedTeacherName = teacher.name;

        await sessionRepo.update(id, {
          declinedAt: new Date(),
          declineReason: dto.reason.trim(),
          declinedTeacherId: session.teacherId,
          teacherId: null,
          assignmentStatus: AssignmentStatus.OPEN,
          confirmationStatus: ConfirmationStatus.PENDING,
          confirmedAt: null,
          rejectionReason: null,
          confirmationAlertAt: null,
        });

        return { declinedTeacherName };
      },
    );

    const updated = await this.findOne(id);
    await this.notifyReplacementRequest(id, declinedTeacherName);
    return updated;
  }

  async checkin(
    id: number,
    dto: CheckinTeachingSessionDto,
    employeeId: number,
    file?: Express.Multer.File,
  ) {
    const session = await this.sessionRepo.findOne({
      where: { id },
      relations: ['teacher', 'school', 'schoolLocation'],
    });

    if (!session) {
      throw new NotFoundException('Buổi dạy không tồn tại');
    }

    if (!session.teacher || session.teacher.employeeId !== employeeId) {
      throw new ForbiddenException('Bạn không phải giáo viên của buổi dạy này');
    }

    if (session.checkinAt) {
      throw new ConflictException('Buổi này đã check-in');
    }

    const sessionDate = toDateString(session.date) as string;
    const daySessions = await this.loadDaySessions(
      session.teacher.id,
      sessionDate,
    );
    const flags = computeDayBlocks(daySessions).get(session.id);
    if (flags && !flags.checkinRequired) {
      throw new HttpException(
        {
          statusCode: 400,
          code: 'TEACHING_SESSION_CHECKIN_NOT_REQUIRED',
          message: 'Tiết này không cần check-in',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (sessionDate !== this.todayDateString()) {
      throw new BadRequestException('Chỉ được check-in trong ngày dạy');
    }

    if (!file) {
      throw new HttpException(
        {
          statusCode: 400,
          code: 'TEACHING_SESSION_CHECKIN_IMAGE_REQUIRED',
          message: 'Vui lòng chụp ảnh khi check-in',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!file.mimetype?.startsWith('image/')) {
      throw new HttpException(
        {
          statusCode: 415,
          code: 'TEACHING_SESSION_CHECKIN_IMAGE_TYPE_UNSUPPORTED',
          message: 'Check-in chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP',
        },
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }

    const { distance, outOfRange } = await this.calculatePunchLocation(
      session,
      dto,
    );

    const checkinImages = await this.lessonImageStorage.storeMany([file]);

    try {
      await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(TeachingSession);
        const locked = await repository.findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) throw new NotFoundException('Buổi dạy không tồn tại');
        if (locked.checkinAt) {
          throw new ConflictException('Buổi này đã check-in');
        }

        locked.checkinAt = new Date();
        locked.checkinLatitude = dto.latitude;
        locked.checkinLongitude = dto.longitude;
        locked.checkinAccuracy = null;
        locked.checkinDistance = distance;
        locked.checkinOutOfRange = outOfRange;
        locked.checkinImages = checkinImages;
        await repository.save(locked);
      });
    } catch (error) {
      await this.lessonImageStorage
        .removeMany(checkinImages)
        .catch(() => undefined);
      throw error;
    }
    return this.findOne(id);
  }

  async checkout(
    id: number,
    dto: CheckoutTeachingSessionDto,
    employeeId: number,
    files: Express.Multer.File[] = [],
    requestId?: string,
  ) {
    const trace: CheckoutTrace = {
      requestId: requestId || randomUUID(),
      sessionId: id,
      employeeId,
      teacherId: null,
      imageCount: files.length,
    };

    const currentTeacher = await this.teacherRepo.findOne({
      where: { employeeId },
    });
    if (!currentTeacher) {
      const error = new HttpException(
        {
          statusCode: 404,
          code: 'TEACHER_PROFILE_NOT_FOUND',
          message: 'Không tìm thấy hồ sơ giáo viên',
        },
        HttpStatus.NOT_FOUND,
      );
      this.logCheckoutFailure(trace, error);
      throw error;
    }
    trace.teacherId = currentTeacher.id;

    try {
      await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(TeachingSession);
        const session = await repository.findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });

        if (!session) throw new NotFoundException('Buổi dạy không tồn tại');
        if (session.teacherId !== currentTeacher.id) {
          throw new HttpException(
            {
              statusCode: 403,
              code: 'TEACHING_SESSION_NOT_ASSIGNED',
              message: 'Bạn không phải giáo viên của buổi dạy này',
            },
            HttpStatus.FORBIDDEN,
          );
        }
        if (
          session.status === SessionStatus.CANCELLED ||
          session.assignmentStatus === AssignmentStatus.CANCELLED
        ) {
          throw new HttpException(
            {
              statusCode: 400,
              code: 'TEACHING_SESSION_CANCELLED',
              message: 'Buổi dạy đã bị huỷ',
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        if (session.checkoutAt) {
          throw new HttpException(
            {
              statusCode: 409,
              code: 'TEACHING_SESSION_ALREADY_CHECKED_OUT',
              message: 'Buổi này đã check-out',
            },
            HttpStatus.CONFLICT,
          );
        }

        const daySessions = await this.loadDaySessions(
          currentTeacher.id,
          toDateString(session.date) as string,
          manager,
        );
        const flags = computeDayBlocks(daySessions).get(session.id) ?? {
          checkinRequired: true,
          checkoutRequired: true,
        };
        // Trước đây chỉ tiết cuối block được check-out. Giờ tiết nào cũng
        // tự check-out trực tiếp được, để giáo viên báo giảng ngay sau khi
        // dạy xong đúng tiết đó thay vì đợi hết cả block — nên không còn xét
        // `checkinRequired` của riêng tiết này (chỉ đúng cho tiết đầu), mà
        // xét cả block đã có ai check-in chưa.
        if (!session.checkinAt && !isBlockCheckedIn(daySessions, session.id)) {
          throw new HttpException(
            {
              statusCode: 400,
              code: 'TEACHING_SESSION_NOT_CHECKED_IN',
              message: 'Buổi dạy chưa check-in',
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        if ((toDateString(session.date) as string) !== this.todayDateString()) {
          throw new BadRequestException('Chỉ được check-out trong ngày dạy');
        }

        const school = await manager.getRepository(School).findOne({
          where: { id: session.schoolId },
        });
        if (!school) throw new NotFoundException('Trường học không tồn tại');
        session.school = school;

        if (session.schoolLocationId) {
          const location = await manager.getRepository(SchoolLocation).findOne({
            where: { id: session.schoolLocationId },
          });
          if (location) {
            session.schoolLocation = location;
          }
        }

        const { distance, outOfRange } = await this.calculatePunchLocation(
          session,
          dto,
          manager,
        );
        const checkoutAt = new Date();

        // Vẫn giữ logic cũ: check-out tiết CUỐI đóng luôn cả block — tiết
        // nào trong block chưa tự check-out thì "ăn theo" tiết cuối, đánh dấu
        // checkoutViaAdjacent để phân biệt với tiết giáo viên tự bấm check-out
        // riêng (không đụng tới tiết đã tự check-out từ trước).
        if (flags.checkoutRequired) {
          const blockIds = sessionBlockIds(daySessions, session.id);
          const cascadeIds = blockIds.filter((blockId) => {
            if (blockId === session.id) return false;
            const blockSession = daySessions.find((s) => s.id === blockId);
            return !blockSession?.checkoutAt;
          });
          if (cascadeIds.length) {
            await repository.update(
              { id: In(cascadeIds) },
              { checkoutAt, checkoutViaAdjacent: true },
            );
          }
        }
        session.checkoutAt = checkoutAt;
        session.checkoutLatitude = dto.latitude;
        session.checkoutLongitude = dto.longitude;
        session.checkoutAccuracy = dto.accuracy ?? null;
        session.checkoutDistance = distance;
        session.checkoutOutOfRange = outOfRange;
        session.checkoutViaAdjacent = false;
        await repository.save(session);
      });
    } catch (error) {
      this.logCheckoutFailure(trace, error);
      if (!(error instanceof HttpException)) {
        throw new HttpException(
          {
            statusCode: 500,
            code: 'TEACHING_SESSION_CHECKOUT_SAVE_FAILED',
            message: 'Không thể lưu thông tin check-out',
            requestId: trace.requestId,
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      throw error;
    }
    return this.findOne(id);
  }

  /** Báo giảng cho từng tiết sau khi block đã chấm công, hạn 08:00 hôm sau. */
  async submitLesson(
    id: number,
    dto: SubmitLessonDto,
    employeeId: number,
    files: Express.Multer.File[] = [],
    requestId?: string,
  ) {
    const trace: CheckoutTrace = {
      requestId: requestId || randomUUID(),
      sessionId: id,
      employeeId,
      teacherId: null,
      imageCount: files.length,
    };

    const currentTeacher = await this.teacherRepo.findOne({
      where: { employeeId },
    });
    if (!currentTeacher) {
      const error = new HttpException(
        {
          statusCode: 404,
          code: 'TEACHER_PROFILE_NOT_FOUND',
          message: 'Không tìm thấy hồ sơ giáo viên',
        },
        HttpStatus.NOT_FOUND,
      );
      this.logCheckoutFailure(trace, error);
      throw error;
    }
    trace.teacherId = currentTeacher.id;

    if (!files.length) {
      const error = new HttpException(
        {
          statusCode: 400,
          code: 'TEACHING_SESSION_LESSON_EVIDENCE_REQUIRED',
          message: 'Vui lòng tải lên ít nhất một ảnh hoặc video minh chứng',
        },
        HttpStatus.BAD_REQUEST,
      );
      this.logCheckoutFailure(trace, error);
      throw error;
    }

    let lessonImages: LessonImage[];
    try {
      lessonImages = await this.lessonImageStorage.storeMany(files);
    } catch (error) {
      this.logCheckoutFailure(trace, error);
      throw error;
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(TeachingSession);
        const session = await repository.findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });

        if (!session) throw new NotFoundException('Buổi dạy không tồn tại');
        if (session.teacherId !== currentTeacher.id) {
          throw new HttpException(
            {
              statusCode: 403,
              code: 'TEACHING_SESSION_NOT_ASSIGNED',
              message: 'Bạn không phải giáo viên của buổi dạy này',
            },
            HttpStatus.FORBIDDEN,
          );
        }
        if (
          session.status === SessionStatus.CANCELLED ||
          session.assignmentStatus === AssignmentStatus.CANCELLED
        ) {
          throw new HttpException(
            {
              statusCode: 400,
              code: 'TEACHING_SESSION_CANCELLED',
              message: 'Buổi dạy đã bị huỷ',
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        if (!session.checkoutAt) {
          throw new HttpException(
            {
              statusCode: 400,
              code: 'TEACHING_SESSION_NOT_ATTENDED',
              message: 'Tiết dạy chưa hoàn tất chấm công',
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        if (session.lessonSubmittedAt) {
          throw new HttpException(
            {
              statusCode: 409,
              code: 'TEACHING_SESSION_LESSON_ALREADY_SUBMITTED',
              message: 'Tiết này đã báo giảng',
            },
            HttpStatus.CONFLICT,
          );
        }
        const lessonDeadline = this.lessonReportDeadline(
          toDateString(session.date) as string,
        );
        if (new Date() > lessonDeadline) {
          throw new HttpException(
            {
              statusCode: 400,
              code: 'TEACHING_SESSION_LESSON_DEADLINE_EXPIRED',
              message: 'Đã quá hạn báo giảng lúc 08:00 ngày hôm sau',
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        session.lessonName = dto.lessonName;
        session.lessonEvaluation = dto.lessonEvaluation;
        session.actualStudentCount = dto.actualStudentCount;
        session.lessonImages = lessonImages;
        const submittedAt = new Date();
        session.lessonSubmittedAt = submittedAt;
        await repository.save(session);
        const imageRepository = manager.getRepository(LessonImageEntity);
        const imageRows = lessonImages
          .filter((image) => !image.mimeType.startsWith('video/'))
          .map((image) =>
            imageRepository.create({
              sessionId: session.id,
              url: image.url,
              thumbnailUrl: image.thumbnailUrl!,
              mimeType: image.mimeType,
              sortOrder: image.sortOrder,
              type: LESSON_REPORT_IMAGE_TYPE,
              createdAt: submittedAt,
            }),
          );
        if (imageRows.length) await imageRepository.insert(imageRows);
      });
    } catch (error) {
      await this.lessonImageStorage
        .removeMany(lessonImages)
        .catch((cleanupError) => {
          this.logger.error(
            `nộp bài dọn ảnh thất bại ${JSON.stringify(trace)}`,
            cleanupError instanceof Error
              ? cleanupError.stack
              : String(cleanupError),
          );
        });
      this.logCheckoutFailure(trace, error);
      if (!(error instanceof HttpException)) {
        throw new HttpException(
          {
            statusCode: 500,
            code: 'TEACHING_SESSION_LESSON_SAVE_FAILED',
            message: 'Không thể lưu nội dung bài dạy',
            requestId: trace.requestId,
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      throw error;
    }
    return this.findOne(id);
  }

  /**
   * Log hỏng check-out kèm đủ ngữ cảnh để tra cứu: chỉ id và số lượng, không
   * chạm tới token hay nội dung file.
   */
  private logCheckoutFailure(trace: CheckoutTrace, error: unknown): void {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const response =
      error instanceof HttpException ? error.getResponse() : undefined;
    const code =
      typeof response === 'object' && response !== null
        ? ((response as { code?: string }).code ?? null)
        : null;
    const context = JSON.stringify({ ...trace, status, code });

    if (status >= 500) {
      this.logger.error(
        `checkout thất bại ${context}`,
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }
    // 4xx là lỗi nghiệp vụ: giữ một dòng để đối chiếu với FE, không cần stack.
    this.logger.warn(`checkout bị từ chối ${context}`);
  }

  /** Chấm công nhiều buổi một lần — màn chấm công theo ngày/tuần. */
  async bulkCheckAttendance(dto: BulkCheckAttendanceDto, checkedById: number) {
    const ids = dto.items.map((item) => item.sessionId);
    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length !== ids.length) {
      throw new BadRequestException('Danh sách có sessionId trùng nhau');
    }

    const sessions = await this.sessionRepo.find({
      where: { id: In(uniqueIds) },
    });

    const found = new Map(sessions.map((s) => [s.id, s]));
    const missing = uniqueIds.filter((id) => !found.has(id));

    if (missing.length > 0) {
      throw new NotFoundException(
        `Không tìm thấy buổi dạy: ${missing.join(', ')}`,
      );
    }

    for (const item of dto.items) {
      const session = found.get(item.sessionId)!;
      this.applyAttendance(
        session,
        item.status,
        item.attendanceNote,
        item.otherCosts,
        checkedById,
      );
    }

    await this.sessionRepo.save(sessions);

    return {
      updated: sessions.length,
      sessionIds: uniqueIds,
    };
  }

  /** Bảng tổng hợp công theo giáo viên, gom nhóm dưới database. */
  async attendanceSummary(query: QueryAttendanceSummaryDto) {
    assertDateOrder(
      query.fromDate,
      query.toDate,
      'fromDate phải nhỏ hơn hoặc bằng toDate',
    );

    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.teacher', 't')
      .select([
        'ss.teacherId AS "teacherId"',
        't.name AS "teacherName"',
        'COUNT(*) AS "totalSessions"',
      ])
      .addSelect(
        `COUNT(*) FILTER (WHERE ss.status = '${SessionStatus.PRESENT}')`,
        'present',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ss.status = '${SessionStatus.ABSENT}')`,
        'absent',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ss.status = '${SessionStatus.EXCUSED}')`,
        'excused',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ss.status = '${SessionStatus.CANCELLED}')`,
        'cancelled',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ss.status = '${SessionStatus.SCHEDULED}')`,
        'unchecked',
      )
      .addSelect('COUNT(*) FILTER (WHERE ss.isMakeup = true)', 'makeup')
      .addSelect('COALESCE(SUM(COALESCE(ss.periods, 1)), 0)', 'totalPeriods')
      // Chỉ buổi PRESENT mới tính công: vắng/nghỉ phép/huỷ đều không trả tiền.
      .addSelect(
        `COALESCE(SUM(COALESCE(ss.periods, 1))
                    FILTER (WHERE ss.status = '${SessionStatus.PRESENT}'), 0)`,
        'payablePeriods',
      )
      .addSelect(
        `COALESCE(SUM(ss.ratePerPeriod * COALESCE(ss.periods, 1))
                    FILTER (WHERE ss.status = '${SessionStatus.PRESENT}'), 0)`,
        'payableAmount',
      )
      .addSelect(
        `COALESCE(SUM(ss.otherCostsTotal)
                    FILTER (WHERE ss.status = '${SessionStatus.PRESENT}'), 0)`,
        'otherCostsAmount',
      )
      .addSelect(
        `COALESCE(SUM(
                    COALESCE(ss.ratePerPeriod * COALESCE(ss.periods, 1), 0)
                    + COALESCE(ss.otherCostsTotal, 0)
                ) FILTER (WHERE ss.status = '${SessionStatus.PRESENT}'), 0)`,
        'totalPayableAmount',
      )
      // Buổi đã dạy nhưng chưa khai đơn giá -> tiền đang thiếu, phải báo ra.
      // Giáo viên công ty cố ý không có rate_per_period (nhận phụ cấp xăng
      // thay vào đó) nên loại các buổi đã có gas_allowance khỏi cảnh báo này.
      .addSelect(
        `COUNT(*) FILTER (WHERE ss.status = '${SessionStatus.PRESENT}'
                    AND ss.ratePerPeriod IS NULL
                    AND ss.gasAllowance IS NULL)`,
        'missingRateSessions',
      )
      .where('ss.date >= :fromDate', { fromDate: query.fromDate })
      .andWhere('ss.date <= :toDate', { toDate: query.toDate })
      .groupBy('ss.teacherId')
      .addGroupBy('t.name')
      .orderBy('t.name', 'ASC');

    if (query.teacherId) {
      qb.andWhere('ss.teacherId = :teacherId', { teacherId: query.teacherId });
    }

    if (query.schoolId) {
      qb.andWhere('ss.schoolId = :schoolId', { schoolId: query.schoolId });
    }

    if (query.classId) {
      qb.andWhere('ss.classId = :classId', { classId: query.classId });
    }

    const rows = await qb.getRawMany();
    const { fuelAllowanceByTeacher, distanceKmByTeacher } =
      await this.computeFuelAllowanceByTeacher(query);

    const data = rows.map((row) => {
      const teacherId = Number(row.teacherId);
      const fuelAllowanceAmount = fuelAllowanceByTeacher.get(teacherId) ?? 0;
      const totalDistanceKm = distanceKmByTeacher.get(teacherId) ?? 0;
      const otherCostsAmount = Number(row.otherCostsAmount);
      return {
        teacherId,
        teacherName: row.teacherName,
        totalSessions: Number(row.totalSessions),
        present: Number(row.present),
        absent: Number(row.absent),
        excused: Number(row.excused),
        cancelled: Number(row.cancelled),
        unchecked: Number(row.unchecked),
        makeup: Number(row.makeup),
        totalPeriods: Number(row.totalPeriods),
        payablePeriods: Number(row.payablePeriods),
        payableAmount: Number(row.payableAmount),
        otherCostsAmount,
        // Giáo viên công ty: payableAmount = 0 (không rate_per_period) —
        // phụ cấp xăng thay thế, cộng thêm otherCosts như bình thường.
        fuelAllowanceAmount,
        // Tổng km di chuyển — chỉ tính cho giáo viên công ty (có gasAllowance).
        totalDistanceKm,
        totalPayableAmount:
          Number(row.totalPayableAmount) + fuelAllowanceAmount,
        missingRateSessions: Number(row.missingRateSessions),
      };
    });

    return {
      fromDate: query.fromDate,
      toDate: query.toDate,
      data,
      grandTotal: {
        payablePeriods: data.reduce((sum, row) => sum + row.payablePeriods, 0),
        payableAmount: data.reduce((sum, row) => sum + row.payableAmount, 0),
        otherCostsAmount: data.reduce(
          (sum, row) => sum + row.otherCostsAmount,
          0,
        ),
        fuelAllowanceAmount: data.reduce(
          (sum, row) => sum + row.fuelAllowanceAmount,
          0,
        ),
        totalDistanceKm: data.reduce(
          (sum, row) => sum + row.totalDistanceKm,
          0,
        ),
        totalPayableAmount: data.reduce(
          (sum, row) => sum + row.totalPayableAmount,
          0,
        ),
        missingRateSessions: data.reduce(
          (sum, row) => sum + row.missingRateSessions,
          0,
        ),
      },
    };
  }

  /**
   * Rà soát quãng đường di chuyển của giáo viên công ty: mỗi ngày đi những
   * điểm nào, mỗi chặng bao nhiêu km, phụ cấp xăng bao nhiêu, và những điểm
   * cần kiểm tra lại (không check-in, check-in/check-out ngoài bán kính, lượt
   * không chốt được phụ cấp, chặng không tính được km).
   *
   * Tính cả buổi đã tới ngày mà chưa chấm công (đánh dấu `UNCHECKED`) để thấy
   * đủ lộ trình trước khi chốt. Phần chỉ gồm buổi đã chấm (`checked*`) dùng
   * chung `buildTravelBlocks` với bảng công nên luôn khớp tab Tổng hợp.
   */
  async travelReview(query: QueryTravelReviewDto) {
    assertDateOrder(
      query.fromDate,
      query.toDate,
      'fromDate phải nhỏ hơn hoặc bằng toDate',
    );

    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.teacher', 't')
      .leftJoin('t.employee', 'e')
      .leftJoin('ss.school', 'sc')
      .leftJoin('ss.schoolLocation', 'sl')
      .leftJoin('ss.subject', 'sub')
      .leftJoin('ss.class', 'cl')
      .select([
        'ss.id AS "id"',
        'ss.teacherId AS "teacherId"',
        't.name AS "teacherName"',
        't.latitude AS "teacherLatitude"',
        't.longitude AS "teacherLongitude"',
        'ss.schoolId AS "schoolId"',
        'sc.name AS "schoolName"',
        'sc.latitude AS "schoolLatitude"',
        'sc.longitude AS "schoolLongitude"',
        'ss.schoolLocationId AS "schoolLocationId"',
        'sl.name AS "locationName"',
        'sl.latitude AS "locationLatitude"',
        'sl.longitude AS "locationLongitude"',
        'sub.name AS "subjectName"',
        'cl.name AS "className"',
        'ss.date AS "date"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        'ss.periods AS "periods"',
        'ss.gasAllowance AS "gasAllowance"',
        'ss.distanceToSchoolKm AS "distanceToSchoolKm"',
        'ss.checkinAt AS "checkinAt"',
        'ss.checkinLatitude AS "checkinLatitude"',
        'ss.checkinLongitude AS "checkinLongitude"',
        'ss.checkinAccuracy AS "checkinAccuracy"',
        'ss.checkinDistance AS "checkinDistance"',
        'ss.checkinOutOfRange AS "checkinOutOfRange"',
        'ss.checkoutAt AS "checkoutAt"',
        'ss.checkoutDistance AS "checkoutDistance"',
        'ss.checkoutOutOfRange AS "checkoutOutOfRange"',
        'ss.status AS "status"',
      ])
      .where('ss.date >= :fromDate', { fromDate: query.fromDate })
      .andWhere('ss.date <= :toDate', { toDate: query.toDate })
      // Buổi đã chấm Có mặt + buổi đã tới ngày mà chưa chấm công (giáo viên
      // nhiều khả năng đã đi, chỉ là Nhân sự chưa chấm). Buổi tương lai chưa
      // diễn ra nên không có quãng đường; vắng/nghỉ/huỷ thì không đi.
      .andWhere(
        `(ss.status = :present
          OR (ss.status = :scheduled AND ss.date <= CURRENT_DATE))`,
        {
          present: SessionStatus.PRESENT,
          scheduled: SessionStatus.SCHEDULED,
        },
      )
      // Có phụ cấp = đang được trả tiền xăng; giáo viên công ty mà KHÔNG có
      // phụ cấp là lượt bị sót tiền — cả hai đều phải hiện ra để rà soát.
      .andWhere(
        '(ss.gasAllowance IS NOT NULL OR :staffRole = ANY(e.roles))',
        { staffRole: TEACHER_STAFF_ROLE },
      )
      .orderBy('ss.teacherId', 'ASC')
      .addOrderBy('ss.date', 'ASC')
      .addOrderBy('ss.startTime', 'ASC')
      .addOrderBy('ss.id', 'ASC');

    if (query.teacherId) {
      qb.andWhere('ss.teacherId = :teacherId', { teacherId: query.teacherId });
    }

    const [rawRows, tiers] = await Promise.all([
      qb.getRawMany(),
      this.fuelAllowanceTierService.findAll(),
    ]);
    const rows = rawRows.map((row) => ({
      ...row,
      date: toDateString(row.date) as string,
    }));
    const coordsOf = await this.loadTravelPlaceCoords(rows);
    // Nhà có hiệu lực theo từng ngày (đổi vị trí có hiệu lực từ ngày duyệt) —
    // xem lại tháng cũ phải thấy lộ trình từ nhà cũ, không phải nhà hiện tại.
    const timelines = await this.fuelAllowanceTierService.loadLocationTimelines([
      ...new Set(rows.map((row) => Number(row.teacherId))),
    ]);
    const blocks = buildTravelBlocks(rows, coordsOf);

    // Lộ trình riêng của các buổi ĐÃ chấm công — đúng con số bảng công đang
    // trả (tab Tổng hợp). Phải dựng lại chứ không lọc từ `blocks`: bỏ bớt
    // điểm dừng thì chặng liên trường phía sau cũng đổi điểm xuất phát.
    const checkedTotals = new Map<number, { km: number; fuel: number }>();
    for (const block of buildTravelBlocks(
      rows.filter((row) => row.status === SessionStatus.PRESENT),
      coordsOf,
    )) {
      if (!block.counted) continue;
      const entry = checkedTotals.get(block.teacherId) ?? { km: 0, fuel: 0 };
      entry.km += block.distanceKm ?? 0;
      entry.fuel += block.gasAllowance ?? 0;
      checkedTotals.set(block.teacherId, entry);
    }

    const round2 = (value: number) => Math.round(value * 100) / 100;
    const homeOf = (row: {
      teacherLatitude: unknown;
      teacherLongitude: unknown;
    }): LatLngPoint | null => {
      const lat = this.nullableNumber(row.teacherLatitude);
      const lng = this.nullableNumber(row.teacherLongitude);
      if (lat == null || lng == null || (lat === 0 && lng === 0)) return null;
      return { lat, lng };
    };
    const homeOnDate = (
      row: Record<string, any>,
      date: string,
    ): LatLngPoint | null => {
      const home = homeAtDate(
        timelines.get(Number(row.teacherId)) ?? [],
        { latitude: row.teacherLatitude, longitude: row.teacherLongitude },
        date,
      );
      return homeOf({
        teacherLatitude: home.latitude,
        teacherLongitude: home.longitude,
      });
    };

    type TravelStop = ReturnType<typeof toStop>;
    type TravelDay = {
      date: string;
      /** Nhà có hiệu lực vào ngày này — điểm xuất phát của lộ trình. */
      home: LatLngPoint | null;
      totalDistanceKm: number;
      fuelAllowanceAmount: number;
      stops: TravelStop[];
    };
    type TravelTeacher = {
      teacherId: number;
      teacherName: string;
      home: LatLngPoint | null;
      totalDistanceKm: number;
      fuelAllowanceAmount: number;
      /** Phần đã chấm công — khớp tab Tổng hợp. */
      checkedDistanceKm: number;
      checkedFuelAllowanceAmount: number;
      flaggedStops: number;
      uncheckedSessions: number;
      days: TravelDay[];
    };

    const missingEntries: MissingAllowanceEntry[] = [];
    let needsRecomputeSessions = 0;

    const toStop = (block: (typeof blocks)[number]) => {
      const first = block.rows[0];
      const last = block.rows[block.rows.length - 1];
      const checkinRow = block.rows.find((row) => row.checkinAt);
      const uncheckedCount = block.rows.filter(
        (row) => row.status === SessionStatus.SCHEDULED,
      ).length;
      const flags: string[] = [];
      if (uncheckedCount > 0) flags.push('UNCHECKED');
      // Lượt không có phụ cấp: nói rõ thiếu gì để người dùng bổ sung đúng chỗ.
      const diagnosis = block.counted
        ? null
        : diagnoseGasAllowance({
            teacher: (() => {
              const home = homeOnDate(first, block.date);
              return { latitude: home?.lat ?? null, longitude: home?.lng ?? null };
            })(),
            school: {
              latitude: first.schoolLatitude,
              longitude: first.schoolLongitude,
            },
            location:
              first.schoolLocationId != null
                ? {
                    latitude: first.locationLatitude,
                    longitude: first.locationLongitude,
                  }
                : null,
            tiers,
          });
      if (diagnosis) {
        flags.push('NOT_COUNTED');
        missingEntries.push({
          teacherId: block.teacherId,
          teacherName: String(first.teacherName ?? ''),
          schoolId: Number(first.schoolId),
          schoolName: first.schoolName ?? null,
          schoolLocationId: this.nullableNumber(first.schoolLocationId),
          locationName: first.locationName ?? null,
          diagnosis,
          sessions: block.rows.length,
        });
        // Đủ dữ liệu rồi, chỉ là buổi được tạo trước khi bổ sung → chạy tính lại.
        if (diagnosis.missingReasons.length === 0) {
          needsRecomputeSessions += block.rows.length;
        }
      }
      if (block.counted && block.distanceKm == null) flags.push('NO_DISTANCE');
      if (!checkinRow) flags.push('NO_CHECKIN');
      if (block.rows.some((row) => row.checkinOutOfRange === true)) {
        flags.push('CHECKIN_OUT_OF_RANGE');
      }
      if (block.rows.some((row) => row.checkoutOutOfRange === true)) {
        flags.push('CHECKOUT_OUT_OF_RANGE');
      }

      return {
        placeKey: block.placeKey,
        schoolId: Number(first.schoolId),
        schoolName: first.schoolName as string | null,
        schoolLocationId: this.nullableNumber(first.schoolLocationId),
        locationName: (first.locationName as string | null) ?? null,
        coords: block.coords,
        startTime: first.startTime as string,
        endTime: last.endTime as string,
        periods: block.rows.reduce(
          (sum, row) => sum + (this.nullableNumber(row.periods) ?? 1),
          0,
        ),
        sessions: block.rows.map((row) => ({
          id: Number(row.id),
          startTime: row.startTime as string,
          endTime: row.endTime as string,
          subjectName: (row.subjectName as string | null) ?? null,
          className: (row.className as string | null) ?? null,
        })),
        /** Số tiết trong lượt chưa được chấm công. */
        uncheckedSessions: uncheckedCount,
        counted: block.counted,
        gasAllowance: block.gasAllowance,
        /**
         * Chỉ có ở lượt không có phụ cấp. Rỗng = đã đủ dữ liệu, bấm "Tính lại
         * phụ cấp" là điền được.
         */
        missingReasons: diagnosis?.missingReasons ?? null,
        /** Km nhà → trường tính theo toạ độ hiện tại (để đối chiếu bậc). */
        diagnosedDistanceKm: diagnosis?.distanceToSchoolKm ?? null,
        distanceKm: block.distanceKm,
        distanceSource: block.distanceSource,
        checkin: checkinRow
          ? {
              at: checkinRow.checkinAt as Date,
              latitude: this.nullableNumber(checkinRow.checkinLatitude),
              longitude: this.nullableNumber(checkinRow.checkinLongitude),
              accuracy: this.nullableNumber(checkinRow.checkinAccuracy),
              distanceM: this.nullableNumber(checkinRow.checkinDistance),
            }
          : null,
        flags,
      };
    };

    const byTeacher = new Map<number, TravelTeacher>();
    const teacherEntry = (row: {
      teacherId: unknown;
      teacherName: unknown;
      teacherLatitude: unknown;
      teacherLongitude: unknown;
    }): TravelTeacher => {
      const teacherId = Number(row.teacherId);
      let entry = byTeacher.get(teacherId);
      if (!entry) {
        entry = {
          teacherId,
          teacherName: String(row.teacherName ?? ''),
          home: homeOf(row),
          totalDistanceKm: 0,
          fuelAllowanceAmount: 0,
          checkedDistanceKm: 0,
          checkedFuelAllowanceAmount: 0,
          flaggedStops: 0,
          uncheckedSessions: 0,
          days: [],
        };
        byTeacher.set(teacherId, entry);
      }
      return entry;
    };

    for (const block of blocks) {
      const teacher = teacherEntry(block.rows[0]);
      let day = teacher.days[teacher.days.length - 1];
      if (!day || day.date !== block.date) {
        day = {
          date: block.date,
          home: homeOnDate(block.rows[0], block.date),
          totalDistanceKm: 0,
          fuelAllowanceAmount: 0,
          stops: [],
        };
        teacher.days.push(day);
      }

      const stop = toStop(block);
      day.stops.push(stop);
      if (stop.flags.length > 0) teacher.flaggedStops += 1;
      teacher.uncheckedSessions += stop.uncheckedSessions;
      if (block.counted) {
        day.fuelAllowanceAmount += block.gasAllowance ?? 0;
        day.totalDistanceKm = round2(
          day.totalDistanceKm + (block.distanceKm ?? 0),
        );
      }
    }

    const teachers = [...byTeacher.values()]
      .map((teacher) => {
        // Lượt không tính tiền đi chuỗi riêng nên có thể nằm lệch giờ so với
        // các lượt khác — sắp lại theo giờ để đọc đúng trình tự trong ngày.
        for (const day of teacher.days) {
          day.stops.sort((a, b) => a.startTime.localeCompare(b.startTime));
        }
        teacher.totalDistanceKm = round2(
          teacher.days.reduce((sum, day) => sum + day.totalDistanceKm, 0),
        );
        teacher.fuelAllowanceAmount = teacher.days.reduce(
          (sum, day) => sum + day.fuelAllowanceAmount,
          0,
        );
        const checked = checkedTotals.get(teacher.teacherId);
        teacher.checkedDistanceKm = round2(checked?.km ?? 0);
        teacher.checkedFuelAllowanceAmount = checked?.fuel ?? 0;
        return teacher;
      })
      .sort((a, b) => a.teacherName.localeCompare(b.teacherName, 'vi'));

    return {
      fromDate: query.fromDate,
      toDate: query.toDate,
      teachers,
      /** Việc cần bổ sung để các lượt "Không có phụ cấp" có tiền. */
      missing: buildMissingAllowanceReport(missingEntries),
      /** Buổi đã đủ dữ liệu, chỉ cần bấm tính lại phụ cấp. */
      needsRecomputeSessions,
      grandTotal: {
        totalDistanceKm: round2(
          teachers.reduce((sum, t) => sum + t.totalDistanceKm, 0),
        ),
        fuelAllowanceAmount: teachers.reduce(
          (sum, t) => sum + t.fuelAllowanceAmount,
          0,
        ),
        checkedDistanceKm: round2(
          teachers.reduce((sum, t) => sum + t.checkedDistanceKm, 0),
        ),
        checkedFuelAllowanceAmount: teachers.reduce(
          (sum, t) => sum + t.checkedFuelAllowanceAmount,
          0,
        ),
        flaggedStops: teachers.reduce((sum, t) => sum + t.flaggedStops, 0),
        uncheckedSessions: teachers.reduce(
          (sum, t) => sum + t.uncheckedSessions,
          0,
        ),
      },
    };
  }

  /**
   * Phụ cấp xăng gộp theo MỖI LẦN đến nơi dạy (block: chuỗi tiết liên tiếp
   * trong cùng ngày, cùng giáo viên, cùng ĐỊA ĐIỂM) — không cộng theo từng
   * tiết, tránh trả nhiều lần cho một lượt đi lại.
   *
   * "Cùng địa điểm" xét theo điểm trường nếu buổi có gắn cơ sở: dạy ở hai cơ
   * sở khác nhau của cùng một trường là hai lượt đi lại thật, phải trả hai
   * khoản. Chỉ giáo viên công ty mới có `gasAllowance` nên bảng công của giáo
   * viên cộng tác viên không bị ảnh hưởng.
   */
  private async computeFuelAllowanceByTeacher(
    query: QueryAttendanceSummaryDto,
  ): Promise<{
    fuelAllowanceByTeacher: Map<number, number>;
    distanceKmByTeacher: Map<number, number>;
  }> {
    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      .select([
        'ss.teacherId AS "teacherId"',
        'ss.schoolId AS "schoolId"',
        'ss.schoolLocationId AS "schoolLocationId"',
        'ss.date AS "date"',
        'ss.startTime AS "startTime"',
        'ss.gasAllowance AS "gasAllowance"',
        'ss.distanceToSchoolKm AS "distanceToSchoolKm"',
      ])
      .where('ss.date >= :fromDate', { fromDate: query.fromDate })
      .andWhere('ss.date <= :toDate', { toDate: query.toDate })
      .andWhere('ss.status = :present', { present: SessionStatus.PRESENT })
      .andWhere('ss.gasAllowance IS NOT NULL')
      .orderBy('ss.teacherId', 'ASC')
      .addOrderBy('ss.date', 'ASC')
      .addOrderBy('ss.startTime', 'ASC')
      .addOrderBy('ss.id', 'ASC');

    if (query.teacherId) {
      qb.andWhere('ss.teacherId = :teacherId', { teacherId: query.teacherId });
    }
    if (query.schoolId) {
      qb.andWhere('ss.schoolId = :schoolId', { schoolId: query.schoolId });
    }
    if (query.classId) {
      qb.andWhere('ss.classId = :classId', { classId: query.classId });
    }

    const rows = await qb.getRawMany();
    const coordsOf = await this.loadTravelPlaceCoords(rows);
    const blocks = buildTravelBlocks(
      rows.map((row) => ({ ...row, date: toDateString(row.date) as string })),
      coordsOf,
    );

    const fuelAllowanceByTeacher = new Map<number, number>();
    const distanceKmByTeacher = new Map<number, number>();
    for (const block of blocks) {
      if (!block.counted) continue;
      fuelAllowanceByTeacher.set(
        block.teacherId,
        (fuelAllowanceByTeacher.get(block.teacherId) ?? 0) +
          (block.gasAllowance ?? 0),
      );
      if (block.distanceKm != null) {
        distanceKmByTeacher.set(
          block.teacherId,
          (distanceKmByTeacher.get(block.teacherId) ?? 0) + block.distanceKm,
        );
      }
    }

    return { fuelAllowanceByTeacher, distanceKmByTeacher };
  }

  /**
   * Toạ độ từng điểm dừng (cơ sở nếu có, không thì trường) để nối chặng liên
   * trường. Trả về hàm tra toạ độ theo dòng buổi dạy.
   */
  private async loadTravelPlaceCoords(
    rows: { schoolId: number | string; schoolLocationId: number | string | null }[],
  ): Promise<
    (row: {
      schoolId: number | string;
      schoolLocationId: number | string | null;
    }) => LatLngPoint | null
  > {
    const schoolIds = [...new Set(rows.map((r) => Number(r.schoolId)))];
    const locationIds = [
      ...new Set(
        rows
          .filter((r) => r.schoolLocationId != null)
          .map((r) => Number(r.schoolLocationId)),
      ),
    ];

    const [schools, locations] = await Promise.all([
      schoolIds.length
        ? this.schoolRepo.find({ where: { id: In(schoolIds) } })
        : Promise.resolve([]),
      locationIds.length
        ? this.schoolLocationRepo.find({ where: { id: In(locationIds) } })
        : Promise.resolve([]),
    ]);
    const schoolCoordsById = new Map(
      schools.map((s) => [s.id, { lat: s.latitude, lng: s.longitude }]),
    );
    const locationCoordsById = new Map(
      locations.map((l) => [l.id, { lat: l.latitude, lng: l.longitude }]),
    );

    return (row) => {
      if (row.schoolLocationId != null) {
        const c = locationCoordsById.get(Number(row.schoolLocationId));
        if (c?.lat != null && c?.lng != null) {
          return { lat: Number(c.lat), lng: Number(c.lng) };
        }
      }
      const c = schoolCoordsById.get(Number(row.schoolId));
      if (c?.lat != null && c?.lng != null) {
        return { lat: Number(c.lat), lng: Number(c.lng) };
      }
      return null;
    };
  }

  // ==================== INTERNAL ====================

  private applyAttendance(
    session: TeachingSession,
    status: SessionStatus,
    note: string | undefined,
    otherCosts: CheckAttendanceDto['otherCosts'],
    checkedById: number,
  ) {
    session.status = status;

    if (note !== undefined) {
      session.attendanceNote = note ?? null;
    }

    if (otherCosts !== undefined) {
      session.otherCosts = otherCosts.map((cost) => ({
        name: cost.name.trim(),
        amount: Number(cost.amount),
        note: cost.note?.trim() || null,
      }));
      session.otherCostsTotal = session.otherCosts.reduce(
        (sum, cost) => sum + cost.amount,
        0,
      );
    }

    if (status === SessionStatus.SCHEDULED) {
      // Bỏ chấm -> xoá dấu vết người chấm.
      session.checkedById = null;
      session.checkedAt = null;
      session.otherCosts = [];
      session.otherCostsTotal = 0;
    } else {
      session.checkedById = checkedById;
      session.checkedAt = new Date();
    }
  }

  private async getEntity(id: number): Promise<TeachingSession> {
    const session = await this.sessionRepo.findOne({ where: { id } });

    if (!session) {
      throw new NotFoundException('Buổi dạy không tồn tại');
    }

    return session;
  }

  private buildSessionQuery(
    currentTeacherId?: number,
  ): SelectQueryBuilder<TeachingSession> {
    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      // Buổi OPEN chưa có giáo viên vẫn phải xuất hiện trong response.
      .leftJoin('ss.teacher', 't')
      .leftJoin('ss.recommendedTeacher', 'rt')
      .leftJoin('ss.declinedTeacher', 'dt')
      .innerJoin('ss.school', 'sc')
      .leftJoin('ss.schoolLocation', 'sl')
      // Buổi cũ chưa gắn lớp vẫn phải xuất hiện trong response.
      .leftJoin('ss.class', 'cl')
      .innerJoin('ss.subject', 'sub')
      .leftJoin('ss.checkedBy', 'cb')
      .select([
        'ss.id AS "id"',
        'ss.scheduleId AS "scheduleId"',
        'ss.teacherId AS "teacherId"',
        't.name AS "teacherName"',
        'ss.schoolId AS "schoolId"',
        'sc.name AS "schoolName"',
        'ss.schoolLocationId AS "schoolLocationId"',
        'sl.name AS "locationName"',
        'COALESCE(sl.latitude, sc.latitude) AS "schoolLatitude"',
        'COALESCE(sl.longitude, sc.longitude) AS "schoolLongitude"',
        'COALESCE(sl.checkin_radius, sc.checkin_radius) AS "schoolCheckinRadius"',
        'ss.classId AS "classId"',
        'cl.name AS "className"',
        'cl.gradeLevel AS "classGradeLevel"',
        'cl.studentCount AS "classStudentCount"',
        'ss.subjectId AS "subjectId"',
        'sub.name AS "subjectName"',
        'sub.school_year AS "schoolYear"',
        'ss.date AS "date"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        'ss.periods AS "periods"',
        'ss.ratePerPeriod AS "ratePerPeriod"',
        'ss.distanceToSchoolKm AS "distanceToSchoolKm"',
        'ss.gasAllowance AS "gasAllowance"',
        'ss.assignmentStatus AS "assignmentStatus"',
        'ss.recommendedTeacherId AS "recommendedTeacherId"',
        'rt.name AS "recommendedTeacherName"',
        'ss.status AS "status"',
        'ss.isMakeup AS "isMakeup"',
        'ss.makeupForSessionId AS "makeupForSessionId"',
        'ss.attendanceNote AS "attendanceNote"',
        'ss.otherCosts AS "otherCosts"',
        'ss.otherCostsTotal AS "otherCostsTotal"',
        'ss.checkedById AS "checkedById"',
        'cb.name AS "checkedByName"',
        'ss.checkedAt AS "checkedAt"',
        'ss.checkinAt AS "checkinAt"',
        'ss.checkinLatitude AS "checkinLatitude"',
        'ss.checkinLongitude AS "checkinLongitude"',
        'ss.checkinAccuracy AS "checkinAccuracy"',
        'ss.checkinDistance AS "checkinDistance"',
        'ss.checkinOutOfRange AS "checkinOutOfRange"',
        'ss.checkinImages AS "checkinImages"',
        'ss.checkinAlertAt AS "checkinAlertAt"',
        'ss.checkoutAt AS "checkoutAt"',
        'ss.checkoutLatitude AS "checkoutLatitude"',
        'ss.checkoutLongitude AS "checkoutLongitude"',
        'ss.checkoutAccuracy AS "checkoutAccuracy"',
        'ss.checkoutDistance AS "checkoutDistance"',
        'ss.checkoutOutOfRange AS "checkoutOutOfRange"',
        'ss.checkoutViaAdjacent AS "checkoutViaAdjacent"',
        'ss.lessonName AS "lessonName"',
        'ss.lessonEvaluation AS "lessonEvaluation"',
        'ss.lessonImages AS "lessonImages"',
        'ss.actualStudentCount AS "actualStudentCount"',
        'ss.lessonSubmittedAt AS "lessonSubmittedAt"',
        'ss.lessonReportAlertAt AS "lessonReportAlertAt"',
        'ss.note AS "note"',
        'ss.confirmationStatus AS "confirmationStatus"',
        'ss.confirmedAt AS "confirmedAt"',
        'ss.rejectionReason AS "rejectionReason"',
        'ss.declinedAt AS "declinedAt"',
        'ss.declineReason AS "declineReason"',
        'ss.declinedTeacherId AS "declinedTeacherId"',
        'dt.name AS "declinedTeacherName"',
      ])
      .addSelect(
        `(SELECT COUNT(*) FROM teaching_session_applications app
                WHERE app.session_id = ss.id AND app.status = 'PENDING')`,
        'applicationCount',
      );

    if (currentTeacherId) {
      qb.addSelect(
        `(SELECT app.status FROM teaching_session_applications app
                WHERE app.session_id = ss.id AND app.teacher_id = :currentTeacherId
                LIMIT 1)`,
        'myApplicationStatus',
      ).setParameter('currentTeacherId', currentTeacherId);
    }
    return qb;
  }

  private applyFilters(
    qb: SelectQueryBuilder<TeachingSession>,
    query: QueryTeachingSessionsDto,
  ) {
    if (query.teacherId) {
      qb.andWhere('ss.teacherId = :teacherId', { teacherId: query.teacherId });
    }
    if (query.schoolId) {
      qb.andWhere('ss.schoolId = :schoolId', { schoolId: query.schoolId });
    }
    if (query.provinceId) {
      // Buổi dạy không giữ khu vực; khu vực là của trường → xã/phường → tỉnh.
      // Dùng leftJoin để trường chưa gắn xã/phường bị loại theo đúng điều kiện
      // WHERE, thay vì âm thầm đổi ngữ nghĩa của các truy vấn khác.
      qb.leftJoin('sc.ward', 'wd').andWhere('wd.province_id = :provinceId', {
        provinceId: query.provinceId,
      });
    }
    if (query.classId) {
      qb.andWhere('ss.classId = :classId', { classId: query.classId });
    }
    if (query.subjectId) {
      qb.andWhere('ss.subjectId = :subjectId', { subjectId: query.subjectId });
    }
    if (query.scheduleId) {
      qb.andWhere('ss.scheduleId = :scheduleId', {
        scheduleId: query.scheduleId,
      });
    }
    if (query.status) {
      qb.andWhere('ss.status = :status', { status: query.status });
    }
    if (query.unchecked) {
      qb.andWhere('ss.status = :scheduledStatus', {
        scheduledStatus: SessionStatus.SCHEDULED,
      });
    }
    if (query.fromDate) {
      qb.andWhere('ss.date >= :fromDate', { fromDate: query.fromDate });
    }
    if (query.toDate) {
      qb.andWhere('ss.date <= :toDate', { toDate: query.toDate });
    }

    return qb;
  }

  private toSessionItem(row: Record<string, any>) {
    const date = toDateString(row.date) as string;
    const dayOfWeek = dayOfWeekOf(date);

    return {
      id: Number(row.id),
      scheduleId: row.scheduleId === null ? null : Number(row.scheduleId),
      teacherId: this.nullableNumber(row.teacherId),
      teacherName: row.teacherName ?? null,
      schoolId: Number(row.schoolId),
      schoolName: row.schoolName,
      // Điểm trường của buổi dạy; null = trường không chia cơ sở. Toạ độ bên
      // dưới đã COALESCE sẵn về điểm trường (nếu có) trong buildSessionQuery.
      schoolLocationId: this.nullableNumber(row.schoolLocationId),
      locationName: row.locationName ?? null,
      schoolLatitude: this.nullableNumber(row.schoolLatitude),
      schoolLongitude: this.nullableNumber(row.schoolLongitude),
      schoolCheckinRadius: this.nullableNumber(row.schoolCheckinRadius),
      classId: this.nullableNumber(row.classId),
      className: row.className ?? null,
      classGradeLevel: this.nullableNumber(row.classGradeLevel),
      classStudentCount: this.nullableNumber(row.classStudentCount),
      subjectId: Number(row.subjectId),
      subjectName: row.subjectName,
      schoolYear: row.schoolYear ?? null,
      date,
      dayOfWeek,
      dayOfWeekLabel: DAY_OF_WEEK_LABELS[dayOfWeek] ?? null,
      startTime: toDisplayTime(row.startTime),
      endTime: toDisplayTime(row.endTime),
      periods: this.nullableNumber(row.periods),
      ratePerPeriod: this.nullableNumber(row.ratePerPeriod),
      // Tiền công của buổi này; null khi chưa khai đơn giá.
      amount: amountOf(
        this.nullableNumber(row.ratePerPeriod),
        this.nullableNumber(row.periods),
      ),
      // Chỉ có ở giáo viên công ty — khoảng cách/phụ cấp xăng chốt lúc gán
      // giáo viên. null = giáo viên cộng tác viên, chưa có vị trí, hoặc
      // chưa gán giáo viên.
      distanceToSchoolKm: this.nullableNumber(row.distanceToSchoolKm),
      gasAllowance: this.nullableNumber(row.gasAllowance),
      assignmentStatus: row.assignmentStatus,
      recommendedTeacherId: this.nullableNumber(row.recommendedTeacherId),
      recommendedTeacherName: row.recommendedTeacherName ?? null,
      applicationCount: Number(row.applicationCount ?? 0),
      myApplicationStatus: row.myApplicationStatus ?? null,
      hasApplied: Boolean(row.myApplicationStatus),
      status: row.status,
      statusLabel: SESSION_STATUS_LABELS[row.status as SessionStatus] ?? null,
      isMakeup: Boolean(row.isMakeup),
      makeupForSessionId:
        row.makeupForSessionId === null ? null : Number(row.makeupForSessionId),
      attendanceNote: row.attendanceNote ?? null,
      otherCosts: Array.isArray(row.otherCosts) ? row.otherCosts : [],
      otherCostsTotal: this.nullableNumber(row.otherCostsTotal) ?? 0,
      totalAmount:
        (amountOf(
          this.nullableNumber(row.ratePerPeriod),
          this.nullableNumber(row.periods),
        ) ?? 0) + (this.nullableNumber(row.otherCostsTotal) ?? 0),
      checkedById: row.checkedById === null ? null : Number(row.checkedById),
      checkedByName: row.checkedByName ?? null,
      checkedAt: row.checkedAt ? new Date(row.checkedAt).toISOString() : null,
      // Tiết "ăn theo" check-out của tiết cuối block (checkoutViaAdjacent)
      // không có checkinAt riêng dù chắc chắn đã dạy (mới check-out được) —
      // mặc định coi là đã check-in tại đúng thời điểm check-out để không
      // hiện nhầm "chưa check-in" trên bảng chấm công.
      checkinAt: row.checkinAt
        ? new Date(row.checkinAt).toISOString()
        : row.checkoutAt
          ? new Date(row.checkoutAt).toISOString()
          : null,
      checkinLatitude: this.nullableNumber(row.checkinLatitude),
      checkinLongitude: this.nullableNumber(row.checkinLongitude),
      checkinAccuracy: this.nullableNumber(row.checkinAccuracy),
      checkinDistance: this.nullableNumber(row.checkinDistance),
      checkinOutOfRange: row.checkinOutOfRange ?? false,
      checkinImages: this.lessonImageStorage
        ? this.lessonImageStorage.publicItems(row.checkinImages ?? [])
        : (row.checkinImages ?? []),
      // Đã bắn báo động "chưa check-in" cho Giáo vụ / Nhân sự hay chưa.
      checkinAlertAt: row.checkinAlertAt
        ? new Date(row.checkinAlertAt).toISOString()
        : null,
      checkoutAt: row.checkoutAt
        ? new Date(row.checkoutAt).toISOString()
        : null,
      checkoutLatitude: this.nullableNumber(row.checkoutLatitude),
      checkoutLongitude: this.nullableNumber(row.checkoutLongitude),
      checkoutAccuracy: this.nullableNumber(row.checkoutAccuracy),
      checkoutDistance: this.nullableNumber(row.checkoutDistance),
      checkoutOutOfRange: row.checkoutOutOfRange ?? false,
      // true = check-out của tiết này "ăn theo" tiết cuối cùng block, không
      // phải giáo viên tự bấm check-out cho đúng tiết này.
      checkoutViaAdjacent: row.checkoutViaAdjacent ?? false,
      lessonName: row.lessonName ?? null,
      lessonEvaluation: row.lessonEvaluation ?? null,
      actualStudentCount: this.nullableNumber(row.actualStudentCount),
      lessonSubmittedAt: row.lessonSubmittedAt
        ? new Date(row.lessonSubmittedAt).toISOString()
        : null,
      lessonReportDueAt: row.date
        ? this.lessonReportDeadline(
            toDateString(row.date) as string,
          ).toISOString()
        : null,
      lessonImages: this.lessonImageStorage
        ? this.lessonImageStorage.publicItems(row.lessonImages ?? [])
        : (row.lessonImages ?? []),
      note: row.note ?? null,
      confirmationStatus: row.confirmationStatus,
      confirmedAt: row.confirmedAt
        ? new Date(row.confirmedAt).toISOString()
        : null,
      rejectionReason: row.rejectionReason ?? null,
      declinedAt: row.declinedAt
        ? new Date(row.declinedAt).toISOString()
        : null,
      declineReason: row.declineReason ?? null,
      declinedTeacherName: row.declinedTeacherName ?? null,
      // Mặc định buổi lẻ (không thuộc block nhiều tiết): cần cả check-in lẫn
      // check-out. `enrichWithBlockFlags` ghi đè khi buổi này nằm trong một
      // block nhiều tiết liên tiếp cùng trường.
      checkinRequired: true,
      checkoutRequired: true,
    };
  }

  /**
   * Ghi đè `checkinRequired`/`checkoutRequired` cho các buổi thuộc block
   * nhiều tiết liên tiếp cùng BUỔI và ĐỊA ĐIỂM (trường, hoặc điểm trường nếu có) —
   * chỉ tính khi thực sự cần (gọi từ
   * `findOne` luôn, từ `findAll`/`findMine` khi caller yêu cầu) vì phải truy
   * vấn thêm cả ngày dạy của từng giáo viên xuất hiện trong kết quả.
   */
  private async enrichWithBlockFlags<
    T extends { id: number; teacherId: number | null; date: string },
  >(items: T[]): Promise<Array<T & DayBlockFlags>> {
    const pairs = new Map<string, { teacherId: number; date: string }>();
    for (const item of items) {
      if (item.teacherId === null) continue;
      pairs.set(`${item.teacherId}|${item.date}`, {
        teacherId: item.teacherId,
        date: item.date,
      });
    }

    const flagsBySessionId = new Map<number, DayBlockFlags>();
    for (const { teacherId, date } of pairs.values()) {
      const daySessions = await this.loadDaySessions(teacherId, date);
      for (const [sessionId, flags] of computeDayBlocks(daySessions)) {
        flagsBySessionId.set(sessionId, flags);
      }
    }

    return items.map((item) => {
      const flags = flagsBySessionId.get(item.id);
      return {
        ...item,
        checkinRequired: flags?.checkinRequired ?? true,
        checkoutRequired: flags?.checkoutRequired ?? true,
      };
    });
  }

  private nullableNumber(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }

  private lessonReportDeadline(date: string): Date {
    const deadline = new Date(`${date}T08:00:00+07:00`);
    deadline.setUTCDate(deadline.getUTCDate() + 1);
    return deadline;
  }

  private assertAssignment(
    status: AssignmentStatus,
    teacherId?: number | null,
  ): void {
    if (status === AssignmentStatus.OPEN && teacherId) {
      throw new BadRequestException('Tiết đang mở không thể có teacherId');
    }
    if (status === AssignmentStatus.ASSIGNED && !teacherId) {
      throw new BadRequestException('Tiết đã phân công phải có teacherId');
    }
  }

  // ================= NHẮC BÁO GIẢNG (19:00 NGÀY DẠY) =================

  @Cron('0 19 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleMissingLessonReports() {
    // dev (sales-be) và prod chạy chung DB, mỗi process tự đăng ký cron
    // riêng — không chặn thì nhắc bị gửi trùng mỗi ngày. Xem is-cron-leader.ts.
    if (!isCronLeader()) return;
    try {
      const result = await this.runMissingLessonReportAlerts();
      if (result.sessions) {
        this.logger.warn(
          `Nhắc báo giảng: ${result.sessions} tiết, ${result.teachers} giáo viên`,
        );
      }
    } catch (error) {
      this.logger.error('Job nhắc báo giảng lỗi', error as any);
    }
  }

  async runMissingLessonReportAlerts(now = new Date()) {
    const date = this.todayDateString(now);
    const rows = await this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.teacher', 'teacher')
      .innerJoin('ss.school', 'sc')
      .leftJoin('ss.class', 'cl')
      .innerJoin('ss.subject', 'sub')
      .select([
        'ss.id AS "id"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        'teacher.employeeId AS "employeeId"',
        'teacher.name AS "teacherName"',
        'sc.name AS "schoolName"',
        'cl.name AS "className"',
        'sub.name AS "subjectName"',
      ])
      .where('ss.date = :date', { date })
      .andWhere('ss.checkoutAt IS NOT NULL')
      .andWhere('ss.lessonSubmittedAt IS NULL')
      .andWhere('ss.lessonReportAlertAt IS NULL')
      .andWhere('ss.status != :cancelled', {
        cancelled: SessionStatus.CANCELLED,
      })
      .orderBy('teacher.employeeId', 'ASC')
      .addOrderBy('ss.startTime', 'ASC')
      .getRawMany();

    if (!rows.length) return { sessions: 0, teachers: 0 };

    await this.sessionRepo.update(
      { id: In(rows.map((row) => Number(row.id))) },
      { lessonReportAlertAt: now },
    );

    type LessonReportSessionRow = {
      id: number;
      teacherName: string;
      startTime: string;
      endTime: string;
      schoolName: string;
      className: string | null;
      subjectName: string;
    };
    const lessonReportLine = (s: LessonReportSessionRow) => {
      const place = [s.className, s.schoolName].filter(Boolean).join(', ');
      return (
        `${s.startTime}–${s.endTime}` +
        `${s.subjectName ? ` môn ${s.subjectName}` : ''}` +
        `${place ? ` tại ${place}` : ''}`
      );
    };

    const parsedRows: LessonReportSessionRow[] = rows.map((row) => ({
      id: Number(row.id),
      teacherName: (row.teacherName as string) ?? 'Giáo viên',
      startTime: toDisplayTime(row.startTime) as string,
      endTime: toDisplayTime(row.endTime) as string,
      schoolName: (row.schoolName as string) ?? '',
      className: (row.className as string) ?? null,
      subjectName: (row.subjectName as string) ?? '',
    }));

    const byTeacher = new Map<
      number,
      { name: string; sessions: LessonReportSessionRow[] }
    >();
    rows.forEach((row, index) => {
      const employeeId = Number(row.employeeId);
      if (!employeeId) return;
      const entry = byTeacher.get(employeeId) ?? {
        name: parsedRows[index].teacherName,
        sessions: [],
      };
      entry.sessions.push(parsedRows[index]);
      byTeacher.set(employeeId, entry);
    });

    for (const [employeeId, { sessions }] of byTeacher) {
      const sessionIds = sessions.map((s) => s.id);
      const message =
        sessions.length === 1
          ? `Bạn chưa báo giảng cho tiết ${lessonReportLine(sessions[0])}. Hạn hoàn thành trước 08:00 sáng mai.`
          : `Bạn còn ${sessions.length} tiết chưa báo giảng hôm nay:\n` +
            sessions.map((s) => `• ${lessonReportLine(s)}`).join('\n') +
            `\nHạn hoàn thành trước 08:00 sáng mai.`;
      const meta = {
        kind: TEACHING_LESSON_REPORT_ALERT_KIND,
        module: TEACHING_MODULE,
        route: TEACHING_LESSON_REPORT_ROUTE,
        url: TEACHING_LESSON_REPORT_URL,
        date,
        sessionIds,
        sessions,
      };
      const pushData = {
        kind: TEACHING_LESSON_REPORT_ALERT_KIND,
        module: TEACHING_MODULE,
        route: TEACHING_LESSON_REPORT_ROUTE,
        url: TEACHING_LESSON_REPORT_URL,
        date,
        sessionIds: JSON.stringify(sessionIds),
      };
      await this.notificationService.create({
        receiverId: employeeId,
        type: NotificationType.TEACHING_LESSON_REPORT_ALERT,
        message,
        meta,
      });
      const tokens = await this.employeeFcmTokenService.getTokens([employeeId]);
      if (tokens.length) {
        await this.fcmService.sendToMultiple(
          tokens.map((token) => token.token),
          TEACHING_LESSON_REPORT_ALERT_TITLE,
          message,
          pushData,
        );
      }
    }

    // Báo thêm cho Giáo vụ/Nhân sự — 1 thông báo tổng hợp, không lặp theo
    // từng giáo viên, giống cách báo động chưa check-in đang làm.
    const managerMessage = this.buildLessonReportManagerMessage(
      parsedRows,
      byTeacher.size,
    );
    const managers = await this.findTeachingManagers();
    const managerIds = managers.map((m) => m.id);
    const managerMeta = {
      kind: TEACHING_LESSON_REPORT_ALERT_KIND,
      module: TEACHING_MODULE,
      route: TEACHING_LESSON_REPORT_MANAGER_ROUTE,
      url: TEACHING_LESSON_REPORT_MANAGER_URL,
      date,
      teacherCount: byTeacher.size,
      sessions: parsedRows,
    };
    for (const receiverId of managerIds) {
      await this.notificationService.create({
        receiverId,
        type: NotificationType.TEACHING_LESSON_REPORT_ALERT,
        message: managerMessage,
        meta: managerMeta,
      });
    }
    if (managerIds.length) {
      const managerTokens =
        await this.employeeFcmTokenService.getTokens(managerIds);
      if (managerTokens.length) {
        await this.fcmService.sendToMultiple(
          managerTokens.map((token) => token.token),
          TEACHING_LESSON_REPORT_ALERT_MANAGER_TITLE,
          managerMessage,
          {
            kind: TEACHING_LESSON_REPORT_ALERT_KIND,
            module: TEACHING_MODULE,
            route: TEACHING_LESSON_REPORT_MANAGER_ROUTE,
            url: TEACHING_LESSON_REPORT_MANAGER_URL,
          },
        );
      }
    }

    return { sessions: rows.length, teachers: byTeacher.size };
  }

  private buildLessonReportManagerMessage(
    rows: Array<{
      teacherName: string;
      startTime: string;
      endTime: string;
      schoolName: string;
      className: string | null;
      subjectName: string;
    }>,
    teacherCount: number,
  ): string {
    const line = (s: (typeof rows)[number]) => {
      const place = [s.className, s.schoolName].filter(Boolean).join(', ');
      return (
        `${s.startTime}–${s.endTime} ${s.teacherName}` +
        `${s.subjectName ? ` – môn ${s.subjectName}` : ''}` +
        `${place ? ` – ${place}` : ''}`
      );
    };

    if (teacherCount === 1 && rows.length === 1) {
      return `${rows[0].teacherName} còn 1 tiết chưa báo giảng hôm nay: ${line(rows[0])}. Hạn 08:00 sáng mai.`;
    }

    const label =
      teacherCount === 1
        ? `${rows[0].teacherName} còn ${rows.length} tiết chưa báo giảng hôm nay (hạn 08:00 sáng mai):`
        : `${teacherCount} giáo viên còn ${rows.length} tiết chưa báo giảng hôm nay (hạn 08:00 sáng mai):`;

    return `${label}\n` + rows.map((s) => `• ${line(s)}`).join('\n');
  }

  // ================= BÁO ĐỘNG CHƯA CHECK-IN =================

  /**
   * Quét mỗi phút: buổi dạy sắp tới giờ mà giáo viên chưa check-in thì báo động
   * cho Giáo vụ và Nhân sự.
   *
   * Chạy mỗi phút chứ không phải mỗi 5 phút: cửa sổ báo trước chỉ rộng vài phút,
   * job thưa hơn cửa sổ thì sẽ có buổi rơi đúng khe giữa hai lần chạy.
   */
  @Cron('* * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleMissingCheckinAlerts() {
    // dev (sales-be) và prod chạy chung DB, mỗi process tự đăng ký cron
    // riêng — không chặn thì báo động bị gửi trùng mỗi phút. Xem is-cron-leader.ts.
    if (!isCronLeader()) return;
    try {
      const result = await this.runMissingCheckinAlerts();

      if (result.sessions > 0) {
        this.logger.warn(
          `Báo động chưa check-in: ${result.sessions} buổi, ` +
            `gửi cho ${result.recipients} người`,
        );
      }
    } catch (error) {
      this.logger.error('Job báo động chưa check-in lỗi', error as any);
    }
  }

  /**
   * Tìm các buổi cần báo động và gửi đi. Tách khỏi `@Cron` để gọi tay được
   * (endpoint chạy thử) và để viết test không phải chờ đồng hồ.
   */
  async runMissingCheckinAlerts(now = new Date()) {
    const sessions = await this.findSessionsMissingCheckin(now);

    if (!sessions.length) {
      return { sessions: 0, recipients: 0, zaloSent: 0 };
    }

    const managers = await this.findTeachingManagers();
    const recipients = managers.map((m) => m.id);

    // Đánh dấu trước khi gửi: gửi hỏng thì thà mất một báo động còn hơn cứ mỗi
    // phút lại bắn lại đúng buổi đó cho tới khi hết giờ dạy.
    await this.sessionRepo.update(
      { id: In(sessions.map((s) => s.id)) },
      { checkinAlertAt: now },
    );

    if (!recipients.length) {
      this.logger.warn(
        'Có buổi chưa check-in nhưng chưa có tài khoản Giáo vụ / Nhân sự nào để báo',
      );
      return { sessions: sessions.length, recipients: 0, zaloSent: 0 };
    }

    const message = this.buildCheckinAlertMessage(sessions);
    const meta = {
      kind: TEACHING_CHECKIN_ALERT_KIND,
      module: TEACHING_MODULE,
      route: TEACHING_CHECKIN_ALERT_ROUTE,
      url: TEACHING_CHECKIN_ALERT_URL,
      date: sessions[0].date,
      leadMinutes: TEACHING_CHECKIN_ALERT_LEAD_MINUTES,
      sessionCount: sessions.length,
      // Một buổi thì cho FE mở thẳng buổi đó; nhiều buổi thì mở màn chấm công.
      sessionId: sessions.length === 1 ? sessions[0].id : undefined,
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        teacherId: s.teacherId,
        teacherName: s.teacherName,
        schoolName: s.schoolName,
        className: s.className,
        subjectName: s.subjectName,
        startTime: s.startTime,
        minutesToStart: s.minutesToStart,
      })),
    };

    // Gửi OA trước các kênh realtime/push: socket hoặc Firebase chậm không được
    // phép làm mất cảnh báo Zalo vốn có cửa sổ chỉ vài phút.
    const zaloSent = await this.sendCheckinAlertToZalo(managers, message);

    for (const receiverId of recipients) {
      await this.notificationService.create({
        receiverId,
        type: NotificationType.TEACHING_CHECKIN_ALERT,
        message,
        meta,
      });
    }

    const tokens = await this.employeeFcmTokenService.getTokens(recipients);
    if (tokens.length) {
      await this.fcmService
        .sendToMultiple(
          tokens.map((token) => token.token),
          TEACHING_CHECKIN_ALERT_TITLE,
          message,
          {
            kind: TEACHING_CHECKIN_ALERT_KIND,
            module: TEACHING_MODULE,
            route: TEACHING_CHECKIN_ALERT_ROUTE,
            url: TEACHING_CHECKIN_ALERT_URL,
          },
        )
        .catch((error) =>
          this.logger.error('Gửi push báo động chưa check-in lỗi', error),
        );
    }

    return {
      sessions: sessions.length,
      recipients: recipients.length,
      zaloSent,
    };
  }

  /**
   * Quét định kỳ: buổi dạy còn PENDING xác nhận mà sắp tới trong vòng 1 ngày
   * thì nhắc giáo viên và báo Giáo vụ/Nhân sự. Cửa sổ rộng 24h nên không cần
   * chạy mỗi phút như báo động check-in — 30 phút một lần là đủ sát.
   */
  @Cron('*/30 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleScheduleConfirmationAlerts() {
    // dev (sales-be) và prod chạy chung DB, mỗi process tự đăng ký cron
    // riêng — không chặn thì nhắc bị gửi trùng mỗi 30 phút. Xem is-cron-leader.ts.
    if (!isCronLeader()) return;
    try {
      const result = await this.runScheduleConfirmationAlerts();

      if (result.sessions > 0) {
        this.logger.warn(
          `Nhắc xác nhận lịch dạy: ${result.sessions} buổi, ` +
            `gửi cho ${result.recipients} người`,
        );
      }
    } catch (error) {
      this.logger.error('Job nhắc xác nhận lịch dạy lỗi', error as any);
    }
  }

  /**
   * Tách khỏi `@Cron` để gọi tay được (endpoint chạy thử) và để viết test
   * không phải chờ đồng hồ — cùng cấu trúc với `runMissingCheckinAlerts`.
   */
  async runScheduleConfirmationAlerts(now = new Date()) {
    const sessions = await this.findSessionsPendingConfirmation(now);

    if (!sessions.length) {
      return { sessions: 0, recipients: 0 };
    }

    const managers = await this.findTeachingManagers();
    const managerIds = managers.map((m) => m.id);

    // Đánh dấu trước khi gửi: gửi hỏng thì thà mất một lần nhắc còn hơn cứ mỗi
    // lần job chạy lại bắn lại đúng buổi đó trong suốt cửa sổ 24h.
    await this.sessionRepo.update(
      { id: In(sessions.map((s) => s.id)) },
      { confirmationAlertAt: now },
    );

    const teacherMessage = (s: (typeof sessions)[number]) => {
      const place = [s.className, s.schoolName].filter(Boolean).join(', ');
      return (
        `Buổi dạy ngày ${this.formatVietnameseDate(s.date)} lúc ${s.startTime}–${s.endTime}` +
        `${s.subjectName ? ` môn ${s.subjectName}` : ''}` +
        `${place ? ` tại ${place}` : ''}` +
        ` sắp tới nhưng bạn chưa xác nhận. Vui lòng xác nhận hoặc từ chối sớm.`
      );
    };
    const managerMessage = this.buildConfirmationAlertManagerMessage(sessions);

    const teacherEmployeeIds = [
      ...new Set(
        sessions
          .map((s) => s.teacherEmployeeId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const recipientIds = [...new Set([...teacherEmployeeIds, ...managerIds])];

    for (const s of sessions) {
      if (!s.teacherEmployeeId) continue;
      await this.notificationService.create({
        receiverId: s.teacherEmployeeId,
        type: NotificationType.TEACHING_SCHEDULE_CONFIRM_ALERT,
        message: teacherMessage(s),
        meta: {
          kind: TEACHING_SCHEDULE_CONFIRM_ALERT_KIND,
          module: TEACHING_MODULE,
          route: TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE,
          url: TEACHING_SCHEDULE_CONFIRM_TEACHER_URL,
          sessionId: s.id,
          date: s.date,
          startTime: s.startTime,
          endTime: s.endTime,
          schoolName: s.schoolName,
          className: s.className,
          subjectName: s.subjectName,
        },
      });
    }

    for (const receiverId of managerIds) {
      await this.notificationService.create({
        receiverId,
        type: NotificationType.TEACHING_SCHEDULE_CONFIRM_ALERT,
        message: managerMessage,
        meta: {
          kind: TEACHING_SCHEDULE_CONFIRM_ALERT_KIND,
          module: TEACHING_MODULE,
          route: TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE,
          url: TEACHING_SCHEDULE_CONFIRM_MANAGER_URL,
          sessionCount: sessions.length,
          sessions: sessions.map((s) => ({
            sessionId: s.id,
            teacherName: s.teacherName,
            date: s.date,
            startTime: s.startTime,
            endTime: s.endTime,
            schoolName: s.schoolName,
            className: s.className,
            subjectName: s.subjectName,
          })),
        },
      });
    }

    if (recipientIds.length) {
      const tokens = await this.employeeFcmTokenService.getTokens(recipientIds);
      await Promise.allSettled([
        teacherEmployeeIds.length
          ? this.fcmService.sendToMultiple(
              tokens
                .filter((t) => teacherEmployeeIds.includes(t.employeeId))
                .map((t) => t.token),
              TEACHING_SCHEDULE_CONFIRM_ALERT_TEACHER_TITLE,
              'Bạn có buổi dạy sắp tới chưa xác nhận lịch.',
              {
                kind: TEACHING_SCHEDULE_CONFIRM_ALERT_KIND,
                module: TEACHING_MODULE,
                route: TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE,
                url: TEACHING_SCHEDULE_CONFIRM_TEACHER_URL,
              },
            )
          : Promise.resolve(),
        managerIds.length
          ? this.fcmService.sendToMultiple(
              tokens
                .filter((t) => managerIds.includes(t.employeeId))
                .map((t) => t.token),
              TEACHING_SCHEDULE_CONFIRM_ALERT_MANAGER_TITLE,
              managerMessage,
              {
                kind: TEACHING_SCHEDULE_CONFIRM_ALERT_KIND,
                module: TEACHING_MODULE,
                route: TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE,
                url: TEACHING_SCHEDULE_CONFIRM_MANAGER_URL,
              },
            )
          : Promise.resolve(),
      ]).catch((error) =>
        this.logger.error('Gửi push nhắc xác nhận lịch dạy lỗi', error),
      );
    }

    return { sessions: sessions.length, recipients: recipientIds.length };
  }

  /**
   * Buổi còn PENDING xác nhận, đã có giáo viên, và sắp tới trong cửa sổ nhắc
   * (mặc định 24h) — chưa từng bắn nhắc (`confirmationAlertAt IS NULL`).
   */
  private async findSessionsPendingConfirmation(now: Date) {
    const lead = TEACHING_SCHEDULE_CONFIRM_ALERT_LEAD_MINUTES;
    const until = new Date(now.getTime() + lead * 60_000);

    const rows = await this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.teacher', 't')
      .innerJoin('ss.school', 'sc')
      .leftJoin('ss.class', 'cl')
      .innerJoin('ss.subject', 'sub')
      .select([
        'ss.id AS "id"',
        'ss.date AS "date"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        't.employeeId AS "teacherEmployeeId"',
        't.name AS "teacherName"',
        'sc.name AS "schoolName"',
        'cl.name AS "className"',
        'sub.name AS "subjectName"',
      ])
      .where('ss.teacherId IS NOT NULL')
      .andWhere('ss.assignmentStatus = :assigned', {
        assigned: AssignmentStatus.ASSIGNED,
      })
      .andWhere('ss.confirmationStatus = :pending', {
        pending: ConfirmationStatus.PENDING,
      })
      .andWhere('ss.confirmationAlertAt IS NULL')
      // Postgres: date + time -> timestamp, so this compares the real
      // session start instant against the alert window.
      .andWhere(`(ss.date + ss.startTime) BETWEEN :now AND :until`, {
        now,
        until,
      })
      .orderBy('ss.date', 'ASC')
      .addOrderBy('ss.startTime', 'ASC')
      .getRawMany();

    return rows.map((row) => ({
      id: Number(row.id),
      date: toDateString(row.date) as string,
      startTime: toDisplayTime(row.startTime) as string,
      endTime: toDisplayTime(row.endTime) as string,
      teacherEmployeeId: this.nullableNumber(row.teacherEmployeeId),
      teacherName: (row.teacherName as string) ?? 'Giáo viên',
      schoolName: (row.schoolName as string) ?? '',
      className: (row.className as string) ?? null,
      subjectName: (row.subjectName as string) ?? '',
    }));
  }

  private buildConfirmationAlertManagerMessage(
    sessions: Array<{
      date: string;
      startTime: string;
      endTime: string;
      teacherName: string;
      schoolName: string;
      className: string | null;
      subjectName: string;
    }>,
  ): string {
    const line = (s: (typeof sessions)[number]) => {
      const place = [s.className, s.schoolName].filter(Boolean).join(', ');
      return (
        `ngày ${this.formatVietnameseDate(s.date)} lúc ${s.startTime}–${s.endTime} ` +
        `${s.teacherName}` +
        `${s.subjectName ? ` – môn ${s.subjectName}` : ''}` +
        `${place ? ` – ${place}` : ''}`
      );
    };

    if (sessions.length === 1) {
      const s = sessions[0];
      return `Còn buổi dạy ${line(s)} mà giáo viên chưa xác nhận nhận lịch.`;
    }
    return (
      `${sessions.length} buổi dạy sắp tới trong vòng 1 ngày mà giáo viên chưa xác nhận nhận lịch:\n` +
      sessions.map((s) => `• ${line(s)}`).join('\n')
    );
  }

  /** Báo cho giáo viên: có buổi dạy mới cần xác nhận. */
  private async notifyConfirmationRequest(
    session: TeachingSession,
    teacher: Teacher,
    reason: 'assigned' | 'rescheduled' = 'assigned',
  ): Promise<void> {
    if (!teacher.employeeId) return;

    const slot =
      `ngày ${this.formatVietnameseDate(toDateString(session.date) as string)} ` +
      `lúc ${toDisplayTime(session.startTime)}`;
    const message =
      reason === 'rescheduled'
        ? `Buổi dạy của bạn đã đổi lịch sang ${slot}. Vui lòng xác nhận hoặc từ chối.`
        : `Bạn được xếp buổi dạy ${slot}. Vui lòng xác nhận hoặc từ chối.`;
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
        meta: { ...pushData, entityType: 'session', sessionId: session.id },
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
        'Gửi thông báo yêu cầu xác nhận buổi dạy lỗi',
        error as any,
      );
    }
  }

  /** Báo kết quả xác nhận/từ chối cho Giáo vụ, Nhân sự và chính giáo viên. */
  private async notifyConfirmationResult(
    session: TeachingSession,
  ): Promise<void> {
    const confirmed =
      session.confirmationStatus === ConfirmationStatus.CONFIRMED;
    const full = await this.sessionRepo.findOne({
      where: { id: session.id },
      relations: ['teacher', 'school', 'class', 'subject'],
    });
    const teacherName = full?.teacher?.name ?? 'Giáo viên';
    const schoolName = full?.school?.name ?? '';
    const className = full?.class?.name ?? '';
    const subjectName = full?.subject?.name ?? '';
    const placeLabel = [schoolName, className].filter(Boolean).join(' - ');
    const dateLabel = this.formatVietnameseDate(
      toDateString(session.date) as string,
    );
    const timeLabel =
      `ngày ${dateLabel} lúc ${toDisplayTime(session.startTime)}–${toDisplayTime(session.endTime)}` +
      `${subjectName ? ` môn ${subjectName}` : ''}` +
      `${placeLabel ? ` tại ${placeLabel}` : ''}`;

    const managerMessage = confirmed
      ? `${teacherName} đã xác nhận buổi dạy ${timeLabel}.`
      : `${teacherName} đã từ chối buổi dạy ${timeLabel}. Lý do: ${session.rejectionReason}`;
    const teacherMessage = confirmed
      ? 'Bạn đã xác nhận buổi dạy thành công.'
      : 'Bạn đã từ chối buổi dạy này.';

    try {
      const managers = await this.findTeachingManagers();
      const receiverIds = managers.map((m) => m.id);

      for (const receiverId of receiverIds) {
        await this.notificationService.create({
          receiverId,
          type: NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT,
          message: managerMessage,
          meta: {
            kind: TEACHING_SCHEDULE_CONFIRM_RESULT_KIND,
            module: TEACHING_MODULE,
            route: TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE,
            url: TEACHING_SCHEDULE_CONFIRM_MANAGER_URL,
            entityType: 'session',
            sessionId: session.id,
            status: session.confirmationStatus,
            reason: session.rejectionReason,
            teacherName,
            date: toDateString(session.date),
            startTime: session.startTime,
            endTime: session.endTime,
            schoolId: full?.schoolId,
            schoolName,
            classId: full?.classId,
            className,
            subjectId: full?.subjectId,
            subjectName,
          },
        });
      }

      if (full?.teacher?.employeeId) {
        await this.notificationService.create({
          receiverId: full.teacher.employeeId,
          type: NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT,
          message: teacherMessage,
          meta: {
            kind: TEACHING_SCHEDULE_CONFIRM_RESULT_KIND,
            module: TEACHING_MODULE,
            route: TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE,
            url: TEACHING_SCHEDULE_CONFIRM_TEACHER_URL,
            entityType: 'session',
            sessionId: session.id,
            status: session.confirmationStatus,
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
            {
              kind: TEACHING_SCHEDULE_CONFIRM_RESULT_KIND,
              module: TEACHING_MODULE,
              route: TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE,
              url: TEACHING_SCHEDULE_CONFIRM_MANAGER_URL,
            },
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'Gửi thông báo kết quả xác nhận buổi dạy lỗi',
        error as any,
      );
    }
  }

  /** Báo Giáo vụ, Nhân sự khi giáo viên từ chối buổi đã phân công — cần chọn người thay thế. */
  private async notifyReplacementRequest(
    sessionId: number,
    declinedTeacherName: string,
  ): Promise<void> {
    const full = await this.sessionRepo.findOne({
      where: { id: sessionId },
      relations: ['school', 'class', 'subject'],
    });
    const schoolName = full?.school?.name ?? '';
    const className = full?.class?.name ?? '';
    const subjectName = full?.subject?.name ?? '';
    const placeLabel = [subjectName, className, schoolName]
      .filter(Boolean)
      .join(' - ');
    const dateLabel = full
      ? this.formatVietnameseDate(toDateString(full.date) as string)
      : '';

    const message =
      `${declinedTeacherName} đã từ chối buổi dạy${placeLabel ? ` ${placeLabel}` : ''}` +
      `${dateLabel ? ` ngày ${dateLabel}` : ''}` +
      `${full ? ` lúc ${toDisplayTime(full.startTime)}–${toDisplayTime(full.endTime)}` : ''}.` +
      ` Lý do: ${full?.declineReason ?? ''}`;

    try {
      const managers = await this.findTeachingManagers();
      const receiverIds = managers.map((m) => m.id);

      for (const receiverId of receiverIds) {
        await this.notificationService.create({
          receiverId,
          type: NotificationType.TEACHING_REPLACEMENT_REQUEST,
          message,
          meta: {
            kind: TEACHING_SESSION_DECLINE_KIND,
            module: TEACHING_MODULE,
            route: TEACHING_SESSION_DECLINE_ROUTE,
            url: TEACHING_SESSION_DECLINE_URL,
            entityType: 'session',
            sessionId,
            declinedTeacherId: full?.declinedTeacherId,
            declinedTeacherName,
            schoolId: full?.schoolId,
            schoolName,
            classId: full?.classId,
            className,
          },
        });
      }

      if (receiverIds.length) {
        const tokens =
          await this.employeeFcmTokenService.getTokens(receiverIds);
        if (tokens.length) {
          await this.fcmService.sendToMultiple(
            tokens.map((t) => t.token),
            TEACHING_SESSION_DECLINE_TITLE,
            message,
            {
              kind: TEACHING_SESSION_DECLINE_KIND,
              module: TEACHING_MODULE,
              route: TEACHING_SESSION_DECLINE_ROUTE,
              url: TEACHING_SESSION_DECLINE_URL,
            },
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'Gửi thông báo giáo viên từ chối buổi dạy lỗi',
        error as any,
      );
    }
  }

  /**
   * Kênh Zalo của báo động — chạy sau thông báo trong app và push, và không bao
   * giờ ném lỗi ra ngoài: Zalo là kênh phụ, hỏng thì báo động vẫn phải tới nơi
   * bằng hai kênh kia.
   */
  private async sendCheckinAlertToZalo(
    managers: Array<{ id: number; zaloUserId: string | null }>,
    message: string,
  ): Promise<number> {
    if (!isTeachingCheckinAlertZaloEnabled()) return 0;

    const targets = managers
      .map((m) => m.zaloUserId)
      .filter((id): id is string => Boolean(id));

    if (!targets.length) {
      this.logger.warn(
        'Bật báo động Zalo nhưng chưa tài khoản Giáo vụ / Nhân sự nào có zalo_user_id',
      );
      return 0;
    }

    try {
      this.logger.log(
        `Zalo: bắt đầu gửi cảnh báo check-in tới ${targets.length} người`,
      );
      const result = await this.zaloNotifyService.sendToMany(
        targets,
        `${TEACHING_CHECKIN_ALERT_ZALO_PREFIX}${message}`,
      );
      this.logger.log(
        `Zalo: hoàn tất cảnh báo check-in (${result.sent} thành công, ${result.failed} lỗi)`,
      );
      return result.sent;
    } catch (error) {
      this.logger.error('Gửi Zalo báo động chưa check-in lỗi', error as any);
      return 0;
    }
  }

  /**
   * Các buổi hôm nay tới giờ mà chưa có check-in, trong cửa sổ báo động.
   *
   * Cửa sổ tính hai phía quanh giờ vào tiết: `LEAD` phút trước (đúng yêu cầu
   * nghiệp vụ) và `LEAD` phút sau (để job có lỡ một nhịp — deploy, restart —
   * thì buổi đó vẫn được báo, muộn còn hơn không).
   */
  /**
   * Trong số các buổi ASSIGNED/SCHEDULED hôm nay của MỌI giáo viên, những buổi
   * cần tự check-in. Sáng/chiều là hai block riêng dù cùng trường. Mỗi block
   * chỉ có tiết đầu (`checkinRequired=true`) được
   * xét; tiết giữa/cuối không bao giờ bị coi là thiếu check-in, kể cả khi cả
   * block chưa có thao tác nào.
   */
  private async findSessionIdsNeedingOwnCheckin(
    date: string,
  ): Promise<Set<number>> {
    const rows = await this.sessionRepo
      .createQueryBuilder('ss')
      .select([
        'ss.id AS "id"',
        'ss.teacherId AS "teacherId"',
        'ss.schoolId AS "schoolId"',
        'ss.schoolLocationId AS "schoolLocationId"',
        'ss.startTime AS "startTime"',
        'ss.checkinAt AS "checkinAt"',
      ])
      .where('ss.teacherId IS NOT NULL')
      .andWhere('ss.date = :date', { date })
      .andWhere('ss.assignmentStatus = :assigned', {
        assigned: AssignmentStatus.ASSIGNED,
      })
      .andWhere('ss.status = :scheduled', {
        scheduled: SessionStatus.SCHEDULED,
      })
      .orderBy('ss.teacherId', 'ASC')
      .addOrderBy('ss.startTime', 'ASC')
      .addOrderBy('ss.id', 'ASC')
      .getRawMany();

    const result = new Set<number>();
    const byTeacher = new Map<number, any[]>();
    for (const row of rows) {
      const teacherId = Number(row.teacherId);
      const sessions = byTeacher.get(teacherId) ?? [];
      sessions.push({
        id: Number(row.id),
        schoolId: Number(row.schoolId),
        schoolLocationId:
          row.schoolLocationId == null ? null : Number(row.schoolLocationId),
        startTime: row.startTime,
        checkinAt: row.checkinAt ? new Date(row.checkinAt) : null,
      });
      byTeacher.set(teacherId, sessions);
    }

    for (const sessions of byTeacher.values()) {
      const flags = computeDayBlocks(sessions);
      for (const session of sessions) {
        if (flags.get(session.id)?.checkinRequired && !session.checkinAt) {
          result.add(session.id);
        }
      }
    }

    return result;
  }

  private async findSessionsMissingCheckin(now: Date) {
    const date = this.todayDateString(now);
    const nowMinutes = this.vnMinutesOfDay(now);
    const lead = TEACHING_CHECKIN_ALERT_LEAD_MINUTES;

    const uncoveredIds = await this.findSessionIdsNeedingOwnCheckin(date);
    if (!uncoveredIds.size) return [];

    const rows = await this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.teacher', 't')
      .innerJoin('ss.school', 'sc')
      .leftJoin('ss.class', 'cl')
      .innerJoin('ss.subject', 'sub')
      .select([
        'ss.id AS "id"',
        'ss.date AS "date"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        'ss.teacherId AS "teacherId"',
        't.name AS "teacherName"',
        'sc.name AS "schoolName"',
        'cl.name AS "className"',
        'sub.name AS "subjectName"',
      ])
      .where('ss.id IN (:...ids)', { ids: [...uncoveredIds] })
      .andWhere('ss.checkinAlertAt IS NULL')
      .andWhere('ss.startTime BETWEEN :from AND :to', {
        from: this.minutesToDbTime(nowMinutes - lead),
        to: this.minutesToDbTime(nowMinutes + lead),
      })
      .orderBy('ss.startTime', 'ASC')
      .addOrderBy('ss.id', 'ASC')
      .getRawMany();

    return rows.map((row) => {
      const startTime = toDisplayTime(row.startTime) as string;
      return {
        id: Number(row.id),
        date: toDateString(row.date) as string,
        startTime,
        endTime: toDisplayTime(row.endTime) as string,
        teacherId: this.nullableNumber(row.teacherId),
        teacherName: (row.teacherName as string) ?? 'Giáo viên',
        schoolName: (row.schoolName as string) ?? '',
        className: (row.className as string) ?? null,
        subjectName: (row.subjectName as string) ?? '',
        minutesToStart: this.minutesOfTime(startTime) - nowMinutes,
      };
    });
  }

  /** Tài khoản Giáo vụ và Nhân sự — người nhận báo động. */
  private async findTeachingManagers(): Promise<
    Array<{ id: number; zaloUserId: string | null }>
  > {
    return findTeachingManagersUtil(this.employeeRepo);
  }

  private buildCheckinAlertMessage(
    sessions: Array<{
      teacherName: string;
      schoolName: string;
      className: string | null;
      subjectName: string;
      startTime: string;
      endTime: string;
      minutesToStart: number;
    }>,
  ): string {
    const line = (s: (typeof sessions)[number]) => {
      const place = [s.className, s.schoolName].filter(Boolean).join(', ');
      return (
        `${s.startTime}–${s.endTime} ${s.teacherName}` +
        `${s.subjectName ? ` – môn ${s.subjectName}` : ''}` +
        `${place ? ` – ${place}` : ''}` +
        ` (${this.describeMinutesToStart(s.minutesToStart)})`
      );
    };

    if (sessions.length === 1) {
      return `${sessions[0].teacherName} chưa check-in: ${line(sessions[0])}`;
    }

    return (
      `${sessions.length} buổi dạy chưa check-in:\n` +
      sessions.map((s) => `• ${line(s)}`).join('\n')
    );
  }

  private describeMinutesToStart(minutes: number): string {
    if (minutes > 0) return `còn ${minutes} phút nữa vào tiết`;
    if (minutes === 0) return 'đã tới giờ vào tiết';
    return `đã quá giờ vào tiết ${Math.abs(minutes)} phút`;
  }

  /** Số phút kể từ 00:00 theo giờ Việt Nam. */
  private vnMinutesOfDay(now = new Date()): number {
    const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return vn.getUTCHours() * 60 + vn.getUTCMinutes();
  }

  private minutesOfTime(time: string): number {
    const [hour, minute] = time.split(':');
    return Number(hour) * 60 + Number(minute);
  }

  /**
   * Số phút -> "HH:MM:SS" để so với cột `time`. Cắt về trong ngày: buổi dạy
   * không bao giờ nằm quanh nửa đêm nên không cần xử lý tràn sang ngày khác.
   */
  private minutesToDbTime(minutes: number): string {
    const clamped = Math.min(24 * 60 - 1, Math.max(0, minutes));
    const hour = String(Math.floor(clamped / 60)).padStart(2, '0');
    const minute = String(clamped % 60).padStart(2, '0');
    return `${hour}:${minute}:00`;
  }

  /**
   * Các buổi hôm nay đang trễ check-in — dùng cho banner cảnh báo trên màn
   * Chấm công. Khác `findSessionsMissingCheckin` ở chỗ không lọc theo cột
   * `checkinAlertAt`, vì đây là bảng theo dõi chứ không phải hàng đợi gửi.
   */
  async findCheckinAlerts(now = new Date()) {
    const date = this.todayDateString(now);
    const nowMinutes = this.vnMinutesOfDay(now);
    const lead = TEACHING_CHECKIN_ALERT_LEAD_MINUTES;
    const late = TEACHING_CHECKIN_ALERT_LATE_MINUTES;

    const uncoveredIds = await this.findSessionIdsNeedingOwnCheckin(date);
    if (!uncoveredIds.size) {
      return { date, leadMinutes: lead, total: 0, data: [] };
    }

    const rows = await this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.teacher', 't')
      .innerJoin('ss.school', 'sc')
      .leftJoin('ss.class', 'cl')
      .leftJoin('t.employee', 'emp')
      .select([
        'ss.id AS "id"',
        'ss.date AS "date"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        'ss.checkinAlertAt AS "checkinAlertAt"',
        'ss.teacherId AS "teacherId"',
        't.name AS "teacherName"',
        'COALESCE(t.phone, emp.phone) AS "teacherPhone"',
        'sc.name AS "schoolName"',
        'cl.name AS "className"',
      ])
      .where('ss.id IN (:...ids)', { ids: [...uncoveredIds] })
      // Chỉ hiện từ lúc vào cửa sổ báo trước đến tối đa 10 phút sau giờ học.
      // Nhờ vậy các cảnh báo cũ tự rời banner thay vì tồn tại hết ngày.
      .andWhere('ss.startTime BETWEEN :from AND :until', {
        from: this.minutesToDbTime(nowMinutes - late),
        until: this.minutesToDbTime(nowMinutes + lead),
      })
      .orderBy('ss.startTime', 'ASC')
      .getRawMany();

    const data = rows.map((row) => {
      const startTime = toDisplayTime(row.startTime) as string;
      return {
        sessionId: Number(row.id),
        date: toDateString(row.date) as string,
        startTime,
        endTime: toDisplayTime(row.endTime),
        teacherId: this.nullableNumber(row.teacherId),
        teacherName: (row.teacherName as string) ?? null,
        teacherPhone: (row.teacherPhone as string) ?? null,
        schoolName: (row.schoolName as string) ?? null,
        className: (row.className as string) ?? null,
        minutesToStart: this.minutesOfTime(startTime) - nowMinutes,
        alerted: Boolean(row.checkinAlertAt),
      };
    });

    return { date, leadMinutes: lead, total: data.length, data };
  }

  private todayDateString(now = new Date()): string {
    // Ngày nghiệp vụ theo múi giờ Việt Nam (UTC+7, không có DST), độc lập TZ của server.
    return new Date(now.getTime() + 7 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  private haversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Resolve geofencing coordinates: nếu session có school location với toạ độ riêng,
   * dùng toạ độ location; nếu không hoặc location chưa có toạ độ, fallback về toạ độ trường.
   * Đây là double-fallback: location (nếu có + có toạ độ) → school.
   */
  private async resolveGeoTarget(
    session: TeachingSession,
    manager?: EntityManager,
  ): Promise<{
    latitude: number | null;
    longitude: number | null;
    checkinRadius: number | null;
  }> {
    if (session.schoolLocationId) {
      const repo = manager
        ? manager.getRepository(SchoolLocation)
        : this.schoolLocationRepo;
      const location = await repo.findOne({
        where: { id: session.schoolLocationId },
      });
      if (location?.latitude != null && location?.longitude != null) {
        return {
          latitude: location.latitude,
          longitude: location.longitude,
          checkinRadius: location.checkinRadius ?? null,
        };
      }
    }
    return {
      latitude: session.school.latitude,
      longitude: session.school.longitude,
      checkinRadius: session.school.checkinRadius,
    };
  }

  private async calculatePunchLocation(
    session: TeachingSession,
    dto: CheckinTeachingSessionDto,
    manager?: EntityManager,
  ): Promise<{ distance: number | null; outOfRange: boolean }> {
    const geoTarget = await this.resolveGeoTarget(session, manager);

    if (geoTarget.latitude === null || geoTarget.longitude === null) {
      return { distance: null, outOfRange: false };
    }

    const distance = Math.round(
      this.haversineDistance(
        dto.latitude,
        dto.longitude,
        geoTarget.latitude,
        geoTarget.longitude,
      ),
    );
    return {
      distance,
      outOfRange: distance > (geoTarget.checkinRadius ?? 200),
    };
  }

  private async getTeacherByEmployee(employeeId: number): Promise<Teacher> {
    const teacher = await this.teacherRepo.findOne({ where: { employeeId } });
    if (!teacher) {
      throw new NotFoundException(
        'Tài khoản này chưa được gắn với hồ sơ giáo viên nào',
      );
    }
    return teacher;
  }

  private async getSessionWithSchool(id: number): Promise<TeachingSession> {
    const session = await this.sessionRepo.findOne({
      where: { id },
      relations: ['school'],
    });
    if (!session) throw new NotFoundException('Buổi dạy không tồn tại');
    return session;
  }

  /**
   * Các buổi thực sự "sống" (đã phân công, chưa huỷ) của một giáo viên trong
   * một ngày, sắp theo giờ dạy — nền tảng để gộp block cùng buổi và cùng trường
   * (`computeDayBlocks`/`isBlockCheckedIn`). Nhận `manager` để đọc trong cùng
   * transaction với thao tác đang chờ ghi (checkout/nộp bài).
   */
  private async loadDaySessions(
    teacherId: number,
    date: string,
    manager?: {
      getRepository: (t: typeof TeachingSession) => Repository<TeachingSession>;
    },
  ): Promise<
    Array<{
      id: number;
      schoolId: number;
      schoolLocationId: number | null;
      startTime: string;
      checkinAt: Date | null;
      checkoutAt: Date | null;
    }>
  > {
    const repo = manager
      ? manager.getRepository(TeachingSession)
      : this.sessionRepo;

    const rows = await repo
      .createQueryBuilder('ss')
      .select([
        'ss.id AS "id"',
        'ss.schoolId AS "schoolId"',
        // Block chấm công ngắt theo ĐỊA ĐIỂM: thiếu cột này thì hai cơ sở khác
        // nhau của cùng một trường bị gộp thành một lần đến trường.
        'ss.schoolLocationId AS "schoolLocationId"',
        'ss.startTime AS "startTime"',
        'ss.checkinAt AS "checkinAt"',
        'ss.checkoutAt AS "checkoutAt"',
      ])
      .where('ss.teacherId = :teacherId', { teacherId })
      .andWhere('ss.date = :date', { date })
      .andWhere('ss.assignmentStatus = :assigned', {
        assigned: AssignmentStatus.ASSIGNED,
      })
      .andWhere('ss.status != :cancelled', {
        cancelled: SessionStatus.CANCELLED,
      })
      .orderBy('ss.startTime', 'ASC')
      .addOrderBy('ss.id', 'ASC')
      .getRawMany();

    return rows.map((row) => ({
      id: Number(row.id),
      schoolId: Number(row.schoolId),
      schoolLocationId:
        row.schoolLocationId == null ? null : Number(row.schoolLocationId),
      startTime: row.startTime,
      checkinAt: row.checkinAt ? new Date(row.checkinAt) : null,
      checkoutAt: row.checkoutAt ? new Date(row.checkoutAt) : null,
    }));
  }

  private async calculateApplicationDistance(
    session: TeachingSession,
    latitude: number,
    longitude: number,
  ): Promise<number | null> {
    const geoTarget = await this.resolveGeoTarget(session);
    if (geoTarget.latitude === null || geoTarget.longitude === null)
      return null;
    return Math.round(
      this.haversineDistance(
        latitude,
        longitude,
        geoTarget.latitude,
        geoTarget.longitude,
      ),
    );
  }

  private weekRange(date: string): { from: string; to: string } {
    const value = new Date(`${date}T00:00:00Z`);
    const day = value.getUTCDay() || 7;
    const monday = new Date(value);
    monday.setUTCDate(value.getUTCDate() - day + 1);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
      from: monday.toISOString().slice(0, 10),
      to: sunday.toISOString().slice(0, 10),
    };
  }

  private async weeklyQuota(
    teacher: Teacher,
    session: TeachingSession,
    exceptSessionId: number,
  ) {
    const { from, to } = this.weekRange(toDateString(session.date) as string);
    const assigned = await this.sessionRepo
      .createQueryBuilder('quotaSession')
      .select('COALESCE(SUM(COALESCE(quotaSession.periods, 1)), 0)', 'periods')
      .where('quotaSession.teacherId = :teacherId', { teacherId: teacher.id })
      .andWhere('quotaSession.assignmentStatus = :assigned', {
        assigned: AssignmentStatus.ASSIGNED,
      })
      .andWhere('quotaSession.date BETWEEN :from AND :to', { from, to })
      .andWhere('quotaSession.id != :exceptSessionId', { exceptSessionId })
      .getRawOne();
    const pending = await this.applicationRepo
      .createQueryBuilder('quotaApp')
      .innerJoin('quotaApp.session', 'quotaOpenSession')
      .select(
        'COALESCE(SUM(COALESCE(quotaOpenSession.periods, 1)), 0)',
        'periods',
      )
      .where('quotaApp.teacherId = :teacherId', { teacherId: teacher.id })
      .andWhere('quotaApp.status = :pending', {
        pending: TeachingApplicationStatus.PENDING,
      })
      .andWhere('quotaOpenSession.date BETWEEN :from AND :to', { from, to })
      .andWhere('quotaOpenSession.id != :exceptSessionId', { exceptSessionId })
      .getRawOne();
    return {
      assignedPeriodsInWeek: Number(assigned?.periods ?? 0),
      pendingPeriodsInWeek: Number(pending?.periods ?? 0),
      maxPeriodsPerWeek: teacher.maxPeriodsPerWeek ?? null,
    };
  }

  private async hasScheduleConflict(
    teacherId: number,
    session: TeachingSession,
  ): Promise<boolean> {
    const count = await this.sessionRepo
      .createQueryBuilder('conflictSession')
      .where('conflictSession.teacherId = :teacherId', { teacherId })
      .andWhere('conflictSession.id != :sessionId', { sessionId: session.id })
      .andWhere('conflictSession.date = :date', {
        date: toDateString(session.date),
      })
      .andWhere('conflictSession.assignmentStatus = :assigned', {
        assigned: AssignmentStatus.ASSIGNED,
      })
      .andWhere('conflictSession.status IN (:...statuses)', {
        statuses: ACTIVE_SESSION_STATUSES,
      })
      .andWhere('conflictSession.startTime < :endTime', {
        endTime: session.endTime,
      })
      .andWhere('conflictSession.endTime > :startTime', {
        startTime: session.startTime,
      })
      .getCount();
    return count > 0;
  }

  private async refreshRecommendedTeacher(sessionId: number): Promise<void> {
    const best = await this.applicationRepo
      .createQueryBuilder('recommendation')
      .innerJoin('recommendation.teacher', 'recommendationTeacher')
      .select('recommendation.teacherId', 'teacherId')
      .where('recommendation.sessionId = :sessionId', { sessionId })
      .andWhere('recommendation.status = :pending', {
        pending: TeachingApplicationStatus.PENDING,
      })
      .andWhere('recommendationTeacher.isActive = true')
      .orderBy('recommendation.distance', 'ASC', 'NULLS LAST')
      .addOrderBy('recommendation.createdAt', 'ASC')
      .getRawOne();

    await this.sessionRepo.update(sessionId, {
      recommendedTeacherId: best ? Number(best.teacherId) : null,
    });
  }

  private formatVietnameseDate(value: string): string {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }

  private buildScheduleMessage(
    range: string,
    sessionCount: number,
    periodCount: number,
    message?: string,
  ): string {
    const summary = `Lịch dạy ${range}: ${sessionCount} buổi · ${periodCount} tiết`;
    return message ? `${summary}\nLời nhắn: ${message}` : summary;
  }

  /**
   * Chi tiết từng buổi để dựng bảng trong email, gom theo giáo viên.
   * Dùng đúng bộ lọc của notifySchedule để bảng khớp với số liệu tổng hợp.
   */
  private async loadScheduleDetails(
    dto: NotifyTeachingScheduleDto,
    teacherIds: number[],
  ): Promise<Map<number, ScheduleDetailRow[]>> {
    const grouped = new Map<number, ScheduleDetailRow[]>();
    if (!teacherIds.length) return grouped;

    const qb = this.sessionRepo
      .createQueryBuilder('session')
      .innerJoin('session.school', 'school')
      .leftJoin('session.class', 'class')
      .innerJoin('session.subject', 'subject')
      .select([
        'session.teacherId AS "teacherId"',
        'session.date AS "date"',
        'session.startTime AS "startTime"',
        'session.endTime AS "endTime"',
        'COALESCE(session.periods, 0)::int AS "periods"',
        'school.name AS "schoolName"',
        'class.name AS "className"',
        'subject.name AS "subjectName"',
      ])
      .where('session.teacherId IN (:...teacherIds)', { teacherIds })
      .andWhere('session.date BETWEEN :fromDate AND :toDate', {
        fromDate: dto.fromDate,
        toDate: dto.toDate,
      })
      .andWhere('session.assignmentStatus = :assigned', {
        assigned: AssignmentStatus.ASSIGNED,
      });
    if (dto.schoolId)
      qb.andWhere('session.schoolId = :schoolId', { schoolId: dto.schoolId });
    if (dto.classId)
      qb.andWhere('session.classId = :classId', { classId: dto.classId });
    if (dto.subjectId)
      qb.andWhere('session.subjectId = :subjectId', {
        subjectId: dto.subjectId,
      });

    const rows = await qb
      .orderBy('session.date', 'ASC')
      .addOrderBy('session.startTime', 'ASC')
      .getRawMany();

    for (const row of rows) {
      const teacherId = Number(row.teacherId);
      const list = grouped.get(teacherId) ?? [];
      list.push({
        date: toDateString(row.date) ?? '',
        startTime: toDisplayTime(row.startTime),
        endTime: toDisplayTime(row.endTime),
        periods: Number(row.periods),
        schoolName: row.schoolName,
        className: row.className ?? null,
        subjectName: row.subjectName,
      });
      grouped.set(teacherId, list);
    }
    return grouped;
  }

  /** "01/08 (Thứ Bảy)" — nhãn ngày trong bảng lịch. */
  private formatScheduleDay(date: string): string {
    const [, month, day] = date.split('-');
    return `${day}/${month} (${DAY_OF_WEEK_LABELS[dayOfWeekOf(date)] ?? ''})`.trim();
  }

  private buildScheduleTextTable(details: ScheduleDetailRow[]): string {
    return details
      .map((row) => {
        const time =
          row.startTime && row.endTime
            ? ` · ${row.startTime}–${row.endTime}`
            : '';
        const className = row.className ? ` · Lớp ${row.className}` : '';
        return (
          `- ${this.formatScheduleDay(row.date)}${time} · ${row.schoolName}${className}` +
          ` · ${row.subjectName} · ${row.periods} tiết`
        );
      })
      .join('\n');
  }

  private buildScheduleHtmlTable(details: ScheduleDetailRow[]): string {
    const cell = 'padding:8px 10px;border:1px solid #e0e0e0;';
    const head = ['Ngày', 'Giờ', 'Trường', 'Lớp', 'Môn', 'Tiết']
      .map(
        (label) =>
          `<th style="${cell}background:#f5f5f5;text-align:left;">${label}</th>`,
      )
      .join('');
    const body = details
      .map((row) => {
        const time =
          row.startTime && row.endTime
            ? `${row.startTime}–${row.endTime}`
            : '—';
        return (
          '<tr>' +
          `<td style="${cell}">${this.escapeHtml(this.formatScheduleDay(row.date))}</td>` +
          `<td style="${cell}">${this.escapeHtml(time)}</td>` +
          `<td style="${cell}">${this.escapeHtml(row.schoolName)}</td>` +
          `<td style="${cell}">${this.escapeHtml(row.className ?? '—')}</td>` +
          `<td style="${cell}">${this.escapeHtml(row.subjectName)}</td>` +
          `<td style="${cell}text-align:center;">${row.periods}</td>` +
          '</tr>'
        );
      })
      .join('');
    return (
      '<table style="border-collapse:collapse;font-size:14px;margin:12px 0;">' +
      `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    );
  }

  private async sendScheduleEmails(
    recipients: Array<Record<string, any>>,
    range: string,
    details: Map<number, ScheduleDetailRow[]>,
    message?: string,
  ): Promise<number> {
    const user = process.env.SMTP_USER || process.env.MAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.MAIL_PASS;
    if (!user || !pass) {
      this.logger.warn(
        'Chưa cấu hình SMTP_USER/SMTP_PASS; bỏ qua gửi lịch qua email',
      );
      return 0;
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: (process.env.SMTP_SECURE ?? 'true') !== 'false',
      auth: { user, pass },
    });
    const from = process.env.MAIL_FROM || `Kido Education <${user}>`;
    const appUrl =
      process.env.TEACHER_SCHEDULE_URL ||
      'https://kidoapp.kidoedu.vn/#/giao-vien/lich-day';
    const results = await Promise.allSettled(
      recipients
        .filter((row) => row.email)
        .map((row) => {
          const body = this.buildScheduleMessage(
            range,
            Number(row.sessionCount),
            Number(row.periodCount),
            message,
          );
          const rows = details.get(Number(row.teacherId)) ?? [];
          const textTable = rows.length
            ? `\n\n${this.buildScheduleTextTable(rows)}`
            : '';
          const htmlTable = rows.length
            ? this.buildScheduleHtmlTable(rows)
            : '';
          return transporter.sendMail({
            from,
            to: row.email,
            subject: `Lịch dạy ${range}`,
            text:
              `Xin chào ${row.teacherName},\n\n${body}${textTable}` +
              `\n\nXem lịch dạy: ${appUrl}`,
            html:
              `<p>Xin chào ${this.escapeHtml(row.teacherName)},</p>` +
              `<p>${this.escapeHtml(body).replace(/\n/g, '<br>')}</p>` +
              htmlTable +
              `<p><a href="${this.escapeHtml(appUrl)}">Xem lịch dạy</a></p>`,
          });
        }),
    );
    results.forEach((result) => {
      if (result.status === 'rejected') {
        this.logger.error(
          `Gửi email lịch dạy thất bại: ${String(result.reason)}`,
        );
      }
    });
    return results.filter((result) => result.status === 'fulfilled').length;
  }

  private escapeHtml(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /** Một giáo viên không dạy 2 buổi giao giờ trong cùng một ngày. */
  private async assertTeacherFree(
    teacherId: number,
    date: string,
    startTime: string,
    endTime: string,
    exceptSessionId?: number,
  ) {
    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.school', 'sc')
      .select([
        'ss.id AS "id"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        'sc.name AS "schoolName"',
      ])
      .where('ss.teacherId = :teacherId', { teacherId })
      .andWhere('ss.date = :date', { date })
      .andWhere('ss.status IN (:...statuses)', {
        statuses: ACTIVE_SESSION_STATUSES,
      })
      .andWhere('ss.startTime < :endTime', { endTime: toDbTime(endTime) })
      .andWhere('ss.endTime > :startTime', { startTime: toDbTime(startTime) });

    if (exceptSessionId) {
      qb.andWhere('ss.id != :exceptSessionId', { exceptSessionId });
    }

    const conflict = await qb.getRawOne();

    if (conflict) {
      throw new ConflictException(
        `Giáo viên đã có buổi dạy ${toDisplayTime(conflict.startTime)}–` +
          `${toDisplayTime(conflict.endTime)} tại ${conflict.schoolName} ngày ${date}`,
      );
    }
  }

  /**
   * Một lớp không học 2 buổi giao giờ trong cùng một ngày.
   * Buổi cũ chưa gắn lớp (classId = null) không kiểm tra.
   */
  private async assertClassFree(
    classId: number | null | undefined,
    date: string,
    startTime: string,
    endTime: string,
    exceptSessionId?: number,
  ) {
    if (!classId) return;

    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.class', 'cl')
      .innerJoin('ss.subject', 'sub')
      .select([
        'ss.id AS "id"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        'cl.name AS "className"',
        'sub.name AS "subjectName"',
      ])
      .where('ss.classId = :classId', { classId })
      .andWhere('ss.date = :date', { date })
      .andWhere('ss.status IN (:...statuses)', {
        statuses: ACTIVE_SESSION_STATUSES,
      })
      .andWhere('ss.startTime < :endTime', { endTime: toDbTime(endTime) })
      .andWhere('ss.endTime > :startTime', { startTime: toDbTime(startTime) });

    if (exceptSessionId) {
      qb.andWhere('ss.id != :exceptSessionId', { exceptSessionId });
    }

    const conflict = await qb.getRawOne();

    if (conflict) {
      throw new ConflictException(
        `Lớp ${conflict.className} đã có buổi học ${toDisplayTime(conflict.startTime)}–` +
          `${toDisplayTime(conflict.endTime)} môn ${conflict.subjectName} ngày ${date}`,
      );
    }
  }
}
