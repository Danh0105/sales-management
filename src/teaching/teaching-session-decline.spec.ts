import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TeachingSessionService } from './teaching-session.service';
import { TeachingSession } from './entities/teaching-session.entity';
import { Teacher } from './entities/teacher.entity';
import { AssignmentStatus, ConfirmationStatus, SessionStatus } from './teaching.enum';
import { NotificationType } from '../notifications/enums/notification-type.enum';

/**
 * Giáo viên xin rút khỏi buổi đã phân công vì có việc đột xuất.
 * Test chạy thẳng vào service với repo giả — không đụng DB.
 */
describe('TeachingSessionService.declineSession', () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const entity: any = {
      id: 50,
      teacherId: 5,
      date: today,
      startTime: '08:00:00',
      status: SessionStatus.SCHEDULED,
      assignmentStatus: AssignmentStatus.ASSIGNED,
      checkinAt: null,
      declinedAt: null,
      declinedTeacherId: null,
      declineReason: null,
      schoolId: 10,
      classId: 20,
      subjectId: 30,
      ...overrides,
    };

    const sessionQb: any = {};
    ['where', 'setLock'].forEach((method) => {
      sessionQb[method] = jest.fn().mockReturnValue(sessionQb);
    });
    sessionQb.getOne = jest.fn().mockResolvedValue(entity);

    const transactionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(sessionQb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const teacherTxRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue(
          entity.teacherId === 5 ? { id: 5, employeeId: 99, name: 'Cô Lan' } : null,
        ),
    };

    const managers = [{ id: 11, zaloUserId: null }, { id: 12, zaloUserId: null }];
    const employeeQb: any = {};
    ['select', 'addSelect', 'where'].forEach((method) => {
      employeeQb[method] = jest.fn().mockReturnValue(employeeQb);
    });
    employeeQb.getRawMany = jest
      .fn()
      .mockResolvedValue(managers.map((m) => ({ id: m.id, zaloUserId: m.zaloUserId })));

    const employeeRepo: any = {
      createQueryBuilder: jest.fn().mockReturnValue(employeeQb),
    };

    const sessionRepo: any = {
      findOne: jest.fn().mockResolvedValue({
        ...entity,
        school: { name: 'Trường A' },
        class: { name: 'Lớp 3A' },
        subject: { name: 'Toán' },
      }),
    };

    const dataSource: any = {
      transaction: jest.fn(async (work: any) =>
        work({
          getRepository: (target: any) => {
            if (target === TeachingSession) return transactionRepo;
            if (target === Teacher) return teacherTxRepo;
            return sessionRepo;
          },
        }),
      ),
    };

    const notificationService = { create: jest.fn().mockResolvedValue({ id: 1 }) };
    const fcmService = { sendToMultiple: jest.fn().mockResolvedValue(null) };
    const employeeFcmTokenService = {
      getTokens: jest.fn().mockResolvedValue([]),
    };

    const service = new TeachingSessionService(
      sessionRepo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource,
      notificationService as any,
      fcmService as any,
      employeeFcmTokenService as any,
      {} as any,
      employeeRepo,
      {} as any,
    );

    jest.spyOn(service, 'findOne').mockResolvedValue({ id: entity.id } as any);

    return {
      service,
      entity,
      transactionRepo,
      notificationService,
      fcmService,
    };
  }

  it('gỡ giáo viên, mở lại buổi và báo Giáo vụ/Nhân sự tìm người thay thế', async () => {
    const { service, transactionRepo, notificationService } = setup();

    const result = await service.declineSession(50, 99, {
      reason: 'Bận việc gia đình đột xuất',
    });

    expect(transactionRepo.update).toHaveBeenCalledWith(
      50,
      expect.objectContaining({
        declineReason: 'Bận việc gia đình đột xuất',
        declinedTeacherId: 5,
        teacherId: null,
        assignmentStatus: AssignmentStatus.OPEN,
        confirmationStatus: ConfirmationStatus.PENDING,
      }),
    );

    expect(notificationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverId: 11,
        type: NotificationType.TEACHING_REPLACEMENT_REQUEST,
        meta: expect.objectContaining({
          sessionId: 50,
          declinedTeacherName: 'Cô Lan',
        }),
      }),
    );
    expect(notificationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ receiverId: 12 }),
    );
    expect(result).toEqual({ id: 50 });
  });

  it('không phải giáo viên đứng tên buổi thì bị chặn', async () => {
    const { service } = setup();

    await expect(
      service.declineSession(50, 12345, { reason: 'Bận việc' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('buổi không tồn tại thì 404', async () => {
    const notFound = setup();
    // Ghi đè getOne để trả về null cho case buổi không tồn tại.
    (notFound.transactionRepo.createQueryBuilder() as any).getOne = jest
      .fn()
      .mockResolvedValue(null);

    await expect(
      notFound.service.declineSession(999, 99, { reason: 'Bận việc' }),
    ).rejects.toThrow(NotFoundException);
  });

  it.each([
    ['đã checkin', { checkinAt: new Date() }],
    ['đã từ chối trước đó', { declinedAt: new Date() }],
    ['buổi OPEN, chưa có ai nhận', { assignmentStatus: AssignmentStatus.OPEN }],
    ['buổi đã huỷ', { status: SessionStatus.CANCELLED }],
    ['buổi đã qua ngày', { date: '2000-01-01' }],
  ])('không đủ điều kiện từ chối khi %s', async (_label, overrides) => {
    const { service } = setup(overrides);

    await expect(
      service.declineSession(50, 99, { reason: 'Bận việc' }),
    ).rejects.toThrow(ConflictException);
  });
});
