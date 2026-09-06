import { TeachingSessionService } from './teaching-session.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import { TEACHING_SCHEDULE_CONFIRM_ALERT_LEAD_MINUTES } from '../notifications/constants/teaching-schedule-confirmation.constant';

/**
 * Xác nhận/từ chối buổi dạy + cảnh báo "còn PENDING mà sắp tới trong 1 ngày".
 * Test chạy thẳng vào service với repo giả — không đụng DB, không chờ cron.
 */

const CHAINABLE = [
  'innerJoin',
  'leftJoin',
  'where',
  'andWhere',
  'select',
  'addSelect',
  'orderBy',
  'addOrderBy',
];

function makeQueryBuilder(rows: any[] = []) {
  const qb: any = { calls: {} as Record<string, any> };
  for (const method of CHAINABLE) {
    qb[method] = jest.fn((...args: any[]) => {
      if ((method === 'where' || method === 'andWhere') && args[1]) {
        Object.assign(qb.calls, args[1]);
      }
      return qb;
    });
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

const NOW = new Date('2026-08-17T01:00:00.000Z'); // 08:00 +07

function sessionRow(over: Record<string, any> = {}) {
  return {
    id: 1,
    date: '2026-08-17',
    startTime: '08:05:00',
    teacherEmployeeId: 30,
    ...over,
  };
}

function makeService(
  rows: any[],
  managerRecipients: number[] = [11, 12],
) {
  const managers = managerRecipients.map((id) => ({ id, zaloUserId: null }));
  const sessionQb = makeQueryBuilder(rows);
  const employeeQb = makeQueryBuilder(managers);

  const sessionRepo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(sessionQb),
    update: jest.fn().mockResolvedValue({ affected: rows.length }),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(async (data: any) => data),
  };
  const employeeRepo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(employeeQb),
  };
  const notificationService: any = {
    create: jest.fn().mockResolvedValue({ id: 1 }),
    markTeachingSessionConfirmationAsRead: jest
      .fn()
      .mockResolvedValue({ success: true }),
  };
  const fcmService: any = { sendToMultiple: jest.fn().mockResolvedValue(null) };
  const employeeFcmTokenService: any = {
    getTokens: jest.fn().mockResolvedValue(
      [...managerRecipients, 30].map((id) => ({ employeeId: id, token: `t${id}` })),
    ),
  };
  const zaloNotifyService: any = {
    sendToMany: jest.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };

  const service = new TeachingSessionService(
    sessionRepo,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    notificationService,
    fcmService,
    employeeFcmTokenService,
    undefined as any,
    employeeRepo,
    zaloNotifyService,
  );

  return {
    service,
    sessionRepo,
    sessionQb,
    notificationService,
    fcmService,
    employeeFcmTokenService,
  };
}

describe('Nhắc xác nhận lịch dạy (còn PENDING, sắp tới trong 1 ngày)', () => {
  it('mặc định báo trước 24 giờ', () => {
    expect(TEACHING_SCHEDULE_CONFIRM_ALERT_LEAD_MINUTES).toBe(24 * 60);
  });

  it('không có buổi nào thì không gửi gì, không đụng cột đánh dấu', async () => {
    const { service, notificationService, sessionRepo } = makeService([]);

    const result = await service.runScheduleConfirmationAlerts(NOW);

    expect(result).toEqual({ sessions: 0, recipients: 0 });
    expect(notificationService.create).not.toHaveBeenCalled();
    expect(sessionRepo.update).not.toHaveBeenCalled();
  });

  it('quét đúng cửa sổ 24h và đánh dấu confirmationAlertAt', async () => {
    const { service, sessionQb, sessionRepo } = makeService([sessionRow()]);

    await service.runScheduleConfirmationAlerts(NOW);

    expect(sessionQb.calls.now).toEqual(NOW);
    expect(sessionQb.calls.until).toEqual(
      new Date(NOW.getTime() + 24 * 60 * 60_000),
    );
    expect(sessionRepo.update).toHaveBeenCalledWith(expect.anything(), {
      confirmationAlertAt: NOW,
    });
  });

  it('nhắc cả giáo viên lẫn Giáo vụ/Nhân sự, mỗi bên một nội dung', async () => {
    const { service, notificationService } = makeService([sessionRow()]);

    const result = await service.runScheduleConfirmationAlerts(NOW);

    // 1 giáo viên + 2 quản lý = 3 thông báo.
    expect(result).toEqual({ sessions: 1, recipients: 3 });
    expect(notificationService.create).toHaveBeenCalledTimes(3);

    const receivers = notificationService.create.mock.calls.map(
      (c: any[]) => c[0].receiverId,
    );
    expect(receivers.sort()).toEqual([11, 12, 30]);

    for (const [payload] of notificationService.create.mock.calls) {
      expect(payload.type).toBe(NotificationType.TEACHING_SCHEDULE_CONFIRM_ALERT);
    }
  });

  it('buổi không có teacherEmployeeId thì không nhắc giáo viên, vẫn báo quản lý', async () => {
    const { service, notificationService } = makeService([
      sessionRow({ teacherEmployeeId: null }),
    ]);

    await service.runScheduleConfirmationAlerts(NOW);

    const receivers = notificationService.create.mock.calls.map(
      (c: any[]) => c[0].receiverId,
    );
    expect(receivers.sort()).toEqual([11, 12]);
  });
});

describe('TeachingSessionService.confirmSession', () => {
  function pendingSession(over: Record<string, any> = {}) {
    return {
      id: 7,
      date: '2026-08-18',
      startTime: '08:00:00',
      confirmationStatus: 'PENDING',
      confirmedAt: null,
      rejectionReason: null,
      teacher: { id: 5, name: 'Cô A', employeeId: 30 },
      ...over,
    };
  }

  it('không phải giáo viên đứng tên thì bị từ chối (403)', async () => {
    const { service, sessionRepo } = makeService([]);
    sessionRepo.findOne = jest.fn().mockResolvedValue(pendingSession());

    await expect(
      service.confirmSession(7, 999, { status: 'CONFIRMED' } as any),
    ).rejects.toBeInstanceOf(Error);
  });

  it('buổi đã xử lý rồi thì không xác nhận lại được (409)', async () => {
    const { service, sessionRepo } = makeService([]);
    sessionRepo.findOne = jest
      .fn()
      .mockResolvedValue(pendingSession({ confirmationStatus: 'REJECTED' }));

    await expect(
      service.confirmSession(7, 30, { status: 'CONFIRMED' } as any),
    ).rejects.toThrow('đã được xử lý');
  });

  it('từ chối mà không nêu lý do thì bị chặn (400)', async () => {
    const { service, sessionRepo } = makeService([]);
    sessionRepo.findOne = jest.fn().mockResolvedValue(pendingSession());

    await expect(
      service.confirmSession(7, 30, { status: 'REJECTED' } as any),
    ).rejects.toThrow('lý do từ chối');
  });

  it('xác nhận thành công thì đánh dấu đã đọc thông báo liên quan của giáo viên', async () => {
    const { service, sessionRepo, notificationService } = makeService([]);
    sessionRepo.findOne = jest
      .fn()
      .mockResolvedValueOnce(pendingSession())
      .mockResolvedValue(null);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 7 } as any);

    await service.confirmSession(7, 30, { status: 'CONFIRMED' } as any);

    expect(
      notificationService.markTeachingSessionConfirmationAsRead,
    ).toHaveBeenCalledWith(30, 7);
  });
});
