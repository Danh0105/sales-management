import { ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { TeacherService } from './teacher.service';
import { Teacher } from './entities/teacher.entity';
import { Employee } from '../employee/employee.entity';
import {
  TeacherAccountRequest,
  TeacherAccountRequestStatus,
} from './entities/teacher-account-request.entity';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import {
  ACADEMIC_ROLE,
  HR_ROLE,
  requiresTeacherAccountApproval,
} from './teaching-roles';

const dto = {
  name: 'Cô Lan',
  phone: '0912345678',
  email: 'lan@kido.vn',
  password: 'matkhau123',
};

describe('Duyệt tài khoản giáo viên do Giáo vụ tạo', () => {
  const makeService = (pendingRequest: any = null) => {
    const savedTeachers: any[] = [];
    const savedEmployees: any[] = [];

    const teacherQb: any = {
      leftJoin: jest.fn(),
      select: jest.fn(),
      where: jest.fn(),
      getRawOne: jest.fn().mockResolvedValue({ id: 77, name: dto.name }),
    };
    teacherQb.leftJoin.mockReturnValue(teacherQb);
    teacherQb.select.mockReturnValue(teacherQb);
    teacherQb.where.mockReturnValue(teacherQb);

    const teacherRepo = {
      // Tra theo id = lấy hồ sơ giáo viên; tra theo phone/email = soát trùng,
      // và ở đây chưa ai chiếm.
      findOne: jest.fn(async ({ where }: any) =>
        where?.id
          ? { id: where.id, name: dto.name, employeeId: null, phone: dto.phone }
          : null,
      ),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => {
        savedTeachers.push(value);
        return { id: 77, ...value };
      }),
      createQueryBuilder: jest.fn().mockReturnValue(teacherQb),
    };

    const employeeRepo = {
      // Tra theo id = tìm người gửi đề nghị; tra theo phone/email = soát trùng
      // tài khoản, và ở đây chưa ai chiếm.
      findOne: jest.fn(async ({ where }: any) =>
        where?.id ? { id: where.id, name: 'Chị Giáo Vụ' } : null,
      ),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => {
        savedEmployees.push(value);
        return { id: 501, ...value };
      }),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ id: 9, zaloUserId: null }]),
      }),
    };

    const accountRequestRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(pendingRequest),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ id: 12, ...value })),
    };

    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Teacher) return teacherRepo;
        if (entity === Employee) return employeeRepo;
        return accountRequestRepo;
      }),
    };

    const notificationService = { create: jest.fn().mockResolvedValue({}) };
    const service = new TeacherService(
      teacherRepo as any,
      {} as any,
      employeeRepo as any,
      { transaction: jest.fn((cb) => cb(manager)) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      notificationService as any,
      { sendToMultiple: jest.fn().mockResolvedValue({}) } as any,
      { getTokens: jest.fn().mockResolvedValue([]) } as any,
      accountRequestRepo as any,
    );

    return {
      service,
      teacherRepo,
      employeeRepo,
      accountRequestRepo,
      notificationService,
      savedTeachers,
      savedEmployees,
    };
  };

  it('Giáo vụ gửi đề nghị thì chưa có giáo viên lẫn tài khoản nào được tạo', async () => {
    const { service, accountRequestRepo, savedTeachers, savedEmployees } =
      makeService();

    await expect(service.requestCreate({ ...dto } as any, 5)).resolves.toMatchObject({
      status: TeacherAccountRequestStatus.PENDING,
      requiresApproval: true,
      requestId: 12,
    });

    expect(savedTeachers).toHaveLength(0);
    expect(savedEmployees).toHaveLength(0);
    expect(accountRequestRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: 5,
        status: TeacherAccountRequestStatus.PENDING,
      }),
    );
  });

  it('mật khẩu được băm ngay lúc gửi, không lưu bản thô', async () => {
    const { service, accountRequestRepo } = makeService();
    await service.requestCreate({ ...dto } as any, 5);

    const saved = accountRequestRepo.save.mock.calls[0][0] as any;
    expect(saved.passwordHash).not.toBe(dto.password);
    expect(await bcrypt.compare(dto.password, saved.passwordHash)).toBe(true);
    expect(JSON.stringify(saved.payload)).not.toContain(dto.password);
  });

  it('báo cho Nhân sự khi có đề nghị mới', async () => {
    const { service, notificationService } = makeService();
    await service.requestCreate({ ...dto } as any, 5);

    expect(notificationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverId: 9,
        type: NotificationType.TEACHER_ACCOUNT_REQUEST,
        entityId: 12,
      }),
    );
  });

  it('Nhân sự duyệt thì tài khoản mới được tạo, dùng đúng mật khẩu đã băm', async () => {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const request = {
      id: 12,
      payload: { name: dto.name, phone: dto.phone, email: dto.email },
      passwordHash,
      name: dto.name,
      requestedBy: 5,
      status: TeacherAccountRequestStatus.PENDING,
    };
    const { service, savedEmployees, savedTeachers, notificationService } =
      makeService(request);

    const result = await service.reviewAccountRequest(12, 9, true, {});

    expect(result).toMatchObject({
      status: TeacherAccountRequestStatus.APPROVED,
      teacherId: 77,
    });
    expect(savedEmployees[0]).toMatchObject({
      phone: dto.phone,
      password: passwordHash,
    });
    expect(savedTeachers[0]).toMatchObject({ employeeId: 501 });
    expect(notificationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverId: 5,
        type: NotificationType.TEACHER_ACCOUNT_RESULT,
      }),
    );
  });

  it('Nhân sự từ chối thì không tạo gì cả', async () => {
    const request = {
      id: 12,
      payload: { name: dto.name, phone: dto.phone, email: dto.email },
      passwordHash: 'hashed',
      name: dto.name,
      requestedBy: 5,
      status: TeacherAccountRequestStatus.PENDING,
    };
    const { service, savedEmployees, savedTeachers } = makeService(request);

    const result = await service.reviewAccountRequest(12, 9, false, {
      note: 'Trùng hồ sơ cũ',
    });

    expect(result).toMatchObject({
      status: TeacherAccountRequestStatus.REJECTED,
      teacherId: null,
      teacher: null,
    });
    expect(savedEmployees).toHaveLength(0);
    expect(savedTeachers).toHaveLength(0);
  });

  it('duyệt hồ sơ cấp tài khoản cho giáo viên có sẵn thì gắn vào hồ sơ đó, không tạo hồ sơ mới', async () => {
    const request = {
      id: 12,
      payload: { name: dto.name, phone: dto.phone, email: dto.email },
      passwordHash: 'da-bam',
      name: dto.name,
      phone: dto.phone,
      email: dto.email,
      teacherId: 55,
      requestedBy: 5,
      status: TeacherAccountRequestStatus.PENDING,
    };
    const { service, savedEmployees, savedTeachers } = makeService(request);

    const result = await service.reviewAccountRequest(12, 9, true, {});

    expect(result).toMatchObject({ teacherId: 55 });
    expect(savedEmployees[0]).toMatchObject({ password: 'da-bam' });
    // Hồ sơ giáo viên chỉ được gắn tài khoản, không nhân bản thêm bản ghi.
    expect(savedTeachers).toHaveLength(1);
    expect(savedTeachers[0]).toMatchObject({ id: 55, employeeId: 501 });
  });

  it('Giáo vụ gửi đề nghị cấp tài khoản cho giáo viên có sẵn thì chưa tạo tài khoản', async () => {
    const { service, savedEmployees, accountRequestRepo } = makeService();

    await expect(
      service.requestAccountForTeacher(55, { password: 'matkhau123' }, 5),
    ).resolves.toMatchObject({ requiresApproval: true });

    expect(savedEmployees).toHaveLength(0);
    expect(accountRequestRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: 55 }),
    );
  });

  it('không cấp tài khoản cho giáo viên đã có tài khoản', async () => {
    const { service, teacherRepo } = makeService();
    teacherRepo.findOne.mockResolvedValue({
      id: 55,
      name: dto.name,
      phone: dto.phone,
      employeeId: 900,
    });

    await expect(
      service.requestAccountForTeacher(55, { password: 'matkhau123' }, 5),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('không duyệt lại được hồ sơ đã xử lý', async () => {
    const { service } = makeService({
      id: 12,
      status: TeacherAccountRequestStatus.APPROVED,
      payload: {},
      passwordHash: null,
      requestedBy: 5,
    });

    await expect(
      service.reviewAccountRequest(12, 9, true, {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('Giáo vụ chỉ xem được đề nghị của chính mình', async () => {
    const { service, accountRequestRepo } = makeService();

    await service.findAccountRequests({ requestedBy: 99 }, 5, false);
    expect(accountRequestRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestedBy: 5 }),
      }),
    );
  });
});

describe('requiresTeacherAccountApproval', () => {
  it('Giáo vụ phải qua bước duyệt', () => {
    expect(
      requiresTeacherAccountApproval({ id: 5, roles: [ACADEMIC_ROLE] } as any),
    ).toBe(true);
  });

  it('Nhân sự tạo là có tài khoản ngay', () => {
    expect(
      requiresTeacherAccountApproval({ id: 9, roles: [HR_ROLE] } as any),
    ).toBe(false);
  });
});
