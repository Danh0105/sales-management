import { TeacherService } from './teacher.service';
import { Teacher } from './entities/teacher.entity';
import {
  TeacherLocationChange,
  TeacherLocationChangeStatus,
} from './entities/teacher-location-change.entity';
import { NotificationType } from '../notifications/enums/notification-type.enum';

describe('Teacher location approval workflow', () => {
  const makeService = (teacher: any, pending: any = null) => {
    const teacherRepo = {
      findOne: jest.fn().mockResolvedValue(teacher),
      save: jest.fn(async (value) => value),
    };
    const changeRepo = {
      findOne: jest.fn().mockResolvedValue(pending),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ id: 9, ...value })),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === Teacher ? teacherRepo : changeRepo,
      ),
    };
    const dataSource = {
      transaction: jest.fn((callback) => callback(manager)),
    };
    const employeeQb: any = {
      select: jest.fn(),
      addSelect: jest.fn(),
      where: jest.fn(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    employeeQb.select.mockReturnValue(employeeQb);
    employeeQb.addSelect.mockReturnValue(employeeQb);
    employeeQb.where.mockReturnValue(employeeQb);
    const notificationService = { create: jest.fn().mockResolvedValue({}) };
    const fcmService = { sendToMultiple: jest.fn().mockResolvedValue({}) };
    const tokenService = { getTokens: jest.fn().mockResolvedValue([]) };
    const service = new TeacherService(
      teacherRepo as any,
      {} as any,
      { createQueryBuilder: jest.fn().mockReturnValue(employeeQb) } as any,
      dataSource as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      changeRepo as any,
      notificationService as any,
      fcmService as any,
      tokenService as any,
    );
    return {
      service,
      teacherRepo,
      changeRepo,
      employeeQb,
      notificationService,
      tokenService,
    };
  };

  it('ghi nhận ngay khi giáo viên chưa có vị trí', async () => {
    const teacher = { id: 3, employeeId: 42, latitude: null, longitude: null };
    const { service, teacherRepo, changeRepo } = makeService(teacher);

    await expect(
      service.captureMyLocation(42, { latitude: 10.77, longitude: 106.7 }),
    ).resolves.toMatchObject({ status: 'captured', requiresApproval: false });
    expect(teacherRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 10.77, longitude: 106.7 }),
    );
    expect(changeRepo.save).not.toHaveBeenCalled();
  });

  it('tạo yêu cầu và giữ nguyên vị trí cũ khi giáo viên đổi vị trí', async () => {
    const teacher = { id: 3, employeeId: 42, latitude: 10.7, longitude: 106.6 };
    const { service, teacherRepo, changeRepo } = makeService(teacher);

    await expect(
      service.captureMyLocation(42, { latitude: 10.8, longitude: 106.8 }),
    ).resolves.toEqual({
      status: 'pending',
      requiresApproval: true,
      requestId: 9,
    });
    expect(teacherRepo.save).not.toHaveBeenCalled();
    expect(changeRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        previousLatitude: 10.7,
        latitude: 10.8,
        status: TeacherLocationChangeStatus.PENDING,
      }),
    );
  });

  it('chỉ cập nhật vị trí chuẩn khi yêu cầu được duyệt', async () => {
    const teacher = { id: 3, latitude: 10.7, longitude: 106.6 };
    const request = {
      id: 9,
      teacherId: 3,
      latitude: 10.8,
      longitude: 106.8,
      status: TeacherLocationChangeStatus.PENDING,
    };
    const { service, teacherRepo } = makeService(teacher, request);

    await expect(
      service.reviewLocationChange(9, 12, true, { note: 'Đã xác minh' }),
    ).resolves.toEqual({ id: 9, status: TeacherLocationChangeStatus.APPROVED });
    expect(teacherRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 10.8, longitude: 106.8 }),
    );
    expect(request).toMatchObject({
      reviewedBy: 12,
      reviewNote: 'Đã xác minh',
      status: TeacherLocationChangeStatus.APPROVED,
    });
  });

  it('báo cho chính giáo viên khi yêu cầu đổi vị trí được duyệt', async () => {
    const teacher = { id: 3, employeeId: 42, latitude: 10.7, longitude: 106.6 };
    const request = {
      id: 9,
      teacherId: 3,
      latitude: 10.8,
      longitude: 106.8,
      status: TeacherLocationChangeStatus.PENDING,
    };
    const { service, notificationService, tokenService } = makeService(
      teacher,
      request,
    );

    await service.reviewLocationChange(9, 12, true, {});

    expect(notificationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverId: 42,
        type: NotificationType.TEACHER_LOCATION_CHANGE_RESULT,
        meta: expect.objectContaining({ approved: true }),
      }),
    );
    expect(tokenService.getTokens).toHaveBeenCalledWith([42]);
  });

  it('báo cho giáo viên kèm lý do khi yêu cầu bị từ chối', async () => {
    const teacher = { id: 3, employeeId: 42 };
    const request = {
      id: 9,
      teacherId: 3,
      latitude: 10.8,
      longitude: 106.8,
      status: TeacherLocationChangeStatus.PENDING,
    };
    const { service, teacherRepo, notificationService } = makeService(
      teacher,
      request,
    );

    await service.reviewLocationChange(9, 12, false, { note: 'Sai địa chỉ' });

    expect(notificationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverId: 42,
        type: NotificationType.TEACHER_LOCATION_CHANGE_RESULT,
        message: expect.stringContaining('Sai địa chỉ'),
        meta: expect.objectContaining({ approved: false }),
      }),
    );
    expect(teacherRepo.save).not.toHaveBeenCalled();
    expect(request).toMatchObject({
      status: TeacherLocationChangeStatus.REJECTED,
      reviewedBy: 12,
      reviewNote: 'Sai địa chỉ',
    });
  });

  it('không cho duyệt lại yêu cầu đã được xử lý', async () => {
    const teacher = { id: 3, employeeId: 42 };
    const request = {
      id: 9,
      teacherId: 3,
      latitude: 10.8,
      longitude: 106.8,
      status: TeacherLocationChangeStatus.APPROVED,
    };
    const { service, teacherRepo, notificationService } = makeService(
      teacher,
      request,
    );

    await expect(service.reviewLocationChange(9, 12, true, {})).rejects.toThrow(
      'Yêu cầu đổi vị trí đã được xử lý',
    );
    expect(teacherRepo.save).not.toHaveBeenCalled();
    expect(notificationService.create).not.toHaveBeenCalled();
  });

  it('không gửi gì khi giáo viên chưa gắn tài khoản', async () => {
    const teacher = { id: 3, latitude: 10.7, longitude: 106.6 };
    const request = {
      id: 9,
      teacherId: 3,
      latitude: 10.8,
      longitude: 106.8,
      status: TeacherLocationChangeStatus.PENDING,
    };
    const { service, notificationService } = makeService(teacher, request);

    await service.reviewLocationChange(9, 12, true, {});

    expect(notificationService.create).not.toHaveBeenCalled();
  });

  it('gửi cùng thông báo cho cả tài khoản Nhân sự và Giáo vụ', async () => {
    const teacher = { id: 3, employeeId: 42, name: 'Cô Lan' };
    const { service, employeeQb, notificationService, tokenService } =
      makeService(teacher);
    employeeQb.getRawMany.mockResolvedValue([
      { id: 11, zaloUserId: null },
      { id: 12, zaloUserId: null },
    ]);

    await (service as any).notifyLocationChangeRequest(9, 42);

    expect(employeeQb.where).toHaveBeenCalledWith(
      'e.roles && ARRAY[:...roles]::text[]',
      { roles: ['nhansu', 'giaovu'] },
    );
    expect(
      notificationService.create.mock.calls.map((call) => call[0].receiverId),
    ).toEqual([11, 12]);
    expect(tokenService.getTokens).toHaveBeenCalledWith([11, 12]);
  });
});
