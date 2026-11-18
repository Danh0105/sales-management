/**
 * Kênh Zalo của báo động "chưa check-in".
 *
 * Cờ bật/tắt được đọc tại thời điểm gửi để giá trị ConfigModule nạp từ `.env`
 * có hiệu lực trong lúc ứng dụng chạy.
 *
 * Từ 02/11/2026 Zalo chỉ báo buổi ở trường khu vực TP.HCM và chỉ gửi Nhân sự.
 */

const CHAINABLE = ['innerJoin', 'leftJoin', 'where', 'andWhere', 'select', 'addSelect', 'orderBy', 'addOrderBy'];

function makeQueryBuilder(rows: any[] = []) {
  const qb: any = {};
  for (const method of CHAINABLE) qb[method] = jest.fn(() => qb);
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

type Manager = { id: number; zaloUserId: string | null; roles: string[] };

/** Lọc nhân viên theo `roles` truyền vào `.where(...)` như câu SQL thật. */
function makeEmployeeQueryBuilder(employees: Manager[]) {
  const qb: any = {};
  let roles: string[] = [];
  for (const method of CHAINABLE) qb[method] = jest.fn(() => qb);
  qb.where = jest.fn((_sql: string, params: { roles: string[] }) => {
    roles = params.roles;
    return qb;
  });
  qb.getRawMany = jest.fn(async () =>
    employees.filter((e) => e.roles.some((r) => roles.includes(r))),
  );
  return qb;
}

const NOW = new Date('2026-08-17T01:00:00.000Z'); // 08:00 +07

/** Phường thuộc TP.HCM (provinces.id = 6). */
const HCM_SCHOOL = { schoolWardId: 1, schoolProvinceId: 6 };
/** Phường Bình Dương cũ — đã gộp vào TP.HCM nhưng không tính khu vực HCM. */
const BINH_DUONG_SCHOOL = { schoolWardId: 68, schoolProvinceId: 6 };
const OTHER_PROVINCE_SCHOOL = { schoolWardId: 500, schoolProvinceId: 1 };

const SESSION_ROW = {
  id: 1,
  date: '2026-08-17',
  startTime: '08:05:00',
  teacherId: 5,
  teacherName: 'Hoàng Đức Em',
  schoolName: 'Tiểu học Dịch Vọng A',
  className: '1A1',
  ...HCM_SCHOOL,
};

function makeService(
  ServiceClass: any,
  managers: Manager[],
  sessions: any[] = [SESSION_ROW],
) {
  const sessionRepo: any = {
    createQueryBuilder: jest.fn(() => makeQueryBuilder(sessions)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const employeeRepo: any = {
    createQueryBuilder: jest.fn(() => makeEmployeeQueryBuilder(managers)),
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
      { id: 11, zaloUserId: 'zalo-11', roles: ['nhansu'] },
    ]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(zaloNotifyService.sendToMany).not.toHaveBeenCalled();
    expect(result.zaloSent).toBe(0);
  });

  it('bật cờ thì chỉ gửi Nhân sự có zalo_user_id, Giáo vụ không nhận Zalo', async () => {
    const ServiceClass = loadService(true);
    const { service, zaloNotifyService } = makeService(ServiceClass, [
      { id: 11, zaloUserId: 'zalo-11', roles: ['nhansu'] },
      { id: 12, zaloUserId: null, roles: ['nhansu'] },
      { id: 13, zaloUserId: 'zalo-13', roles: ['giaovien_congty', 'giaovu'] },
    ]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(zaloNotifyService.sendToMany).toHaveBeenCalledTimes(1);
    const [targets, message] = zaloNotifyService.sendToMany.mock.calls[0];
    expect(targets).toEqual(['zalo-11']);
    expect(message).toContain('CHƯA CHECK-IN');
    expect(message).toContain('Hoàng Đức Em');
    expect(result.zaloSent).toBe(1);
    // Thông báo trong app vẫn đủ cho cả 3 người, không vì Zalo mà bớt ai.
    expect(result.recipients).toBe(3);
  });

  it('buổi ở trường ngoài khu vực HCM thì không gửi Zalo, báo động trong app vẫn chạy', async () => {
    const ServiceClass = loadService(true);
    const { service, zaloNotifyService } = makeService(
      ServiceClass,
      [{ id: 11, zaloUserId: 'zalo-11', roles: ['nhansu'] }],
      [
        { ...SESSION_ROW, ...BINH_DUONG_SCHOOL },
        { ...SESSION_ROW, id: 2, teacherId: 6, ...OTHER_PROVINCE_SCHOOL },
        { ...SESSION_ROW, id: 3, teacherId: 7, schoolWardId: null, schoolProvinceId: null },
      ],
    );

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(zaloNotifyService.sendToMany).not.toHaveBeenCalled();
    expect(result.zaloSent).toBe(0);
    expect(result.sessions).toBe(3);
    expect(result.recipients).toBe(1);
  });

  it('lẫn khu vực thì tin Zalo chỉ liệt kê buổi ở HCM', async () => {
    const ServiceClass = loadService(true);
    const { service, zaloNotifyService } = makeService(
      ServiceClass,
      [{ id: 11, zaloUserId: 'zalo-11', roles: ['nhansu'] }],
      [
        SESSION_ROW,
        { ...SESSION_ROW, id: 2, teacherId: 6, teacherName: 'Lê Thị Bình Dương', ...BINH_DUONG_SCHOOL },
        { ...SESSION_ROW, id: 3, teacherId: 7, teacherName: 'Phạm Văn Hà Nội', ...OTHER_PROVINCE_SCHOOL },
      ],
    );

    await service.runMissingCheckinAlerts(NOW);

    const [, message] = zaloNotifyService.sendToMany.mock.calls[0];
    expect(message).toContain('Hoàng Đức Em');
    expect(message).not.toContain('Lê Thị Bình Dương');
    expect(message).not.toContain('Phạm Văn Hà Nội');
  });

  it('chưa Nhân sự nào có zalo_user_id thì không gọi Zalo, báo động vẫn chạy', async () => {
    const ServiceClass = loadService(true);
    const { service, zaloNotifyService } = makeService(ServiceClass, [
      { id: 11, zaloUserId: null, roles: ['nhansu'] },
      { id: 13, zaloUserId: 'zalo-13', roles: ['giaovu'] },
    ]);

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(zaloNotifyService.sendToMany).not.toHaveBeenCalled();
    expect(result.zaloSent).toBe(0);
    expect(result.recipients).toBe(2);
  });

  it('Zalo lỗi thì nuốt lỗi, không làm hỏng lượt báo động', async () => {
    const ServiceClass = loadService(true);
    const { service, zaloNotifyService } = makeService(ServiceClass, [
      { id: 11, zaloUserId: 'zalo-11', roles: ['nhansu'] },
    ]);
    zaloNotifyService.sendToMany.mockRejectedValue(new Error('OA token hết hạn'));

    const result = await service.runMissingCheckinAlerts(NOW);

    expect(result.sessions).toBe(1);
    expect(result.recipients).toBe(1);
    expect(result.zaloSent).toBe(0);
  });
});
