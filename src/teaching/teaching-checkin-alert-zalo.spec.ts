/**
 * Kênh Zalo của báo động "chưa check-in".
 *
 * Cờ bật/tắt được đọc tại thời điểm gửi để giá trị ConfigModule nạp từ `.env`
 * có hiệu lực trong lúc ứng dụng chạy.
 */

const CHAINABLE = ['innerJoin', 'leftJoin', 'where', 'andWhere', 'select', 'addSelect', 'orderBy', 'addOrderBy'];

function makeQueryBuilder(rows: any[] = []) {
  const qb: any = {};
  for (const method of CHAINABLE) qb[method] = jest.fn(() => qb);
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

const NOW = new Date('2026-08-17T01:00:00.000Z'); // 08:00 +07

const SESSION_ROW = {
  id: 1,
  date: '2026-08-17',
  startTime: '08:05:00',
  teacherId: 5,
  teacherName: 'Hoàng Đức Em',
  schoolName: 'Tiểu học Dịch Vọng A',
  className: '1A1',
};

function makeService(
  ServiceClass: any,
  managers: Array<{ id: number; zaloUserId: string | null }>,
) {
  const sessionRepo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder([SESSION_ROW])),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const employeeRepo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder(managers)),
  };
  const zaloNotifyService: any = {
    sendToMany: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }),
  };

  const service = new ServiceClass(
    sessionRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { create: jest.fn().mockResolvedValue({ id: 1 }) },
    { sendToMultiple: jest.fn().mockResolvedValue(null) },
    { getTokens: jest.fn().mockResolvedValue([]) },
    undefined,
    employeeRepo,
    zaloNotifyService,
  );

  return { service, zaloNotifyService };
}

function loadService(enabled: boolean) {
  jest.resetModules();
  if (enabled) process.env.TEACHING_CHECKIN_ALERT_ZALO = '1';
  else delete process.env.TEACHING_CHECKIN_ALERT_ZALO;

  return require('./teaching-session.service').TeachingSessionService;
}

describe('Báo động chưa check-in — kênh Zalo', () => {
  const originalEnv = process.env.TEACHING_CHECKIN_ALERT_ZALO;

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.TEACHING_CHECKIN_ALERT_ZALO;
    else process.env.TEACHING_CHECKIN_ALERT_ZALO = originalEnv;
  });

  it('tắt cờ thì không gọi Zalo dù người nhận có zalo_user_id', async () => {
    const ServiceClass = loadService(false);
    const { service, zaloNotifyService } = makeService(ServiceClass, [
      { id: 11, zaloUserId: 'zalo-11' },
    ]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(zaloNotifyService.sendToMany).not.toHaveBeenCalled();
    expect(result.zaloSent).toBe(0);
  });

  it('bật cờ thì gửi cho người có zalo_user_id, bỏ qua người chưa gán', async () => {
    const ServiceClass = loadService(true);
    const { service, zaloNotifyService } = makeService(ServiceClass, [
      { id: 11, zaloUserId: 'zalo-11' },
      { id: 12, zaloUserId: null },
      { id: 13, zaloUserId: 'zalo-13' },
    ]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(zaloNotifyService.sendToMany).toHaveBeenCalledTimes(1);
    const [targets, message] = zaloNotifyService.sendToMany.mock.calls[0];
    expect(targets).toEqual(['zalo-11', 'zalo-13']);
    expect(message).toContain('CHƯA CHECK-IN');
    expect(message).toContain('Hoàng Đức Em');
    expect(result.zaloSent).toBe(1);
    // Thông báo trong app vẫn đủ cho cả 3 người, không vì Zalo mà bớt ai.
    expect(result.recipients).toBe(3);
  });

  it('chưa ai có zalo_user_id thì không gọi Zalo, báo động vẫn chạy', async () => {
    const ServiceClass = loadService(true);
    const { service, zaloNotifyService } = makeService(ServiceClass, [
      { id: 11, zaloUserId: null },
    ]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(zaloNotifyService.sendToMany).not.toHaveBeenCalled();
    expect(result.zaloSent).toBe(0);
    expect(result.recipients).toBe(1);
  });

  it('Zalo lỗi thì nuốt lỗi, không làm hỏng lượt báo động', async () => {
    const ServiceClass = loadService(true);
    const { service, zaloNotifyService } = makeService(ServiceClass, [
      { id: 11, zaloUserId: 'zalo-11' },
    ]);
    zaloNotifyService.sendToMany.mockRejectedValue(new Error('OA token hết hạn'));

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(result.sessions).toBe(1);
    expect(result.recipients).toBe(1);
    expect(result.zaloSent).toBe(0);
  });
});
