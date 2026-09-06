import { TeachingSessionService } from './teaching-session.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';

describe('TeachingSessionService — cảnh báo thiếu báo giảng', () => {
  function setup(rows: any[], managers: Array<{ id: number; zaloUserId: string | null }> = []) {
    const qb: any = {};
    ['innerJoin', 'leftJoin', 'select', 'where', 'andWhere', 'orderBy', 'addOrderBy'].forEach(
      (method) => (qb[method] = jest.fn().mockReturnValue(qb)),
    );
    qb.getRawMany = jest.fn().mockResolvedValue(rows);

    const sessionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      update: jest.fn().mockResolvedValue({ affected: rows.length }),
    };
    const notificationService = { create: jest.fn().mockResolvedValue({}) };
    const employeeFcmTokenService = {
      getTokens: jest.fn().mockResolvedValue([]),
    };
    const employeeQb: any = {};
    ['createQueryBuilder', 'select', 'addSelect', 'where'].forEach((method) => {
      employeeQb[method] = jest.fn().mockReturnValue(employeeQb);
    });
    employeeQb.getRawMany = jest.fn().mockResolvedValue(
      managers.map((m) => ({ id: m.id, zaloUserId: m.zaloUserId })),
    );
    const employeeRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(employeeQb),
    };
    const service = Object.create(
      TeachingSessionService.prototype,
    ) as TeachingSessionService;
    Object.assign(service as any, {
      sessionRepo,
      notificationService,
      employeeFcmTokenService,
      employeeRepo,
      fcmService: { sendToMultiple: jest.fn() },
    });
    return { service, sessionRepo, notificationService };
  }

  it('19:00 gom các tiết thiếu theo giáo viên và chỉ gửi một thông báo', async () => {
    const rows = [
      { id: '11', employeeId: '99', startTime: '07:30:00' },
      { id: '12', employeeId: '99', startTime: '08:30:00' },
    ];
    const { service, sessionRepo, notificationService } = setup(rows);
    const now = new Date('2026-08-25T12:00:00.000Z'); // 19:00 giờ VN

    await expect(service.runMissingLessonReportAlerts(now)).resolves.toEqual({
      sessions: 2,
      teachers: 1,
    });
    expect(sessionRepo.update).toHaveBeenCalledTimes(1);
    expect(notificationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverId: 99,
        type: NotificationType.TEACHING_LESSON_REPORT_ALERT,
        meta: expect.objectContaining({ sessionIds: [11, 12] }),
      }),
    );
  });

  it('không gửi gì khi mọi tiết đã báo giảng', async () => {
    const { service, sessionRepo, notificationService } = setup([]);

    await expect(service.runMissingLessonReportAlerts()).resolves.toEqual({
      sessions: 0,
      teachers: 0,
    });
    expect(sessionRepo.update).not.toHaveBeenCalled();
    expect(notificationService.create).not.toHaveBeenCalled();
  });

  it('báo thêm cho Giáo vụ/Nhân sự — 1 thông báo tổng hợp, nêu tên giáo viên', async () => {
    const rows = [
      { id: '11', employeeId: '99', teacherName: 'Cô An', startTime: '07:30:00' },
      { id: '12', employeeId: '99', teacherName: 'Cô An', startTime: '08:30:00' },
      { id: '13', employeeId: '100', teacherName: 'Thầy Bình', startTime: '09:00:00' },
    ];
    const { service, notificationService } = setup(rows, [
      { id: 140, zaloUserId: null },
      { id: 149, zaloUserId: null },
    ]);

    await service.runMissingLessonReportAlerts(new Date('2026-08-25T12:00:00.000Z'));

    // 2 thông báo riêng cho từng giáo viên (99, 100) + 2 thông báo tổng hợp cho quản lý (140, 149).
    expect(notificationService.create).toHaveBeenCalledTimes(4);

    const managerCalls = notificationService.create.mock.calls
      .map((c: any[]) => c[0])
      .filter((c: any) => c.receiverId === 140 || c.receiverId === 149);
    expect(managerCalls).toHaveLength(2);
    for (const call of managerCalls) {
      expect(call.type).toBe(NotificationType.TEACHING_LESSON_REPORT_ALERT);
      expect(call.message).toContain('Cô An');
      expect(call.message).toContain('Thầy Bình');
      expect(call.meta.teacherCount).toBe(2);
    }
  });
});
