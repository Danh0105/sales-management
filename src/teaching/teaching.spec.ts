import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { SchoolClassService } from './school-class.service';
import { SubjectResolverService } from './subject-resolver.service';
import { TeachingBulkService } from './teaching-bulk.service';
import { TeacherService } from './teacher.service';
import { TeachingScheduleService } from './teaching-schedule.service';
import { TeachingSessionService } from './teaching-session.service';
import { SessionStatus } from './teaching.enum';
import {
  assertCanManageTeaching,
  HR_ROLE,
  resolveTeachingScope,
  TEACHER_STAFF_ROLE,
  TEACHER_COLLABORATOR_ROLE,
} from './teaching-roles';
import { Employee } from '../employee/employee.entity';
import { Teacher } from './entities/teacher.entity';
import {
  amountOf,
  dayOfWeekOf,
  listDatesForDayOfWeek,
  toDateString,
  toDbTime,
  toDisplayTime,
  timeRangesOverlap,
} from './teaching.util';
import { CreateTeachingScheduleDto } from './dto/teaching-schedule.dto';
import { CreateTeachingSessionDto } from './dto/teaching-session.dto';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import { CreateTeacherDto } from './dto/teacher.dto';
import { CreateSchoolClassDto } from './dto/school-class.dto';

// ============================================================
// Helpers
// ============================================================

const CHAINABLE = [
  'innerJoin',
  'leftJoin',
  'where',
  'andWhere',
  'orWhere',
  'select',
  'addSelect',
  'groupBy',
  'addGroupBy',
  'orderBy',
  'addOrderBy',
  'limit',
  'offset',
];

function makeQueryBuilder() {
  const qb: any = {};
  for (const method of CHAINABLE) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getCount = jest.fn().mockResolvedValue(0);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
  return qb;
}

function makeRepo(overrides: Record<string, any> = {}) {
  const qb = makeQueryBuilder();
  return {
    qb,
    repo: {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 1, ...data })),
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      remove: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any,
  };
}

const ACTIVE_TEACHER = { id: 5, name: 'Cô A', isActive: true };
const SUBJECT = { id: 25, name: 'STEM', schoolId: 10 };
const SCHOOL_CLASS = {
  id: 7,
  name: '1A',
  schoolId: 10,
  schoolYear: '2026-2027',
  isActive: true,
};

/**
 * SchoolClassService giả lập đúng hợp đồng `resolveForScheduling`:
 * lớp không tồn tại / ngừng dùng / khác trường -> 400, ngược lại trả về lớp.
 */
function makeClassService(schoolClass: any = SCHOOL_CLASS) {
  return {
    resolveForScheduling: jest.fn(
      async (_classId: number, schoolId?: number | null) => {
        if (!schoolClass)
          throw new BadRequestException('Lớp học không tồn tại');
        if (!schoolClass.isActive) {
          throw new BadRequestException(
            `Lớp "${schoolClass.name}" đang ngừng sử dụng`,
          );
        }
        if (schoolId && schoolId !== schoolClass.schoolId) {
          throw new BadRequestException('Lớp học không thuộc trường đã chọn');
        }
        return schoolClass;
      },
    ),
  };
}

function makeScheduleService(
  opts: {
    teacher?: any;
    subject?: any;
    conflict?: any;
    classConflict?: any;
    schoolClass?: any;
  } = {},
) {
  const schedule = makeRepo();
  const session = makeRepo();
  const teacher = makeRepo({
    findOne: jest
      .fn()
      .mockResolvedValue(
        opts.teacher === undefined ? ACTIVE_TEACHER : opts.teacher,
      ),
  });
  const subject = makeRepo({
    findOne: jest
      .fn()
      .mockResolvedValue(opts.subject === undefined ? SUBJECT : opts.subject),
  });

  // Lần 1 = trùng lịch giáo viên, lần 2 = trùng lịch lớp; lần sau = đọc lại bản ghi vừa lưu.
  schedule.qb.getRawOne
    .mockResolvedValueOnce(opts.conflict)
    .mockResolvedValueOnce(opts.classConflict)
    .mockResolvedValue({
      id: 1,
      teacherId: 5,
      teacherName: 'Cô A',
      schoolId: 10,
      schoolName: 'Trường ABC',
      classId: 7,
      className: '1A',
      classGradeLevel: 1,
      subjectId: 25,
      subjectName: 'STEM',
      schoolYear: '2026-2027',
      dayOfWeek: 3,
      startTime: '07:30:00',
      endTime: '09:00:00',
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-08-31',
      isActive: true,
      note: null,
    });

  const classService = makeClassService(opts.schoolClass);
  const employee = makeRepo();
  const notificationService = { create: jest.fn().mockResolvedValue({}) };
  const fcmService = { sendToMultiple: jest.fn().mockResolvedValue(undefined) };
  const employeeFcmTokenService = {
    getTokens: jest.fn().mockResolvedValue([]),
  };
  const fuelAllowanceTierService = {
    computeForTeacherSchool: jest
      .fn()
      .mockResolvedValue({ distanceToSchoolKm: null, gasAllowance: null }),
  };

  const service = new TeachingScheduleService(
    schedule.repo,
    session.repo,
    teacher.repo,
    subject.repo,
    classService as any,
    {} as any,
    employee.repo,
    notificationService as any,
    fcmService as any,
    employeeFcmTokenService as any,
    fuelAllowanceTierService as any,
  );

  return {
    service,
    schedule,
    session,
    teacher,
    subject,
    classService,
    notificationService,
    fcmService,
  };
}

function makeSessionService(
  opts: {
    teacher?: any;
    subject?: any;
    conflict?: any;
    schoolClass?: any;
  } = {},
) {
  const session = makeRepo();
  const teacher = makeRepo({
    findOne: jest
      .fn()
      .mockResolvedValue(
        opts.teacher === undefined ? ACTIVE_TEACHER : opts.teacher,
      ),
  });
  const subject = makeRepo({
    findOne: jest
      .fn()
      .mockResolvedValue(opts.subject === undefined ? SUBJECT : opts.subject),
  });

  session.qb.getRawOne.mockResolvedValue(opts.conflict);

  const classService = makeClassService(opts.schoolClass);
  const fuelAllowanceTierService = {
    computeForTeacherSchool: jest
      .fn()
      .mockResolvedValue({ distanceToSchoolKm: null, gasAllowance: null }),
  };

  const service = new TeachingSessionService(
    session.repo,
    teacher.repo,
    subject.repo,
    undefined as any,
    undefined as any,
    classService as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    fuelAllowanceTierService as any,
  );

  return { service, session, teacher, subject, classService };
}

const validSchedule: CreateTeachingScheduleDto = {
  teacherId: 5,
  classId: 7,
  schoolId: 10,
  subjectId: 25,
  dayOfWeek: 3,
  startTime: '07:30',
  endTime: '09:00',
  effectiveFrom: '2026-08-01',
  effectiveTo: '2027-05-31',
};

const validSession: CreateTeachingSessionDto = {
  teacherId: 5,
  classId: 7,
  schoolId: 10,
  subjectId: 25,
  date: '2026-08-11',
  startTime: '07:30',
  endTime: '09:00',
};

// ============================================================
// 1. Phân quyền
// ============================================================

describe('Phân quyền module giảng dạy', () => {
  it('role nhansu có toàn quyền quản lý', () => {
    expect(resolveTeachingScope({ id: 1, roles: [HR_ROLE] })).toEqual({
      kind: 'manage',
    });
    expect(() =>
      assertCanManageTeaching({ id: 1, roles: [HR_ROLE] }),
    ).not.toThrow();
  });

  it.each([['director'], ['director_la'], ['troly_gd'], ['ketoan_truong']])(
    'role %s chỉ được xem',
    (role) => {
      expect(resolveTeachingScope({ id: 2, roles: [role] })).toEqual({
        kind: 'view',
      });
      expect(() => assertCanManageTeaching({ id: 2, roles: [role] })).toThrow(
        ForbiddenException,
      );
    },
  );

  it('role giaovien chỉ xem dữ liệu của chính mình', () => {
    expect(resolveTeachingScope({ id: 30, roles: [TEACHER_STAFF_ROLE] })).toEqual({
      kind: 'self',
      employeeId: 30,
    });
    expect(() =>
      assertCanManageTeaching({ id: 30, roles: [TEACHER_STAFF_ROLE] }),
    ).toThrow(ForbiddenException);
  });

  it('ưu tiên phạm vi rộng nhất khi có nhiều role', () => {
    expect(
      resolveTeachingScope({ id: 3, roles: [TEACHER_STAFF_ROLE, HR_ROLE] }),
    ).toEqual({ kind: 'manage' });
  });

  it('role sales chỉ xem lịch của trường mình phụ trách', () => {
    expect(resolveTeachingScope({ id: 40, roles: ['sales'] })).toEqual({
      kind: 'own-schools',
      employeeId: 40,
    });
    expect(() => assertCanManageTeaching({ id: 40, roles: ['sales'] })).toThrow(
      ForbiddenException,
    );
  });

  it('sales kèm role quản lý thì lấy quyền rộng hơn', () => {
    expect(resolveTeachingScope({ id: 41, roles: ['sales', HR_ROLE] })).toEqual(
      {
        kind: 'manage',
      },
    );
    expect(
      resolveTeachingScope({ id: 42, roles: ['sales', 'director'] }),
    ).toEqual({ kind: 'view' });
  });

  it.each([[['thuquy']], [[]]])('role %s không có quyền', (roles) => {
    expect(() => resolveTeachingScope({ id: 4, roles })).toThrow(
      ForbiddenException,
    );
  });

  it('không có token thì 401', () => {
    expect(() => resolveTeachingScope(undefined)).toThrow(
      UnauthorizedException,
    );
  });
});

// ============================================================
// 2. Tiện ích thời gian / ngày
// ============================================================

describe('teaching.util', () => {
  it('chuyển đổi giờ hai chiều', () => {
    expect(toDbTime('07:30')).toBe('07:30:00');
    expect(toDbTime('07:30:00')).toBe('07:30:00');
    expect(toDisplayTime('07:30:00')).toBe('07:30');
    expect(toDisplayTime(null)).toBeNull();
  });

  it('toDateString không lệch ngày theo timezone', () => {
    expect(toDateString('2026-08-04T23:30:00.000Z')).toBe('2026-08-04');
    expect(toDateString(new Date(2026, 7, 4))).toBe('2026-08-04');
    expect(toDateString(null)).toBeNull();
  });

  it('dayOfWeekOf theo quy ước 2=Thứ Hai … 8=Chủ Nhật', () => {
    expect(dayOfWeekOf('2026-08-03')).toBe(2); // Thứ Hai
    expect(dayOfWeekOf('2026-08-08')).toBe(7); // Thứ Bảy
    expect(dayOfWeekOf('2026-08-09')).toBe(8); // Chủ Nhật
  });

  it('liệt kê đúng các ngày rơi vào thứ chỉ định', () => {
    // Tháng 8/2026: các thứ Ba là 4, 11, 18, 25.
    expect(listDatesForDayOfWeek('2026-08-01', '2026-08-31', 3)).toEqual([
      '2026-08-04',
      '2026-08-11',
      '2026-08-18',
      '2026-08-25',
    ]);
  });

  it('liệt kê Chủ Nhật (dayOfWeek = 8)', () => {
    expect(listDatesForDayOfWeek('2026-08-01', '2026-08-16', 8)).toEqual([
      '2026-08-02',
      '2026-08-09',
      '2026-08-16',
    ]);
  });

  it('khoảng rỗng khi không có ngày nào khớp', () => {
    expect(listDatesForDayOfWeek('2026-08-03', '2026-08-05', 8)).toEqual([]);
  });

  it('chạm biên giờ không tính là trùng', () => {
    expect(timeRangesOverlap('07:30', '09:00', '09:00', '10:30')).toBe(false);
    expect(timeRangesOverlap('07:30', '09:00', '08:30', '10:00')).toBe(true);
    expect(timeRangesOverlap('07:30', '09:00', '07:00', '10:00')).toBe(true);
  });
});

// ============================================================
// 3. Validate DTO
// ============================================================

describe('Validate DTO', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });

  const transform = (metatype: any, value: Record<string, unknown>) =>
    pipe.transform(value, { type: 'body', metatype, data: '' });

  it('ép kiểu số và giữ nguyên giờ', async () => {
    const result: any = await transform(CreateTeachingScheduleDto, {
      ...validSchedule,
      teacherId: '5',
      dayOfWeek: '3',
    });

    expect(result.teacherId).toBe(5);
    expect(result.dayOfWeek).toBe(3);
    expect(result.startTime).toBe('07:30');
  });

  it.each([
    ['dayOfWeek = 1 (không có thứ 1)', { dayOfWeek: 1 }],
    ['dayOfWeek = 9', { dayOfWeek: 9 }],
    ['startTime sai định dạng', { startTime: '7h30' }],
    ['startTime giờ không tồn tại', { startTime: '25:00' }],
    ['effectiveFrom không phải ngày thật', { effectiveFrom: '2026-02-31' }],
    ['teacherId = 0', { teacherId: 0 }],
  ])('lịch dạy trả 400 khi %s', async (_label, override) => {
    await expect(
      transform(CreateTeachingScheduleDto, { ...validSchedule, ...override }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['thiếu tên', { name: undefined }],
    ['tên quá ngắn', { name: 'A' }],
    ['email sai', { email: 'not-an-email' }],
    [
      'link vị trí không phải Google Maps',
      { googleMapsUrl: 'https://example.com/map' },
    ],
    ['trùng xã/phường được chọn', { wardIds: [1, 1] }],
    ['ID môn không hợp lệ', { subjectCatalogIds: [0] }],
  ])('giáo viên trả 400 khi %s', async (_label, override) => {
    await expect(
      transform(CreateTeacherDto, { name: 'Cô A', ...override }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('buổi dạy trả 400 khi date không hợp lệ', async () => {
    await expect(
      transform(CreateTeachingSessionDto, {
        ...validSession,
        date: '11-08-2026',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ============================================================
// 4. Lịch dạy (mẫu lặp)
// ============================================================

describe('TeachingScheduleService', () => {
  it('tạo được mẫu lịch hợp lệ và chuẩn hoá giờ về HH:mm:ss', async () => {
    const { service, schedule } = makeScheduleService();

    await service.create(validSchedule);

    expect(schedule.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: 5,
        dayOfWeek: 3,
        startTime: '07:30:00',
        endTime: '09:00:00',
        effectiveFrom: '2026-08-01',
        effectiveTo: '2027-05-31',
        isActive: true,
      }),
    );
  });

  it('POST trả về cùng shape với GET: giờ "07:30", có nhãn thứ và tên trường', async () => {
    const { service } = makeScheduleService();

    const result = await service.create(validSchedule);

    expect(result).toMatchObject({
      startTime: '07:30',
      endTime: '09:00',
      dayOfWeekLabel: 'Thứ Ba',
      teacherName: 'Cô A',
      schoolName: 'Trường ABC',
      effectiveFrom: '2026-08-01',
    });
  });

  it('từ chối khi startTime >= endTime', async () => {
    const { service } = makeScheduleService();

    await expect(
      service.create({
        ...validSchedule,
        startTime: '09:00',
        endTime: '07:30',
      }),
    ).rejects.toThrow('startTime phải nhỏ hơn endTime');
  });

  it('từ chối khi effectiveFrom > effectiveTo', async () => {
    const { service } = makeScheduleService();

    await expect(
      service.create({
        ...validSchedule,
        effectiveFrom: '2027-01-01',
        effectiveTo: '2026-01-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('từ chối giáo viên đang ngừng hoạt động', async () => {
    const { service } = makeScheduleService({
      teacher: { id: 5, name: 'Cô A', isActive: false },
    });

    await expect(service.create(validSchedule)).rejects.toThrow(
      'đang ngừng hoạt động',
    );
  });

  it('từ chối môn học không thuộc trường đã chọn', async () => {
    const { service } = makeScheduleService({
      subject: { id: 25, name: 'STEM', schoolId: 999 },
    });

    await expect(service.create(validSchedule)).rejects.toThrow(
      'Môn học không thuộc trường đã chọn',
    );
  });

  it('chặn trùng lịch giáo viên (409)', async () => {
    const { service } = makeScheduleService({
      conflict: {
        id: 3,
        startTime: '08:00:00',
        endTime: '09:30:00',
        schoolName: 'Trường ABC',
      },
    });

    await expect(service.create(validSchedule)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('kiểm tra trùng lịch bằng SQL: cùng thứ, giao giờ, giao khoảng hiệu lực', async () => {
    const { service, schedule } = makeScheduleService();

    await service.create(validSchedule);

    const sqls = schedule.qb.andWhere.mock.calls.map((c: any[]) => c[0]);
    expect(sqls).toEqual(
      expect.arrayContaining([
        's.dayOfWeek = :dayOfWeek',
        's.isActive = true',
        's.effectiveFrom <= :candidateTo',
        '(s.effectiveTo IS NULL OR s.effectiveTo >= :candidateFrom)',
        's.startTime < :endTime',
        's.endTime > :startTime',
      ]),
    );
  });

  it('coi effectiveTo rỗng là vô hạn khi so trùng', async () => {
    const { service, schedule } = makeScheduleService();

    await service.create({ ...validSchedule, effectiveTo: undefined });

    const call = schedule.qb.andWhere.mock.calls.find(
      (c: any[]) => c[0] === 's.effectiveFrom <= :candidateTo',
    );
    expect(call[1]).toEqual({ candidateTo: '9999-12-31' });
  });

  describe('mẫu lịch tuần của tôi', () => {
    it('lấy teacherId từ token, bỏ qua teacherId FE gửi lên', async () => {
      const { service, schedule, teacher } = makeScheduleService();
      teacher.repo.findOne = jest.fn().mockResolvedValue({ id: 5 });

      await service.findMine(30, { teacherId: 999 } as any);

      expect(teacher.repo.findOne).toHaveBeenCalledWith({
        where: { employeeId: 30 },
      });
      const call = schedule.qb.andWhere.mock.calls.find(
        (c: any[]) => c[0] === 's.teacherId = :teacherId',
      );
      expect(call[1]).toEqual({ teacherId: 5 });
    });

    it('404 khi tài khoản chưa gắn hồ sơ giáo viên', async () => {
      const { service, teacher } = makeScheduleService();
      teacher.repo.findOne = jest.fn().mockResolvedValue(null);

      await expect(service.findMine(30, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('xác nhận / từ chối lịch dạy', () => {
    function pendingSchedule(over: Record<string, any> = {}) {
      return {
        id: 1,
        dayOfWeek: 3,
        startTime: '07:30:00',
        endTime: '09:00:00',
        effectiveFrom: '2026-08-01',
        effectiveTo: null,
        isActive: true,
        confirmationStatus: 'PENDING',
        confirmedAt: null,
        rejectionReason: null,
        teacher: { id: 5, name: 'Cô A', employeeId: 30 },
        ...over,
      };
    }

    it('không phải giáo viên đứng tên thì bị từ chối (403)', async () => {
      const { service, schedule } = makeScheduleService();
      schedule.repo.findOne = jest.fn().mockResolvedValue(pendingSchedule());

      await expect(
        service.confirm(1, 999, { status: 'CONFIRMED' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lịch đã xử lý rồi thì không xác nhận lại được (409)', async () => {
      const { service, schedule } = makeScheduleService();
      schedule.repo.findOne = jest
        .fn()
        .mockResolvedValue(
          pendingSchedule({ confirmationStatus: 'CONFIRMED' }),
        );

      await expect(
        service.confirm(1, 30, { status: 'CONFIRMED' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('từ chối mà không nêu lý do thì bị chặn (400)', async () => {
      const { service, schedule } = makeScheduleService();
      schedule.repo.findOne = jest.fn().mockResolvedValue(pendingSchedule());

      await expect(
        service.confirm(1, 30, { status: 'REJECTED' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('xác nhận thành công: lưu trạng thái và báo Giáo vụ/Nhân sự + giáo viên', async () => {
      const { service, schedule, notificationService } = makeScheduleService();
      schedule.repo.findOne = jest.fn().mockResolvedValue(pendingSchedule());
      // confirm() kết thúc bằng findOne(id) (raw query, không đi qua findOne()
      // của repo) — dựng sẵn kết quả để không lẫn với mock trùng lịch của create().
      schedule.qb.getRawOne = jest.fn().mockResolvedValue({
        id: 1,
        teacherId: 5,
        teacherName: 'Cô A',
        schoolId: 10,
        schoolName: 'Trường ABC',
        subjectId: 25,
        subjectName: 'STEM',
        dayOfWeek: 3,
        startTime: '07:30:00',
        endTime: '09:00:00',
        effectiveFrom: '2026-08-01',
        confirmationStatus: 'CONFIRMED',
      });

      await service.confirm(1, 30, { status: 'CONFIRMED' } as any);

      expect(schedule.repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ confirmationStatus: 'CONFIRMED' }),
      );
      // Echo cho chính giáo viên (employeeId 30) + báo Giáo vụ/Nhân sự.
      expect(notificationService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          receiverId: 30,
          type: NotificationType.TEACHING_SCHEDULE_CONFIRM_RESULT,
        }),
      );
    });

    it('từ chối kèm lý do: lưu rejectionReason', async () => {
      const { service, schedule } = makeScheduleService();
      schedule.repo.findOne = jest.fn().mockResolvedValue(pendingSchedule());
      schedule.qb.getRawOne = jest.fn().mockResolvedValue({
        id: 1,
        teacherId: 5,
        teacherName: 'Cô A',
        schoolId: 10,
        schoolName: 'Trường ABC',
        subjectId: 25,
        subjectName: 'STEM',
        dayOfWeek: 3,
        startTime: '07:30:00',
        endTime: '09:00:00',
        effectiveFrom: '2026-08-01',
        confirmationStatus: 'REJECTED',
        rejectionReason: 'Trùng lịch cá nhân',
      });

      await service.confirm(1, 30, {
        status: 'REJECTED',
        reason: 'Trùng lịch cá nhân',
      } as any);

      expect(schedule.repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmationStatus: 'REJECTED',
          rejectionReason: 'Trùng lịch cá nhân',
        }),
      );
    });

    describe('tự động sinh buổi khi xác nhận', () => {
      function confirmedRawRow(over: Record<string, any> = {}) {
        return {
          id: 1,
          teacherId: 5,
          teacherName: 'Cô A',
          schoolId: 10,
          schoolName: 'Trường ABC',
          subjectId: 25,
          subjectName: 'STEM',
          dayOfWeek: 3,
          startTime: '07:30:00',
          endTime: '09:00:00',
          effectiveFrom: '2026-08-01',
          confirmationStatus: 'CONFIRMED',
          ...over,
        };
      }

      it('xác nhận thành công: chốt buổi PENDING có sẵn và gọi generateSessions cho cả effectiveFrom→effectiveTo', async () => {
        const { service, schedule, session } = makeScheduleService();
        schedule.repo.findOne = jest
          .fn()
          .mockResolvedValue(
            pendingSchedule({
              isActive: true,
              effectiveFrom: '2026-08-01',
              effectiveTo: '2026-08-31',
            }),
          );
        schedule.qb.getRawOne = jest.fn().mockResolvedValue(confirmedRawRow());
        session.repo.update = jest.fn().mockResolvedValue({ affected: 2 });
        const generateSpy = jest
          .spyOn(service, 'generateSessions')
          .mockResolvedValue({ created: 4, skipped: 0, dates: [] });

        await service.confirm(1, 30, { status: 'CONFIRMED' } as any);

        expect(session.repo.update).toHaveBeenCalledWith(
          { scheduleId: 1, confirmationStatus: 'PENDING' },
          expect.objectContaining({ confirmationStatus: 'CONFIRMED' }),
        );
        expect(generateSpy).toHaveBeenCalledWith(1, {
          fromDate: '2026-08-01',
          toDate: '2026-08-31',
        });
      });

      it('effectiveTo bỏ trống: cắt ở 400 ngày kể từ effectiveFrom thay vì để trống', async () => {
        const { service, schedule, session } = makeScheduleService();
        schedule.repo.findOne = jest
          .fn()
          .mockResolvedValue(
            pendingSchedule({
              isActive: true,
              effectiveFrom: '2026-01-01',
              effectiveTo: null,
            }),
          );
        schedule.qb.getRawOne = jest.fn().mockResolvedValue(confirmedRawRow());
        session.repo.update = jest.fn().mockResolvedValue({ affected: 0 });
        const generateSpy = jest
          .spyOn(service, 'generateSessions')
          .mockResolvedValue({ created: 0, skipped: 0, dates: [] });

        await service.confirm(1, 30, { status: 'CONFIRMED' } as any);

        expect(generateSpy).toHaveBeenCalledWith(1, {
          fromDate: '2026-01-01',
          toDate: '2027-02-05', // 2026-01-01 + 400 ngày
        });
      });

      it('effectiveTo quá xa (>400 ngày): vẫn cắt ở 400 ngày, không ném lỗi khoảng quá dài', async () => {
        const { service, schedule, session } = makeScheduleService();
        schedule.repo.findOne = jest
          .fn()
          .mockResolvedValue(
            pendingSchedule({
              isActive: true,
              effectiveFrom: '2026-01-01',
              effectiveTo: '2030-01-01',
            }),
          );
        schedule.qb.getRawOne = jest.fn().mockResolvedValue(confirmedRawRow());
        session.repo.update = jest.fn().mockResolvedValue({ affected: 0 });
        const generateSpy = jest
          .spyOn(service, 'generateSessions')
          .mockResolvedValue({ created: 0, skipped: 0, dates: [] });

        await service.confirm(1, 30, { status: 'CONFIRMED' } as any);

        expect(generateSpy).toHaveBeenCalledWith(1, {
          fromDate: '2026-01-01',
          toDate: '2027-02-05',
        });
      });

      it('từ chối lịch thì KHÔNG chốt buổi PENDING cũng không tự sinh buổi', async () => {
        const { service, schedule, session } = makeScheduleService();
        schedule.repo.findOne = jest
          .fn()
          .mockResolvedValue(pendingSchedule({ isActive: true }));
        schedule.qb.getRawOne = jest
          .fn()
          .mockResolvedValue(
            confirmedRawRow({
              confirmationStatus: 'REJECTED',
              rejectionReason: 'Bận việc',
            }),
          );
        session.repo.update = jest.fn().mockResolvedValue({ affected: 0 });
        const generateSpy = jest.spyOn(service, 'generateSessions');

        await service.confirm(1, 30, {
          status: 'REJECTED',
          reason: 'Bận việc',
        } as any);

        expect(session.repo.update).not.toHaveBeenCalled();
        expect(generateSpy).not.toHaveBeenCalled();
      });

      it('generateSessions lỗi thì confirm() vẫn trả về thành công (không rớt cho giáo viên)', async () => {
        const { service, schedule, session } = makeScheduleService();
        schedule.repo.findOne = jest
          .fn()
          .mockResolvedValue(pendingSchedule({ isActive: true }));
        schedule.qb.getRawOne = jest.fn().mockResolvedValue(confirmedRawRow());
        session.repo.update = jest.fn().mockResolvedValue({ affected: 0 });
        jest
          .spyOn(service, 'generateSessions')
          .mockRejectedValue(new Error('DB tạm thời lỗi'));

        await expect(
          service.confirm(1, 30, { status: 'CONFIRMED' } as any),
        ).resolves.toMatchObject({ id: 1 });
      });
    });
  });
});

// ============================================================
// 5. Sinh buổi dạy từ mẫu lặp
// ============================================================

describe('TeachingScheduleService.generateSessions', () => {
  function setup(overrides: Record<string, any> = {}) {
    const ctx = makeScheduleService();
    ctx.schedule.repo.findOne = jest.fn().mockResolvedValue({
      id: 1,
      teacherId: 5,
      schoolId: 10,
      subjectId: 25,
      dayOfWeek: 3,
      startTime: '07:30:00',
      endTime: '09:00:00',
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-08-31',
      isActive: true,
      ...overrides,
    });
    return ctx;
  }

  it('sinh đúng các thứ Ba trong khoảng', async () => {
    const { service, session } = setup();

    const result = await service.generateSessions(1, {
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
    });

    expect(result.created).toBe(4);
    expect(result.dates).toEqual([
      '2026-08-04',
      '2026-08-11',
      '2026-08-18',
      '2026-08-25',
    ]);
    expect(session.repo.insert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          scheduleId: 1,
          teacherId: 5,
          date: '2026-08-04',
          startTime: '07:30:00',
          status: SessionStatus.SCHEDULED,
        }),
      ]),
    );
  });

  it('chạy lại không nhân đôi — buổi đã có thì bỏ qua', async () => {
    const { service, session } = setup();
    session.qb.getRawMany.mockResolvedValue([
      { date: '2026-08-04' },
      { date: '2026-08-11' },
    ]);

    const result = await service.generateSessions(1, {
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
    });

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.dates).toEqual(['2026-08-18', '2026-08-25']);
  });

  it('chỉ sinh trong phần giao với khoảng hiệu lực của mẫu', async () => {
    const { service } = setup({
      effectiveFrom: '2026-08-10',
      effectiveTo: '2026-08-20',
    });

    const result = await service.generateSessions(1, {
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
    });

    expect(result.dates).toEqual(['2026-08-11', '2026-08-18']);
  });

  it('không sinh gì khi khoảng yêu cầu nằm ngoài hiệu lực', async () => {
    const { service, session } = setup({
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-09-30',
    });

    const result = await service.generateSessions(1, {
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
    });

    expect(result).toEqual({ created: 0, skipped: 0, dates: [] });
    expect(session.repo.insert).not.toHaveBeenCalled();
  });

  it('từ chối mẫu đang ngừng áp dụng', async () => {
    const { service } = setup({ isActive: false });

    await expect(
      service.generateSessions(1, {
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      }),
    ).rejects.toThrow('ngừng áp dụng');
  });

  it('từ chối khoảng ngày quá dài', async () => {
    const { service } = setup();

    await expect(
      service.generateSessions(1, {
        fromDate: '2026-01-01',
        toDate: '2028-01-01',
      }),
    ).rejects.toThrow('tối đa 400 ngày');
  });

  it('từ chối fromDate > toDate', async () => {
    const { service } = setup();

    await expect(
      service.generateSessions(1, {
        fromDate: '2026-08-31',
        toDate: '2026-08-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ============================================================
// 6. Buổi dạy + chấm công
// ============================================================

describe('TeachingSessionService', () => {
  it('tạo buổi lẻ với scheduleId = null', async () => {
    const { service, session } = makeSessionService();
    session.qb.getRawOne
      .mockResolvedValueOnce(undefined) // trùng giờ giáo viên
      .mockResolvedValueOnce(undefined) // trùng giờ lớp
      .mockResolvedValue({ id: 1, date: '2026-08-11', status: 'SCHEDULED' });

    await service.create(validSession);

    expect(session.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: null,
        isMakeup: false,
        makeupForSessionId: null,
        status: SessionStatus.SCHEDULED,
      }),
    );
  });

  it('tạo buổi dạy bù thì tự bật isMakeup', async () => {
    const { service, session } = makeSessionService();
    session.repo.findOne = jest.fn().mockResolvedValue({ id: 99 });
    session.qb.getRawOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: 1, date: '2026-08-12', status: 'SCHEDULED' });

    await service.create({ ...validSession, makeupForSessionId: 99 });

    expect(session.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ isMakeup: true, makeupForSessionId: 99 }),
    );
  });

  it('chặn giáo viên dạy 2 buổi giao giờ cùng ngày (409)', async () => {
    const { service } = makeSessionService({
      conflict: {
        id: 7,
        startTime: '08:00:00',
        endTime: '09:30:00',
        schoolName: 'Trường ABC',
      },
    });

    await expect(service.create(validSession)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('buổi đã huỷ không chiếm chỗ khi kiểm tra trùng', async () => {
    const { service, session } = makeSessionService();
    session.qb.getRawOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: 1, date: '2026-08-11', status: 'SCHEDULED' });

    await service.create(validSession);

    const call = session.qb.andWhere.mock.calls.find(
      (c: any[]) => c[0] === 'ss.status IN (:...statuses)',
    );
    expect(call[1].statuses).not.toContain(SessionStatus.CANCELLED);
  });

  describe('chấm công', () => {
    function setupCheck(status = SessionStatus.SCHEDULED) {
      const ctx = makeSessionService();
      const entity: any = { id: 1, status, checkedById: null, checkedAt: null };
      ctx.session.repo.findOne = jest.fn().mockResolvedValue(entity);
      ctx.session.qb.getRawOne.mockResolvedValue({
        id: 1,
        date: '2026-08-11',
        status,
      });
      return { ...ctx, entity };
    }

    it.each([
      [SessionStatus.PRESENT],
      [SessionStatus.ABSENT],
      [SessionStatus.EXCUSED],
      [SessionStatus.CANCELLED],
    ])('ghi lại người chấm khi chuyển sang %s', async (status) => {
      const { service, entity } = setupCheck();

      await service.checkAttendance(1, { status }, 77);

      expect(entity.status).toBe(status);
      expect(entity.checkedById).toBe(77);
      expect(entity.checkedAt).toBeInstanceOf(Date);
    });

    it('bỏ chấm (về SCHEDULED) thì xoá dấu vết người chấm', async () => {
      const { service, entity } = setupCheck(SessionStatus.PRESENT);
      entity.checkedById = 77;
      entity.checkedAt = new Date();

      await service.checkAttendance(1, { status: SessionStatus.SCHEDULED }, 77);

      expect(entity.checkedById).toBeNull();
      expect(entity.checkedAt).toBeNull();
    });

    it('lưu ghi chú chấm công', async () => {
      const { service, entity } = setupCheck();

      await service.checkAttendance(
        1,
        { status: SessionStatus.EXCUSED, attendanceNote: 'Xin phép ốm' },
        77,
      );

      expect(entity.attendanceNote).toBe('Xin phép ốm');
    });

    it('lưu các chi phí khác và tính tổng theo buổi', async () => {
      const { service, entity } = setupCheck();

      await service.checkAttendance(
        1,
        {
          status: SessionStatus.PRESENT,
          otherCosts: [
            { name: 'Xăng xe', amount: 50000 },
            { name: 'Phụ cấp', amount: 100000, note: 'Dạy xa' },
          ],
        },
        77,
      );

      expect(entity.otherCosts).toEqual([
        { name: 'Xăng xe', amount: 50000, note: null },
        { name: 'Phụ cấp', amount: 100000, note: 'Dạy xa' },
      ]);
      expect(entity.otherCostsTotal).toBe(150000);
    });

    it('bỏ chấm thì xoá các chi phí khác', async () => {
      const { service, entity } = setupCheck(SessionStatus.PRESENT);
      entity.otherCosts = [{ name: 'Xăng xe', amount: 50000 }];
      entity.otherCostsTotal = 50000;

      await service.checkAttendance(1, { status: SessionStatus.SCHEDULED }, 77);

      expect(entity.otherCosts).toEqual([]);
      expect(entity.otherCostsTotal).toBe(0);
    });

    it('buổi không tồn tại thì 404', async () => {
      const { service, session } = makeSessionService();
      session.repo.findOne = jest.fn().mockResolvedValue(null);

      await expect(
        service.checkAttendance(999, { status: SessionStatus.PRESENT }, 77),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('chấm công hàng loạt', () => {
    it('chấm nhiều buổi trong một lần lưu', async () => {
      const { service, session } = makeSessionService();
      const rows = [
        { id: 1, status: SessionStatus.SCHEDULED },
        { id: 2, status: SessionStatus.SCHEDULED },
      ];
      session.repo.find = jest.fn().mockResolvedValue(rows);

      const result = await service.bulkCheckAttendance(
        {
          items: [
            { sessionId: 1, status: SessionStatus.PRESENT },
            { sessionId: 2, status: SessionStatus.ABSENT },
          ],
        },
        77,
      );

      expect(result).toEqual({ updated: 2, sessionIds: [1, 2] });
      expect(rows[0].status).toBe(SessionStatus.PRESENT);
      expect(rows[1].status).toBe(SessionStatus.ABSENT);
      expect(session.repo.save).toHaveBeenCalledTimes(1);
    });

    it('từ chối khi có sessionId trùng nhau', async () => {
      const { service } = makeSessionService();

      await expect(
        service.bulkCheckAttendance(
          {
            items: [
              { sessionId: 1, status: SessionStatus.PRESENT },
              { sessionId: 1, status: SessionStatus.ABSENT },
            ],
          },
          77,
        ),
      ).rejects.toThrow('trùng nhau');
    });

    it('404 và nêu rõ id không tìm thấy', async () => {
      const { service, session } = makeSessionService();
      session.repo.find = jest.fn().mockResolvedValue([{ id: 1 }]);

      await expect(
        service.bulkCheckAttendance(
          {
            items: [
              { sessionId: 1, status: SessionStatus.PRESENT },
              { sessionId: 404, status: SessionStatus.PRESENT },
            ],
          },
          77,
        ),
      ).rejects.toThrow('404');
    });
  });

  it('không xoá được buổi đã chấm công', async () => {
    const { service, session } = makeSessionService();
    session.repo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 1, status: SessionStatus.PRESENT });

    await expect(service.remove(1)).rejects.toBeInstanceOf(ConflictException);
  });

  it('xoá được buổi chưa chấm công', async () => {
    const { service, session } = makeSessionService();
    session.repo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 1, status: SessionStatus.SCHEDULED });

    await expect(service.remove(1)).resolves.toEqual({ deleted: true });
  });

  describe('lịch của tôi', () => {
    it('lấy teacherId từ token, bỏ qua teacherId FE gửi lên', async () => {
      const { service, session, teacher } = makeSessionService();
      teacher.repo.findOne = jest.fn().mockResolvedValue({ id: 5 });

      await service.findMine(30, { teacherId: 999 } as any);

      expect(teacher.repo.findOne).toHaveBeenCalledWith({
        where: { employeeId: 30 },
      });
      const call = session.qb.andWhere.mock.calls.find(
        (c: any[]) => c[0] === 'ss.teacherId = :teacherId',
      );
      expect(call[1]).toEqual({ teacherId: 5 });
    });

    it('404 khi tài khoản chưa gắn hồ sơ giáo viên', async () => {
      const { service, teacher } = makeSessionService();
      teacher.repo.findOne = jest.fn().mockResolvedValue(null);

      await expect(service.findMine(30, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('lọc và phân trang', () => {
    it('lọc theo khoảng ngày', async () => {
      const { service, session } = makeSessionService();

      await service.findAll({ fromDate: '2026-08-01', toDate: '2026-08-31' });

      const sqls = session.qb.andWhere.mock.calls.map((c: any[]) => c[0]);
      expect(sqls).toEqual(
        expect.arrayContaining(['ss.date >= :fromDate', 'ss.date <= :toDate']),
      );
    });

    it('từ chối fromDate > toDate', async () => {
      const { service } = makeSessionService();

      await expect(
        service.findAll({ fromDate: '2026-08-31', toDate: '2026-08-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unchecked = chỉ buổi chưa chấm', async () => {
      const { service, session } = makeSessionService();

      await service.findAll({ unchecked: true });

      const call = session.qb.andWhere.mock.calls.find(
        (c: any[]) => c[0] === 'ss.status = :scheduledStatus',
      );
      expect(call[1]).toEqual({ scheduledStatus: SessionStatus.SCHEDULED });
    });

    it('phân trang dưới database và chặn limit quá lớn', async () => {
      const { service, session } = makeSessionService();

      await service.findAll({ page: 3, limit: 5000 });

      expect(session.qb.limit).toHaveBeenCalledWith(200);
      expect(session.qb.offset).toHaveBeenCalledWith(400);
    });

    it('trả pagination hợp lệ khi không có dữ liệu', async () => {
      const { service } = makeSessionService();

      const result = await service.findAll({});

      expect(result.data).toEqual([]);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 50,
        total: 0,
        totalPages: 0,
      });
    });

    it('map dòng raw sang item có nhãn tiếng Việt', async () => {
      const { service, session } = makeSessionService();
      session.qb.getCount.mockResolvedValue(1);
      session.qb.getRawMany.mockResolvedValue([
        {
          id: 1,
          scheduleId: 2,
          teacherId: 5,
          teacherName: 'Cô A',
          schoolId: 10,
          schoolName: 'Trường ABC',
          subjectId: 25,
          subjectName: 'STEM',
          schoolYear: '2026-2027',
          date: '2026-08-11',
          startTime: '07:30:00',
          endTime: '09:00:00',
          status: SessionStatus.PRESENT,
          isMakeup: false,
          makeupForSessionId: null,
          attendanceNote: null,
          checkedById: 77,
          checkedByName: 'Nhân sự',
          checkedAt: '2026-08-11T02:00:00.000Z',
          note: null,
        },
      ]);

      const result = await service.findAll({});

      expect(result.data[0]).toMatchObject({
        id: 1,
        date: '2026-08-11',
        dayOfWeek: 3,
        dayOfWeekLabel: 'Thứ Ba',
        startTime: '07:30',
        endTime: '09:00',
        status: SessionStatus.PRESENT,
        statusLabel: 'Có dạy',
        checkedByName: 'Nhân sự',
        checkedAt: '2026-08-11T02:00:00.000Z',
      });
    });
  });

  describe('tổng hợp chấm công', () => {
    it('gom nhóm theo giáo viên dưới database', async () => {
      const { service, session } = makeSessionService();
      session.qb.getRawMany.mockResolvedValue([
        {
          teacherId: 5,
          teacherName: 'Cô A',
          totalSessions: '10',
          present: '7',
          absent: '1',
          excused: '1',
          cancelled: '1',
          unchecked: '0',
          makeup: '2',
          totalPeriods: '10',
          payablePeriods: '7',
          payableAmount: '1400000',
          otherCostsAmount: '300000',
          totalPayableAmount: '1700000',
          missingRateSessions: '0',
        },
      ]);

      const result = await service.attendanceSummary({
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });

      expect(session.qb.groupBy).toHaveBeenCalledWith('ss.teacherId');
      expect(result.data[0]).toEqual({
        teacherId: 5,
        teacherName: 'Cô A',
        totalSessions: 10,
        present: 7,
        absent: 1,
        excused: 1,
        cancelled: 1,
        unchecked: 0,
        makeup: 2,
        totalPeriods: 10,
        payablePeriods: 7,
        payableAmount: 1400000,
        otherCostsAmount: 300000,
        fuelAllowanceAmount: 0,
        totalPayableAmount: 1700000,
        missingRateSessions: 0,
      });
    });

    it('từ chối khoảng ngày ngược', async () => {
      const { service } = makeSessionService();

      await expect(
        service.attendanceSummary({
          fromDate: '2026-08-31',
          toDate: '2026-08-01',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('phụ cấp xăng gộp theo mỗi lần đến trường (block), không cộng theo từng tiết', async () => {
      const { service, session } = makeSessionService();
      session.qb.getRawMany
        .mockResolvedValueOnce([
          {
            teacherId: 8,
            teacherName: 'Thầy C',
            totalSessions: '3',
            present: '3',
            absent: '0',
            excused: '0',
            cancelled: '0',
            unchecked: '0',
            makeup: '0',
            totalPeriods: '3',
            payablePeriods: '3',
            payableAmount: '0',
            otherCostsAmount: '0',
            totalPayableAmount: '0',
            missingRateSessions: '0',
          },
        ])
        .mockResolvedValueOnce([
          // 2 tiết liên tiếp cùng trường 10 sáng -> 1 block; tiết trường 20
          // chiều -> block khác (xen trường khác giữa 2 lần tới trường 10).
          {
            teacherId: 8,
            schoolId: 10,
            date: '2026-08-05',
            startTime: '07:30:00',
            gasAllowance: '20000',
          },
          {
            teacherId: 8,
            schoolId: 10,
            date: '2026-08-05',
            startTime: '08:15:00',
            gasAllowance: '20000',
          },
          {
            teacherId: 8,
            schoolId: 20,
            date: '2026-08-05',
            startTime: '13:00:00',
            gasAllowance: '30000',
          },
        ]);

      const result = await service.attendanceSummary({
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });

      // 2 tiết đầu cùng 1 block chỉ tính 1 lần 20.000 + block chiều 30.000.
      expect(result.data[0].fuelAllowanceAmount).toBe(50_000);
      expect(result.data[0].totalPayableAmount).toBe(50_000);
      expect(result.grandTotal.fuelAllowanceAmount).toBe(50_000);
    });
  });
});

// ============================================================
// 7. Hồ sơ giáo viên
// ============================================================

describe('TeacherService', () => {
  function setup(
    overrides: {
      teacher?: any;
      employee?: any;
      sessions?: number;
      /** Dòng raw mà findOne/create/update đọc lại sau khi lưu. */
      row?: any;
    } = {},
  ) {
    const teacher = makeRepo({
      findOne: jest.fn().mockResolvedValue(overrides.teacher ?? null),
    });

    teacher.qb.getRawOne.mockResolvedValue(
      overrides.row === undefined
        ? { id: 1, name: 'Cô A', employeeId: null, isActive: true }
        : overrides.row,
    );
    const session = makeRepo({
      count: jest.fn().mockResolvedValue(overrides.sessions ?? 0),
    });
    const employee = makeRepo({
      findOne: jest.fn().mockResolvedValue(overrides.employee ?? null),
    });
    const school = makeRepo();
    const subjectCatalog = makeRepo();
    const locationChange = makeRepo();

    // `create()` với password tự tạo Employee+Teacher trong transaction — cùng
    // 2 repo mock ở trên để test assert được thẳng trên `employee.repo`/`teacher.repo`.
    const dataSource = {
      transaction: jest.fn((work: any) =>
        work({
          getRepository: (target: any) =>
            target === Employee
              ? employee.repo
              : target === Teacher
                ? teacher.repo
                : undefined,
        }),
      ),
    };

    const service = new TeacherService(
      teacher.repo,
      session.repo,
      employee.repo,
      dataSource as any,
      school.repo,
      subjectCatalog.repo,
      undefined as any,
      // Link Maps hỏng không được chặn việc lưu hồ sơ, nên stub cứ ném lỗi.
      {
        resolveGoogleMaps: jest.fn().mockRejectedValue(new Error('offline')),
      } as any,
      locationChange.repo,
    );

    return {
      service,
      teacher,
      session,
      employee,
      school,
      subjectCatalog,
      locationChange,
      dataSource,
    };
  }

  it('tạo giáo viên thuê ngoài không cần tài khoản', async () => {
    const { service, teacher, employee } = setup();

    await service.create({ name: 'Cô A' });

    expect(employee.repo.findOne).not.toHaveBeenCalled();
    expect(teacher.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cô A',
        employeeId: null,
        isActive: true,
      }),
    );
  });

  it('lưu được nhiều trường, nhiều môn và vị trí Google Maps', async () => {
    const { service, teacher, school, subjectCatalog } = setup();
    school.repo.find.mockResolvedValue([
      { id: 10, name: 'Xã A' },
      { id: 12, name: 'Xã B' },
    ]);
    subjectCatalog.repo.find.mockResolvedValue([
      { id: 1, name: 'STEM' },
      { id: 3, name: 'Kỹ năng sống' },
    ]);

    await service.create({
      name: 'Cô A',
      wardIds: [10, 12],
      subjectCatalogIds: [1, 3],
      googleMapsUrl: 'https://maps.app.goo.gl/example',
    } as CreateTeacherDto);

    expect(teacher.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        googleMapsUrl: 'https://maps.app.goo.gl/example',
        allowedWards: expect.arrayContaining([{ id: 10, name: 'Xã A' }]),
        teachableSubjectCatalogs: expect.arrayContaining([
          { id: 1, name: 'STEM' },
        ]),
      }),
    );
  });

  it('từ chối ID xã/phường không tồn tại', async () => {
    const { service, school } = setup();
    school.repo.find.mockResolvedValue([{ id: 10, name: 'Xã A' }]);

    await expect(
      service.create({
        name: 'Cô A',
        wardIds: [10, 999],
      } as CreateTeacherDto),
    ).rejects.toThrow('Xã/phường không tồn tại: 999');
  });

  it('từ chối gắn tài khoản chưa có role giaovien', async () => {
    const { service } = setup({ employee: { id: 30, roles: ['sales'] } });

    await expect(
      service.create({ name: 'Cô A', employeeId: 30 }),
    ).rejects.toThrow('chưa có role giáo viên');
  });

  it('gắn được tài khoản có role giaovien', async () => {
    const { service, teacher } = setup({
      employee: { id: 30, roles: [TEACHER_STAFF_ROLE] },
    });

    await service.create({ name: 'Cô A', employeeId: 30 });

    expect(teacher.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 30 }),
    );
  });

  it('tạo tài khoản mới không chỉ định loại giáo viên thì mặc định là công ty', async () => {
    const { service, employee } = setup();

    await service.create({
      name: 'Cô A',
      phone: '0900000099',
      email: 'coa@test.local',
      password: '123456',
    } as CreateTeacherDto);

    expect(employee.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ roles: [TEACHER_STAFF_ROLE] }),
    );
  });

  it('tạo tài khoản mới chỉ định cộng tác viên thì gán đúng role đó', async () => {
    const { service, employee } = setup();

    await service.create({
      name: 'Cô A',
      phone: '0900000099',
      email: 'coa@test.local',
      password: '123456',
      teacherRole: TEACHER_COLLABORATOR_ROLE,
    } as CreateTeacherDto);

    expect(employee.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ roles: [TEACHER_COLLABORATOR_ROLE] }),
    );
  });

  it('đổi loại giáo viên qua update() giữ nguyên các role khác của tài khoản', async () => {
    const { service, teacher, employee } = setup({
      teacher: { id: 5, employeeId: 30, isActive: true },
      employee: { id: 30, roles: [TEACHER_STAFF_ROLE, 'nhansu'] },
    });

    await service.update(5, { teacherRole: TEACHER_COLLABORATOR_ROLE } as any);

    expect(employee.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        roles: expect.arrayContaining(['nhansu', TEACHER_COLLABORATOR_ROLE]),
      }),
    );
    const savedRoles = employee.repo.save.mock.calls[0][0].roles;
    expect(savedRoles).not.toContain(TEACHER_STAFF_ROLE);
  });

  it('từ chối tài khoản không tồn tại', async () => {
    const { service } = setup({ employee: null });

    await expect(
      service.create({ name: 'Cô A', employeeId: 999 }),
    ).rejects.toThrow('Tài khoản nhân viên không tồn tại');
  });

  it('không xoá được giáo viên đã có buổi dạy', async () => {
    const { service } = setup({
      teacher: { id: 5, name: 'Cô A' },
      sessions: 12,
    });

    await expect(service.remove(5)).rejects.toThrow('đã có 12 buổi dạy');
  });

  it('xoá được giáo viên chưa có buổi dạy nào', async () => {
    const { service } = setup({
      teacher: { id: 5, name: 'Cô A' },
      sessions: 0,
    });

    await expect(service.remove(5)).resolves.toEqual({ deleted: true });
  });

  it('404 khi giáo viên không tồn tại', async () => {
    const { service } = setup({ teacher: null, row: null });

    await expect(service.findOne(999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('không lộ password/fcmToken của tài khoản gắn kèm', async () => {
    const { service, teacher } = setup();

    await service.findOne(1);

    const selected: string[] = teacher.qb.select.mock.calls[0][0];
    expect(selected.join(' ')).not.toMatch(/password|fcm|e\.\*/i);
    // Chỉ lấy đúng tên tài khoản, không load cả entity Employee.
    expect(selected).toContain('e.name AS "employeeName"');
  });

  it('trả loại giáo viên trong cùng contract danh sách/chi tiết', async () => {
    const { service } = setup({
      row: {
        id: 1,
        name: 'Cô A',
        employeeId: 30,
        employeeName: 'Cô A',
        teacherRole: TEACHER_COLLABORATOR_ROLE,
        isActive: true,
      },
    });

    await expect(service.findOne(1)).resolves.toEqual(
      expect.objectContaining({ teacherRole: TEACHER_COLLABORATOR_ROLE }),
    );
  });

  it('lọc giáo viên công ty/cộng tác viên trên cùng service', async () => {
    const { service, teacher } = setup();
    teacher.qb.getCount.mockResolvedValue(0);
    teacher.qb.getRawMany.mockResolvedValue([]);

    await service.findAll({ teacherRole: TEACHER_STAFF_ROLE });

    const roleFilterCall = teacher.qb.andWhere.mock.calls.find(
      ([condition]: [unknown]) =>
        typeof condition === 'string' && condition.includes('= :teacherRole'),
    );
    expect(roleFilterCall?.[0]).toContain("WHEN 'giaovien_congty' = ANY(e.roles)");
    expect(roleFilterCall?.[0]).toContain("WHEN 'giaovien_ctv' = ANY(e.roles)");
    expect(roleFilterCall?.[1]).toEqual({ teacherRole: TEACHER_STAFF_ROLE });
  });
});

// ============================================================
// 8. Lớp học của trường
// ============================================================

describe('SchoolClassService', () => {
  const CLASS_ROW = {
    id: 7,
    schoolId: 10,
    schoolName: 'Trường ABC',
    name: '1A',
    gradeLevel: 1,
    schoolYear: '2026-2027',
    studentCount: 35,
    homeroomTeacher: 'Cô B',
    isActive: true,
    note: null,
    scheduleCount: '0',
    sessionCount: '0',
  };

  function setup(
    overrides: {
      entity?: any;
      school?: any;
      duplicate?: any;
      row?: any;
      schedules?: number;
      sessions?: number;
      subjects?: any[];
      teachers?: any[];
    } = {},
  ) {
    const schoolClass = makeRepo({
      findOne: jest.fn().mockResolvedValue(overrides.entity ?? null),
    });
    schoolClass.qb.getRawOne.mockResolvedValue(
      overrides.row === undefined ? CLASS_ROW : overrides.row,
    );
    // getOne = truy vấn kiểm tra trùng tên lớp.
    schoolClass.qb.getOne = jest
      .fn()
      .mockResolvedValue(overrides.duplicate ?? null);

    const school = makeRepo({
      findOne: jest
        .fn()
        .mockResolvedValue(
          overrides.school === undefined
            ? { id: 10, name: 'Trường ABC' }
            : overrides.school,
        ),
    });
    const schedule = makeRepo({
      count: jest.fn().mockResolvedValue(overrides.schedules ?? 0),
    });
    const session = makeRepo({
      count: jest.fn().mockResolvedValue(overrides.sessions ?? 0),
    });
    const subject = makeRepo({
      find: jest.fn().mockResolvedValue(overrides.subjects ?? []),
    });
    const teacher = makeRepo({
      find: jest.fn().mockResolvedValue(overrides.teachers ?? []),
    });

    const service = new SchoolClassService(
      schoolClass.repo,
      school.repo,
      schedule.repo,
      session.repo,
      subject.repo,
      teacher.repo,
      { resolveSubjects: jest.fn() } as any,
    );

    return {
      service,
      schoolClass,
      school,
      schedule,
      session,
      subject,
      teacher,
    };
  }

  const validClass: CreateSchoolClassDto = {
    schoolId: 10,
    name: '1A',
    schoolYear: '2026-2027',
    gradeLevel: 1,
    studentCount: 35,
  };

  it('tạo lớp cho trường và chuẩn hoá tên', async () => {
    const { service, schoolClass } = setup();

    await service.create({ ...validClass, name: '  1   A ' });

    expect(schoolClass.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolId: 10,
        name: '1 A',
        schoolYear: '2026-2027',
        isActive: true,
      }),
    );
  });

  it('từ chối trường không tồn tại', async () => {
    const { service } = setup({ school: null });

    await expect(service.create(validClass)).rejects.toThrow(
      'Trường không tồn tại',
    );
  });

  it('gắn nhiều môn đúng trường vào lớp khi tạo', async () => {
    const subjects = [
      { id: 21, name: 'STEM', schoolId: 10, schoolYear: '2026-2027' },
      { id: 22, name: 'Kỹ năng sống', schoolId: 10, schoolYear: '2026-2027' },
    ];
    const { service, schoolClass } = setup({ subjects });

    await service.create({ ...validClass, subjectIds: [21, 22] });

    expect(schoolClass.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ subjects }),
    );
  });

  it('từ chối môn không thuộc trường của lớp', async () => {
    const { service } = setup({
      subjects: [
        { id: 21, name: 'STEM', schoolId: 99, schoolYear: '2026-2027' },
      ],
    });

    await expect(
      service.create({ ...validClass, subjectIds: [21] }),
    ).rejects.toThrow('không thuộc trường đã chọn');
  });

  it('chặn trùng tên lớp trong cùng trường + năm học (409)', async () => {
    const { service } = setup({ duplicate: { id: 3, name: '1A' } });

    await expect(service.create(validClass)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('so tên lớp không phân biệt hoa/thường', async () => {
    const { service, schoolClass } = setup();

    await service.create({ ...validClass, name: '1a' });

    const sqls = schoolClass.qb.andWhere.mock.calls.map((c: any[]) => c[0]);
    expect(sqls).toContain('LOWER(c.name) = LOWER(:name)');
    expect(sqls).toContain('c.schoolYear = :schoolYear');
  });

  it('cùng tên lớp ở năm học khác vẫn tạo được', async () => {
    const { service, schoolClass } = setup({
      entity: {
        id: 7,
        schoolId: 10,
        name: '1A',
        schoolYear: '2025-2026',
        isActive: true,
      },
    });

    await service.update(7, { schoolYear: '2026-2027' });

    expect(schoolClass.qb.getOne).toHaveBeenCalled();
    expect(schoolClass.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ schoolYear: '2026-2027' }),
    );
  });

  it('không kiểm tra trùng khi update không đổi tên/năm học', async () => {
    const { service, schoolClass } = setup({
      entity: {
        id: 7,
        schoolId: 10,
        name: '1A',
        schoolYear: '2026-2027',
        isActive: true,
      },
    });

    await service.update(7, { studentCount: 40 });

    expect(schoolClass.qb.getOne).not.toHaveBeenCalled();
  });

  it('xoá được lớp chưa có lịch dạy', async () => {
    const { service } = setup({ entity: { id: 7, name: '1A' } });

    await expect(service.remove(7)).resolves.toEqual({ deleted: true, id: 7 });
  });

  it('chặn xoá lớp đã có lịch dạy (409)', async () => {
    const { service } = setup({ entity: { id: 7, name: '1A' }, schedules: 2 });

    await expect(service.remove(7)).rejects.toThrow('không xoá được');
  });

  it('chặn xoá lớp đã có buổi dạy (409)', async () => {
    const { service } = setup({ entity: { id: 7, name: '1A' }, sessions: 5 });

    await expect(service.remove(7)).rejects.toBeInstanceOf(ConflictException);
  });

  it('404 khi lớp không tồn tại', async () => {
    const { service } = setup({ row: null });

    await expect(service.findOne(999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('ép kiểu số cho các cột đếm trả về từ database', async () => {
    const { service } = setup();

    await expect(service.findOne(7)).resolves.toMatchObject({
      id: 7,
      studentCount: 35,
      scheduleCount: 0,
      sessionCount: 0,
    });
  });

  describe('resolveForScheduling', () => {
    it('trả về lớp khi hợp lệ', async () => {
      const { service } = setup({
        entity: { id: 7, name: '1A', schoolId: 10, isActive: true },
      });

      await expect(service.resolveForScheduling(7, 10)).resolves.toMatchObject({
        id: 7,
        schoolId: 10,
      });
    });

    it('400 khi lớp không tồn tại', async () => {
      const { service } = setup({ entity: null });

      await expect(service.resolveForScheduling(7)).rejects.toThrow(
        'Lớp học không tồn tại',
      );
    });

    it('400 khi lớp đã ngừng sử dụng', async () => {
      const { service } = setup({
        entity: { id: 7, name: '1A', schoolId: 10, isActive: false },
      });

      await expect(service.resolveForScheduling(7)).rejects.toThrow(
        'ngừng sử dụng',
      );
    });

    it('400 khi lớp không thuộc trường được gửi kèm', async () => {
      const { service } = setup({
        entity: { id: 7, name: '1A', schoolId: 10, isActive: true },
      });

      await expect(service.resolveForScheduling(7, 999)).rejects.toThrow(
        'không thuộc trường đã chọn',
      );
    });
  });
});

// ============================================================
// 9. Xếp lịch theo lớp
// ============================================================

describe('Xếp lịch dạy theo lớp', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const transform = (metatype: any, value: Record<string, unknown>) =>
    pipe.transform(value, { type: 'body', metatype, data: '' });

  it('mẫu lịch bắt buộc có classId', async () => {
    const { classId, ...withoutClass } = validSchedule;

    await expect(
      transform(CreateTeachingScheduleDto, withoutClass),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('mẫu lịch không cần schoolId — trường lấy theo lớp', async () => {
    const { schoolId, ...withoutSchool } = validSchedule;

    const result: any = await transform(
      CreateTeachingScheduleDto,
      withoutSchool,
    );
    expect(result.classId).toBe(7);
    expect(result.schoolId).toBeUndefined();
  });

  it('lưu classId và schoolId suy ra từ lớp', async () => {
    const { service, schedule, classService } = makeScheduleService();
    const { schoolId, ...withoutSchool } = validSchedule;

    await service.create(withoutSchool as any);

    expect(classService.resolveForScheduling).toHaveBeenCalledWith(
      7,
      undefined,
    );
    expect(schedule.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ classId: 7, schoolId: 10 }),
    );
  });

  it('400 khi lớp không thuộc trường FE gửi kèm', async () => {
    const { service } = makeScheduleService();

    await expect(
      service.create({ ...validSchedule, schoolId: 999 }),
    ).rejects.toThrow('không thuộc trường đã chọn');
  });

  it('400 khi lớp đã ngừng sử dụng', async () => {
    const { service } = makeScheduleService({
      schoolClass: { id: 7, name: '1A', schoolId: 10, isActive: false },
    });

    await expect(service.create(validSchedule)).rejects.toThrow(
      'ngừng sử dụng',
    );
  });

  it('409 khi lớp đã có lịch giao giờ cùng thứ', async () => {
    const { service } = makeScheduleService({
      classConflict: {
        id: 4,
        startTime: '08:00:00',
        endTime: '09:30:00',
        teacherName: 'Cô B',
        subjectName: 'Kỹ năng sống',
      },
    });

    await expect(service.create(validSchedule)).rejects.toThrow(
      /Lớp này đã có lịch/,
    );
  });

  it('kiểm tra trùng lịch lớp bằng SQL đúng điều kiện', async () => {
    const { service, schedule } = makeScheduleService();

    await service.create(validSchedule);

    const sqls = schedule.qb.where.mock.calls
      .concat(schedule.qb.andWhere.mock.calls)
      .map((c: any[]) => c[0]);
    expect(sqls).toEqual(
      expect.arrayContaining([
        's.classId = :classId',
        's.dayOfWeek = :dayOfWeek',
        's.startTime < :endTime',
        's.endTime > :startTime',
      ]),
    );
  });

  it('buổi dạy sinh từ mẫu mang theo classId của mẫu', async () => {
    const { service, schedule, session } = makeScheduleService();
    schedule.repo.findOne = jest.fn().mockResolvedValue({
      id: 1,
      teacherId: 5,
      schoolId: 10,
      classId: 7,
      subjectId: 25,
      dayOfWeek: 3,
      startTime: '07:30:00',
      endTime: '09:00:00',
      periods: 1,
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-08-31',
      isActive: true,
    });

    await service.generateSessions(1, {
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
    });

    const inserted = session.repo.insert.mock.calls[0][0];
    expect(inserted).toHaveLength(4);
    expect(inserted[0]).toMatchObject({ classId: 7, schoolId: 10 });
  });

  it('lịch cũ chưa gắn lớp vẫn sửa được, không kiểm tra trùng lớp', async () => {
    const { service, schedule, classService } = makeScheduleService();
    // Không còn lượt kiểm tra trùng lớp -> chỉ 1 lần undefined trước khi đọc lại bản ghi.
    schedule.qb.getRawOne
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({
        id: 1,
        teacherId: 5,
        schoolId: 10,
        classId: null,
        subjectId: 25,
        dayOfWeek: 3,
        startTime: '07:30:00',
        endTime: '09:00:00',
        effectiveFrom: '2026-08-01',
        effectiveTo: '2026-08-31',
        isActive: true,
      });
    schedule.repo.findOne = jest.fn().mockResolvedValue({
      id: 1,
      teacherId: 5,
      schoolId: 10,
      classId: null,
      subjectId: 25,
      dayOfWeek: 3,
      startTime: '07:30:00',
      endTime: '09:00:00',
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-08-31',
      isActive: true,
    });

    await service.update(1, { note: 'ghi chú' });

    expect(classService.resolveForScheduling).not.toHaveBeenCalled();
    const sqls = schedule.qb.where.mock.calls.map((c: any[]) => c[0]);
    expect(sqls).not.toContain('s.classId = :classId');
  });

  it('buổi lẻ lưu classId và suy ra trường từ lớp', async () => {
    const { service, session, classService } = makeSessionService();
    session.qb.getRawOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: 1, date: '2026-08-11', status: 'SCHEDULED' });
    const { schoolId, ...withoutSchool } = validSession;

    await service.create(withoutSchool as any);

    expect(classService.resolveForScheduling).toHaveBeenCalledWith(
      7,
      undefined,
    );
    expect(session.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ classId: 7, schoolId: 10 }),
    );
  });

  it('buổi dạy bù kế thừa lớp của buổi gốc', async () => {
    const { service, session } = makeSessionService();
    session.repo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 99, classId: 7, schoolId: 10 });
    session.qb.getRawOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: 2, date: '2026-08-12', status: 'SCHEDULED' });
    const { classId, schoolId, ...withoutClass } = validSession;

    await service.create({ ...withoutClass, makeupForSessionId: 99 } as any);

    expect(session.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ classId: 7, isMakeup: true }),
    );
  });

  it('400 khi tạo buổi mà không có cả classId lẫn schoolId', async () => {
    const { service } = makeSessionService({ schoolClass: null });
    const { classId, schoolId, ...bare } = validSession;

    await expect(service.create(bare as any)).rejects.toThrow(
      'Vui lòng chọn lớp học cho buổi dạy',
    );
  });

  it('409 khi lớp đã có buổi giao giờ trong cùng ngày', async () => {
    const { service, session } = makeSessionService();
    session.qb.getRawOne
      .mockResolvedValueOnce(undefined) // giáo viên rảnh
      .mockResolvedValueOnce({
        id: 8,
        startTime: '08:00:00',
        endTime: '09:30:00',
        className: '1A',
        subjectName: 'Kỹ năng sống',
      });

    await expect(service.create(validSession)).rejects.toThrow(/^Lớp 1A đã có/);
  });

  it('buổi CANCELLED không chiếm chỗ của lớp', async () => {
    const { service, session } = makeSessionService();
    session.qb.getRawOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: 1, date: '2026-08-11', status: 'SCHEDULED' });

    await service.create(validSession);

    const call = session.qb.andWhere.mock.calls.filter(
      (c: any[]) => c[0] === 'ss.status IN (:...statuses)',
    );
    expect(call).toHaveLength(2); // 1 lần cho giáo viên, 1 lần cho lớp
    expect(call[1][1].statuses).not.toContain(SessionStatus.CANCELLED);
  });

  it('lọc theo classId trên danh sách buổi dạy', async () => {
    const { service, session } = makeSessionService();

    await service.findAll({ classId: 7 } as any);

    const sqls = session.qb.andWhere.mock.calls.map((c: any[]) => c[0]);
    expect(sqls).toContain('ss.classId = :classId');
  });

  it('lọc theo classId trên bảng tổng hợp chấm công', async () => {
    const { service, session } = makeSessionService();

    await service.attendanceSummary({
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
      classId: 7,
    });

    const sqls = session.qb.andWhere.mock.calls.map((c: any[]) => c[0]);
    expect(sqls).toContain('ss.classId = :classId');
  });
});

// ============================================================
// 10. Áp một môn cho nhiều lớp của nhiều trường
// ============================================================

describe('SubjectResolverService', () => {
  const CLASSES = new Map<number, any>([
    [
      1,
      {
        id: 1,
        name: '1A',
        schoolId: 10,
        schoolName: 'Trường A',
        schoolYear: '2026-2027',
      },
    ],
    [
      2,
      {
        id: 2,
        name: '1B',
        schoolId: 10,
        schoolName: 'Trường A',
        schoolYear: '2026-2027',
      },
    ],
    [
      3,
      {
        id: 3,
        name: '2A',
        schoolId: 20,
        schoolName: 'Trường B',
        schoolYear: '2026-2027',
      },
    ],
  ]);

  function setup(opts: { subjects?: any[]; catalog?: any } = {}) {
    const schoolClass = makeRepo();
    const subject = makeRepo({
      find: jest.fn().mockResolvedValue(opts.subjects ?? []),
    });
    const catalog = makeRepo({
      findOne: jest
        .fn()
        .mockResolvedValue(
          opts.catalog === undefined ? { id: 14, name: 'STEM' } : opts.catalog,
        ),
    });

    const service = new SubjectResolverService(
      schoolClass.repo,
      subject.repo,
      catalog.repo,
    );

    return { service, schoolClass, subject, catalog };
  }

  const items = [{ classId: 1 }, { classId: 2 }, { classId: 3 }];

  it('map ra môn riêng của từng trường từ một môn trong danh mục', async () => {
    const { service } = setup({
      subjects: [
        { id: 100, name: 'STEM', schoolId: 10, schoolYear: '2026-2027' },
        { id: 200, name: 'Stem', schoolId: 20, schoolYear: '2026-2027' },
      ],
    });

    const result = await service.resolveSubjects(
      { catalogId: 14 },
      items,
      CLASSES,
    );

    // 2 lớp cùng trường -> cùng môn; lớp trường khác -> môn của trường đó.
    expect(result.get(1)).toEqual({
      status: 'RESOLVED',
      subjectId: 100,
      subjectName: 'STEM',
    });
    expect(result.get(2)).toMatchObject({ subjectId: 100 });
    expect(result.get(3)).toMatchObject({
      subjectId: 200,
      subjectName: 'Stem',
    });
  });

  it('chỉ lấy môn đúng năm học của lớp', async () => {
    const { service } = setup({
      subjects: [
        { id: 100, name: 'STEM', schoolId: 10, schoolYear: '2025-2026' },
        { id: 101, name: 'STEM', schoolId: 10, schoolYear: '2026-2027' },
      ],
    });

    const result = await service.resolveSubjects(
      { catalogId: 14 },
      [{ classId: 1 }],
      CLASSES,
    );

    expect(result.get(1)).toMatchObject({ subjectId: 101 });
  });

  it('schoolYear ở cấp lô ghi đè năm học của lớp', async () => {
    const { service } = setup({
      subjects: [
        { id: 100, name: 'STEM', schoolId: 10, schoolYear: '2025-2026' },
        { id: 101, name: 'STEM', schoolId: 10, schoolYear: '2026-2027' },
      ],
    });

    const result = await service.resolveSubjects(
      { catalogId: 14, schoolYear: '2025-2026' },
      [{ classId: 1 }],
      CLASSES,
    );

    expect(result.get(1)).toMatchObject({ subjectId: 100 });
  });

  it('trường chưa khai môn -> MISSING kèm tên trường và năm học', async () => {
    const { service } = setup({
      subjects: [
        { id: 100, name: 'STEM', schoolId: 10, schoolYear: '2026-2027' },
      ],
    });

    const result = await service.resolveSubjects(
      { catalogId: 14 },
      items,
      CLASSES,
    );

    const missing: any = result.get(3);
    expect(missing.status).toBe('MISSING');
    expect(missing.reason).toContain('Trường B');
    expect(missing.reason).toContain('STEM');
    expect(missing.reason).toContain('2026-2027');
  });

  it('trường có nhiều môn trùng tên -> AMBIGUOUS, không đoán bừa', async () => {
    const { service } = setup({
      subjects: [
        { id: 100, name: 'STEM', schoolId: 10, schoolYear: '2026-2027' },
        { id: 101, name: 'STEM', schoolId: 10, schoolYear: '2026-2027' },
      ],
    });

    const result = await service.resolveSubjects(
      { catalogId: 14 },
      [{ classId: 1 }],
      CLASSES,
    );

    const match: any = result.get(1);
    expect(match.status).toBe('AMBIGUOUS');
    expect(match.reason).toContain('subjectId');
  });

  it('subjectId khai thẳng thắng catalogId', async () => {
    const { service, subject } = setup({ subjects: [] });
    subject.repo.find = jest
      .fn()
      .mockResolvedValue([{ id: 999, name: 'Môn riêng', schoolId: 10 }]);

    const result = await service.resolveSubjects(
      { catalogId: 14 },
      [{ classId: 1, subjectId: 999 }],
      CLASSES,
    );

    expect(result.get(1)).toMatchObject({ subjectId: 999 });
  });

  it('400 khi không có cả catalogId lẫn subjectId', async () => {
    const { service } = setup();

    await expect(
      service.resolveSubjects({}, [{ classId: 1 }], CLASSES),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 khi catalogId không có trong danh mục', async () => {
    const { service } = setup({ catalog: null });

    await expect(
      service.resolveSubjects({ catalogId: 99 }, [{ classId: 1 }], CLASSES),
    ).rejects.toThrow('không có trong danh mục');
  });
});

describe('TeachingBulkService', () => {
  const CLASSES = new Map<number, any>([
    [
      1,
      {
        id: 1,
        name: '1A',
        schoolId: 10,
        schoolName: 'Trường A',
        schoolYear: '2026-2027',
      },
    ],
    [
      2,
      {
        id: 2,
        name: '1B',
        schoolId: 10,
        schoolName: 'Trường A',
        schoolYear: '2026-2027',
      },
    ],
    [
      3,
      {
        id: 3,
        name: '2A',
        schoolId: 20,
        schoolName: 'Trường B',
        schoolYear: '2026-2027',
      },
    ],
  ]);

  function setup(
    opts: { matches?: Map<number, any>; classes?: Map<number, any> } = {},
  ) {
    const matches =
      opts.matches ??
      new Map<number, any>(
        [...CLASSES.keys()].map((id) => [
          id,
          { status: 'RESOLVED', subjectId: 100 + id, subjectName: 'STEM' },
        ]),
      );

    const resolver = {
      loadClasses: jest.fn().mockResolvedValue(opts.classes ?? CLASSES),
      resolveSubjects: jest.fn().mockResolvedValue(matches),
    };

    let nextId = 10;
    const scheduleService = {
      create: jest.fn(async (dto: any) => ({
        id: nextId++,
        subjectId: dto.subjectId,
        subjectName: 'STEM',
      })),
      generateSessions: jest
        .fn()
        .mockResolvedValue({ created: 4, skipped: 0, dates: [] }),
    };
    const sessionService = {
      create: jest.fn(async (dto: any) => ({
        id: nextId++,
        subjectId: dto.subjectId,
        subjectName: 'STEM',
      })),
    };

    const service = new TeachingBulkService(
      resolver as any,
      scheduleService as any,
      sessionService as any,
    );

    return { service, resolver, scheduleService, sessionService };
  }

  const bulkSchedules = {
    catalogId: 14,
    teacherId: 5,
    dayOfWeek: 3,
    startTime: '07:30',
    endTime: '09:00',
    effectiveFrom: '2026-09-01',
    effectiveTo: '2026-09-30',
    items: [{ classId: 1 }, { classId: 2 }, { classId: 3 }],
  };

  describe('tạo mẫu lịch hàng loạt', () => {
    it('một lần gọi tạo lịch cho mọi lớp, mỗi lớp dùng môn của trường mình', async () => {
      const { service, scheduleService } = setup();

      const result = await service.createSchedules(bulkSchedules);

      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);
      expect(scheduleService.create).toHaveBeenCalledTimes(3);
      expect(scheduleService.create).toHaveBeenCalledWith(
        expect.objectContaining({ classId: 3, subjectId: 103, teacherId: 5 }),
      );
      expect(result.results[0]).toMatchObject({
        classId: 1,
        className: '1A',
        schoolName: 'Trường A',
        status: 'CREATED',
      });
    });

    it('override từng lớp thắng giá trị mặc định của lô', async () => {
      const { service, scheduleService } = setup();

      await service.createSchedules({
        ...bulkSchedules,
        items: [
          { classId: 1 },
          {
            classId: 2,
            dayOfWeek: 5,
            startTime: '13:30',
            endTime: '15:00',
            teacherId: 9,
          },
        ],
      });

      expect(scheduleService.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          classId: 2,
          dayOfWeek: 5,
          startTime: '13:30',
          teacherId: 9,
        }),
      );
    });

    it('lớp trường chưa khai môn bị bỏ qua, các lớp còn lại vẫn tạo', async () => {
      const matches = new Map<number, any>([
        [1, { status: 'RESOLVED', subjectId: 101, subjectName: 'STEM' }],
        [2, { status: 'RESOLVED', subjectId: 101, subjectName: 'STEM' }],
        [3, { status: 'MISSING', reason: 'Trường B chưa khai môn STEM' }],
      ]);
      const { service } = setup({ matches });

      const result = await service.createSchedules(bulkSchedules);

      expect(result.created).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.results[2]).toMatchObject({
        classId: 3,
        status: 'SKIPPED',
        reason: 'Trường B chưa khai môn STEM',
      });
    });

    it('lớp bị 409 trùng giờ chỉ làm hỏng lớp đó', async () => {
      const { service, scheduleService } = setup();
      scheduleService.create = jest
        .fn()
        .mockResolvedValueOnce({ id: 10, subjectId: 101, subjectName: 'STEM' })
        .mockRejectedValueOnce(
          new ConflictException('Lớp này đã có lịch Thứ Ba 07:30–09:00'),
        )
        .mockResolvedValueOnce({ id: 12, subjectId: 103, subjectName: 'STEM' });

      const result = await service.createSchedules(bulkSchedules);

      expect(result.created).toBe(2);
      expect(result.results[1]).toMatchObject({
        status: 'SKIPPED',
        reason: 'Lớp này đã có lịch Thứ Ba 07:30–09:00',
      });
    });

    it('sinh luôn buổi dạy cho các mẫu vừa tạo', async () => {
      const { service, scheduleService } = setup();

      const result = await service.createSchedules({
        ...bulkSchedules,
        generateSessions: { fromDate: '2026-09-01', toDate: '2026-09-30' },
      });

      expect(scheduleService.generateSessions).toHaveBeenCalledTimes(3);
      expect(result.sessionsCreated).toBe(12);
    });

    it('không sinh buổi cho lớp bị bỏ qua', async () => {
      const matches = new Map<number, any>([
        [1, { status: 'RESOLVED', subjectId: 101, subjectName: 'STEM' }],
        [2, { status: 'MISSING', reason: 'chưa khai môn' }],
        [3, { status: 'MISSING', reason: 'chưa khai môn' }],
      ]);
      const { service, scheduleService } = setup({ matches });

      await service.createSchedules({
        ...bulkSchedules,
        generateSessions: { fromDate: '2026-09-01', toDate: '2026-09-30' },
      });

      expect(scheduleService.generateSessions).toHaveBeenCalledTimes(1);
    });

    it('400 trước khi ghi khi thiếu field bắt buộc — không tạo nửa lô', async () => {
      const { service, scheduleService } = setup();
      const { teacherId, ...withoutTeacher } = bulkSchedules;

      await expect(
        service.createSchedules(withoutTeacher as any),
      ).rejects.toThrow('Thiếu teacherId');
      expect(scheduleService.create).not.toHaveBeenCalled();
    });

    it('400 khi giờ ngược, không ghi gì', async () => {
      const { service, scheduleService } = setup();

      await expect(
        service.createSchedules({
          ...bulkSchedules,
          startTime: '09:00',
          endTime: '07:30',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(scheduleService.create).not.toHaveBeenCalled();
    });

    it('400 khi trùng đúng một ô lịch', async () => {
      const { service } = setup();

      await expect(
        service.createSchedules({
          ...bulkSchedules,
          items: [{ classId: 1 }, { classId: 1 }],
        }),
      ).rejects.toThrow('bị lặp');
    });

    // Thời khoá biểu thật: một lớp học môn này 2 tiết/tuần ở hai ô khác nhau.
    // Đây là đầu vào chính của luồng nhập thời khoá biểu từ ảnh.
    it('cho phép một lớp xuất hiện nhiều lần ở các ô lịch khác nhau', async () => {
      const { service, scheduleService } = setup();

      const result = await service.createSchedules({
        ...bulkSchedules,
        items: [
          { classId: 1, dayOfWeek: 2, startTime: '07:00', endTime: '07:40' },
          { classId: 1, dayOfWeek: 5, startTime: '09:00', endTime: '09:40' },
        ],
      });

      expect(result.created).toBe(2);
      expect(scheduleService.create).toHaveBeenCalledTimes(2);
    });

    it('cho phép một lớp có 2 tiết khác giờ trong cùng một thứ', async () => {
      const { service } = setup();

      const result = await service.createSchedules({
        ...bulkSchedules,
        items: [
          { classId: 1, dayOfWeek: 3, startTime: '07:00', endTime: '07:40' },
          { classId: 1, dayOfWeek: 3, startTime: '09:45', endTime: '10:25' },
        ],
      });

      expect(result.created).toBe(2);
    });

    it('lớp không tồn tại bị bỏ qua chứ không làm hỏng lô', async () => {
      const { service } = setup({ classes: new Map([[1, CLASSES.get(1)]]) });

      const result = await service.createSchedules(bulkSchedules);

      expect(result.created).toBe(1);
      expect(result.results[1]).toMatchObject({
        status: 'SKIPPED',
        reason: 'Lớp học không tồn tại',
        className: null,
      });
    });
  });

  describe('tạo tiết hàng loạt', () => {
    const bulkSessions = {
      catalogId: 14,
      teacherId: 5,
      startTime: '07:30',
      endTime: '09:00',
      items: [{ classId: 1 }, { classId: 2 }],
    };

    it('cho phép một lớp có nhiều tiết trong cùng một ngày', async () => {
      const { service, sessionService } = setup();

      const result = await service.createSessions({
        ...bulkSessions,
        date: '2026-09-07',
        items: [
          { classId: 1, startTime: '07:00', endTime: '07:40' },
          { classId: 1, startTime: '09:45', endTime: '10:25' },
        ],
      });

      expect(result.created).toBe(2);
      expect(sessionService.create).toHaveBeenCalledTimes(2);
    });

    it('400 khi trùng đúng một tiết (cùng lớp, cùng ngày, cùng giờ)', async () => {
      const { service } = setup();

      await expect(
        service.createSessions({
          ...bulkSessions,
          date: '2026-09-07',
          items: [{ classId: 1 }, { classId: 1 }],
        }),
      ).rejects.toThrow('bị lặp');
    });

    it('nhân lớp × ngày', async () => {
      const { service, sessionService } = setup();

      const result = await service.createSessions({
        ...bulkSessions,
        dates: ['2026-09-01', '2026-09-08', '2026-09-15'],
      });

      expect(result.created).toBe(6);
      expect(sessionService.create).toHaveBeenCalledTimes(6);
      expect(result.results[0]).toMatchObject({
        classId: 1,
        date: '2026-09-01',
        status: 'CREATED',
      });
    });

    it('ngày riêng của lớp thắng danh sách ngày chung', async () => {
      const { service, sessionService } = setup();

      await service.createSessions({
        ...bulkSessions,
        dates: ['2026-09-01', '2026-09-08'],
        items: [{ classId: 1 }, { classId: 2, date: '2026-09-20' }],
      });

      const dates = sessionService.create.mock.calls.map(
        (c: any[]) => c[0].date,
      );
      expect(dates).toEqual(['2026-09-01', '2026-09-08', '2026-09-20']);
    });

    it('không có teacherId thì tạo tiết mở cho giáo viên đăng ký', async () => {
      const { service, sessionService } = setup();
      const { teacherId, ...withoutTeacher } = bulkSessions;

      await service.createSessions({
        ...withoutTeacher,
        date: '2026-09-01',
      });

      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: null }),
      );
    });

    it('400 khi không chọn ngày', async () => {
      const { service } = setup();

      await expect(service.createSessions(bulkSessions)).rejects.toThrow(
        'Vui lòng chọn ngày dạy',
      );
    });

    it('400 khi vượt trần số tiết mỗi lần', async () => {
      const { service, sessionService } = setup({
        classes: new Map(
          Array.from({ length: 20 }, (_, i) => [
            i + 1,
            {
              id: i + 1,
              name: `L${i}`,
              schoolId: 10,
              schoolName: 'A',
              schoolYear: '2026-2027',
            },
          ]),
        ),
      });

      await expect(
        service.createSessions({
          ...bulkSessions,
          items: Array.from({ length: 20 }, (_, i) => ({ classId: i + 1 })),
          dates: Array.from(
            { length: 31 },
            (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`,
          ),
        }),
      ).rejects.toThrow('tối đa 500 tiết');
      expect(sessionService.create).not.toHaveBeenCalled();
    });

    it('tiết bị 409 chỉ bỏ qua đúng ngày đó', async () => {
      const { service, sessionService } = setup();
      sessionService.create = jest
        .fn()
        .mockResolvedValueOnce({ id: 1, subjectId: 101, subjectName: 'STEM' })
        .mockRejectedValueOnce(new ConflictException('Lớp 1A đã có buổi học'))
        .mockResolvedValue({ id: 3, subjectId: 102, subjectName: 'STEM' });

      const result = await service.createSessions({
        ...bulkSessions,
        dates: ['2026-09-01', '2026-09-08'],
      });

      expect(result.created).toBe(3);
      expect(result.skipped).toBe(1);
      expect(result.results[1]).toMatchObject({
        date: '2026-09-08',
        status: 'SKIPPED',
        reason: 'Lớp 1A đã có buổi học',
      });
    });
  });
});

// ============================================================
// 11. Đơn giá mỗi tiết
// ============================================================

describe('Đơn giá mỗi tiết', () => {
  describe('amountOf', () => {
    it('tiền công = đơn giá × số tiết', () => {
      expect(amountOf(150_000, 2)).toBe(300_000);
    });

    it('thiếu số tiết thì tính 1 tiết', () => {
      expect(amountOf(150_000, null)).toBe(150_000);
    });

    it('chưa khai đơn giá trả null, KHÔNG phải 0', () => {
      // 0 đồng là "dạy không công", null là "chưa khai giá" — FE phải phân biệt.
      expect(amountOf(null, 3)).toBeNull();
      expect(amountOf(undefined, 3)).toBeNull();
      expect(amountOf(0, 3)).toBe(0);
    });

    it('làm tròn tới 2 chữ số thập phân', () => {
      expect(amountOf(33_333.333, 3)).toBe(100_000);
    });
  });

  describe('buổi dạy sinh từ mẫu', () => {
    it('chốt đơn giá hiện tại của môn học vào buổi mới sinh', async () => {
      const { service, schedule, session } = makeScheduleService({
        subject: { id: 25, name: 'STEM', schoolId: 10, ratePerPeriod: 150_000 },
      });
      schedule.repo.findOne = jest.fn().mockResolvedValue({
        id: 1,
        teacherId: 5,
        schoolId: 10,
        classId: 7,
        subjectId: 25,
        dayOfWeek: 3,
        startTime: '07:30:00',
        endTime: '09:00:00',
        periods: 2,
        effectiveFrom: '2026-08-01',
        effectiveTo: '2026-08-31',
        isActive: true,
      });

      await service.generateSessions(1, {
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });

      const inserted = session.repo.insert.mock.calls[0][0];
      expect(inserted[0]).toMatchObject({ ratePerPeriod: 150_000, periods: 2 });
    });

    it('môn học chưa khai giá thì buổi mới sinh để null', async () => {
      const { service, schedule, session } = makeScheduleService();
      schedule.repo.findOne = jest.fn().mockResolvedValue({
        id: 1,
        teacherId: 5,
        schoolId: 10,
        classId: 7,
        subjectId: 25,
        dayOfWeek: 3,
        startTime: '07:30:00',
        endTime: '09:00:00',
        periods: 2,
        effectiveFrom: '2026-08-01',
        effectiveTo: '2026-08-31',
        isActive: true,
      });

      await service.generateSessions(1, {
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });

      const inserted = session.repo.insert.mock.calls[0][0];
      expect(inserted[0]).toMatchObject({ ratePerPeriod: null });
    });
  });

  describe('chốt đơn giá khi tạo buổi', () => {
    function setupCreate(
      subject: any = { id: 25, name: 'STEM', schoolId: 10 },
    ) {
      const ctx = makeSessionService({ subject });
      ctx.session.qb.getRawOne
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ id: 1, date: '2026-08-11', status: 'SCHEDULED' });
      return ctx;
    }

    it('lấy đơn giá hiện tại của môn học', async () => {
      const { service, session } = setupCreate({
        id: 25,
        name: 'STEM',
        schoolId: 10,
        ratePerPeriod: 120_000,
      });

      await service.create(validSession);

      expect(session.repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ ratePerPeriod: 120_000 }),
      );
    });

    it('môn học chưa khai giá thì để null, không phụ thuộc giáo viên/buổi gốc', async () => {
      const { service, session } = setupCreate();
      // Buổi gốc có giá cũ — buổi bù vẫn phải lấy giá môn học hiện tại, không kế thừa.
      session.repo.findOne = jest
        .fn()
        .mockResolvedValue({ id: 99, classId: 7, ratePerPeriod: 90_000 });

      await service.create({ ...validSession, makeupForSessionId: 99 });

      expect(session.repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ ratePerPeriod: null, isMakeup: true }),
      );
    });

    it('tiết mở chưa có giáo viên vẫn chốt theo giá môn học', async () => {
      const { service, session } = setupCreate({
        id: 25,
        name: 'STEM',
        schoolId: 10,
        ratePerPeriod: 120_000,
      });
      // Không có giáo viên -> bỏ qua kiểm tra trùng giờ GV, chỉ còn 1 lượt của lớp.
      session.qb.getRawOne
        .mockReset()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ id: 1, date: '2026-08-11', status: 'SCHEDULED' });
      const { teacherId, ...withoutTeacher } = validSession;

      await service.create(withoutTeacher as any);

      expect(session.repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ ratePerPeriod: 120_000, teacherId: null }),
      );
    });
  });

  describe('response buổi dạy', () => {
    it('trả kèm ratePerPeriod và amount = giá × tiết', async () => {
      const { service, session } = makeSessionService();
      session.qb.getRawOne.mockResolvedValue({
        id: 1,
        date: '2026-08-11',
        status: 'PRESENT',
        periods: '2',
        ratePerPeriod: '150000',
      });

      await expect(service.findOne(1)).resolves.toMatchObject({
        periods: 2,
        ratePerPeriod: 150_000,
        amount: 300_000,
      });
    });

    it('chưa khai giá thì amount = null', async () => {
      const { service, session } = makeSessionService();
      session.qb.getRawOne.mockResolvedValue({
        id: 1,
        date: '2026-08-11',
        status: 'PRESENT',
        periods: '2',
        ratePerPeriod: null,
      });

      await expect(service.findOne(1)).resolves.toMatchObject({
        ratePerPeriod: null,
        amount: null,
      });
    });
  });

  describe('bảng công', () => {
    it('cộng tiền và cảnh báo buổi đã dạy nhưng chưa khai giá', async () => {
      const { service, session } = makeSessionService();
      session.qb.getRawMany.mockResolvedValue([
        {
          teacherId: 5,
          teacherName: 'Cô A',
          totalSessions: '10',
          present: '7',
          absent: '1',
          excused: '1',
          cancelled: '1',
          unchecked: '0',
          makeup: '0',
          totalPeriods: '14',
          payablePeriods: '10',
          payableAmount: '1500000',
          otherCostsAmount: '200000',
          totalPayableAmount: '1700000',
          missingRateSessions: '2',
        },
        {
          teacherId: 6,
          teacherName: 'Cô B',
          totalSessions: '4',
          present: '4',
          absent: '0',
          excused: '0',
          cancelled: '0',
          unchecked: '0',
          makeup: '0',
          totalPeriods: '4',
          payablePeriods: '4',
          payableAmount: '600000',
          otherCostsAmount: '50000',
          totalPayableAmount: '650000',
          missingRateSessions: '0',
        },
      ]);

      const result = await service.attendanceSummary({
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });

      expect(result.data[0]).toMatchObject({
        payablePeriods: 10,
        payableAmount: 1_500_000,
        otherCostsAmount: 200_000,
        totalPayableAmount: 1_700_000,
        missingRateSessions: 2,
      });
      expect(result.grandTotal).toEqual({
        payablePeriods: 14,
        payableAmount: 2_100_000,
        otherCostsAmount: 250_000,
        fuelAllowanceAmount: 0,
        totalPayableAmount: 2_350_000,
        missingRateSessions: 2,
      });
    });

    it('chỉ tính tiền cho buổi PRESENT', async () => {
      const { service, session } = makeSessionService();

      await service.attendanceSummary({
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });

      const payable = session.qb.addSelect.mock.calls.find(
        (c: any[]) => c[1] === 'payableAmount',
      );
      expect(payable[0]).toContain(SessionStatus.PRESENT);
      expect(payable[0]).not.toContain(SessionStatus.EXCUSED);
      expect(payable[0]).not.toContain(SessionStatus.CANCELLED);
    });
  });
});
