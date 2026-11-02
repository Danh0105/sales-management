import { NotificationType } from '../enums/notification-type.enum';
import { NotificationService } from './notification.service';

function makeRepo(overrides: Partial<Record<string, any>> = {}) {
  return {
    create: jest.fn((data) => data),
    save: jest.fn((data) => (Array.isArray(data) ? data : { id: 1, ...data })),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeService(overrides: {
  employees?: { id: number; zaloUserId: string | null }[];
  sendMessage?: jest.Mock;
  sendToMany?: jest.Mock;
} = {}) {
  const notificationRepo = makeRepo();
  const gateway = { emitToUser: jest.fn() };
  const employeeRepo = makeRepo({
    findOne: jest
      .fn()
      .mockImplementation(async ({ where: { id } }: any) =>
        (overrides.employees || []).find((e) => e.id === id) ?? null,
      ),
    // Lọc theo ids không quan trọng cho các test này — receiverIds truyền vào
    // luôn khớp đúng danh sách employees giả lập sẵn.
    find: jest.fn().mockResolvedValue(overrides.employees || []),
  });
  const notifyService = {
    sendMessage: overrides.sendMessage ?? jest.fn().mockResolvedValue(undefined),
    sendToMany: overrides.sendToMany ?? jest.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };

  const service = new NotificationService(
    notificationRepo as any,
    gateway as any,
    employeeRepo as any,
    notifyService as any,
  );

  return { service, notificationRepo, gateway, employeeRepo, notifyService };
}

const TEACHER_URL = '/#/giao-vien/lich-day';
const TEACHER_LINK = `https://kidoapp.kidoedu.vn${TEACHER_URL}`;

function confirmRequest(receiverId: number, n: number) {
  return {
    receiverId,
    type: NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
    message: `Bạn được xếp buổi dạy số ${n}. Vui lòng xác nhận hoặc từ chối.`,
    meta: { url: TEACHER_URL, summary: `Buổi số ${n}` },
  };
}

describe('NotificationService — gửi kèm Zalo OA cho thông báo giảng dạy', () => {
  afterEach(() => {
    delete process.env.TEACHING_NOTIFICATION_ZALO;
    delete process.env.TEACHING_APP_URL;
  });

  it('create(): type giảng dạy + receiver có zaloUserId → gửi Zalo kèm link', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.TEACHING_SCHEDULE,
      message: 'Lịch dạy tuần tới.',
      meta: { url: TEACHER_URL },
    });

    expect(notifyService.sendMessage).toHaveBeenCalledWith(
      'zalo-5',
      `Lịch dạy tuần tới.\n👉 ${TEACHER_LINK}`,
    );
  });

  it('create(): không có meta.url thì gửi nguyên nội dung', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.TEACHING_SCHEDULE,
      message: 'Lịch dạy tuần tới.',
    });

    expect(notifyService.sendMessage).toHaveBeenCalledWith('zalo-5', 'Lịch dạy tuần tới.');
  });

  it('create(): receiver không có zaloUserId → không gửi', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: null }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.TEACHING_SCHEDULE,
      message: 'Lịch dạy tuần tới.',
    });

    expect(notifyService.sendMessage).not.toHaveBeenCalled();
  });

  it('create(): type ngoài nhóm giảng dạy (POLICY) → không gửi dù có zaloUserId', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.POLICY,
      message: 'Có chính sách mới.',
    });

    expect(notifyService.sendMessage).not.toHaveBeenCalled();
  });

  it('create(): TEACHING_CHECKIN_ALERT bị loại trừ để tránh gửi trùng', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.TEACHING_CHECKIN_ALERT,
      message: 'Giáo viên chưa check-in.',
    });

    expect(notifyService.sendMessage).not.toHaveBeenCalled();
  });

  it('create(): notifyService lỗi thì vẫn resolve, không throw ra ngoài', async () => {
    const { service } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
      sendMessage: jest.fn().mockRejectedValue(new Error('Zalo lỗi')),
    });

    await expect(
      service.create({
        receiverId: 5,
        type: NotificationType.TEACHING_SCHEDULE,
        message: 'Lịch dạy tuần tới.',
      }),
    ).resolves.toMatchObject({ receiverId: 5 });
  });

  it('create(): TEACHING_NOTIFICATION_ZALO=0 thì tắt gửi', async () => {
    process.env.TEACHING_NOTIFICATION_ZALO = '0';
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.TEACHING_SCHEDULE,
      message: 'Lịch dạy tuần tới.',
    });
    await service.create(confirmRequest(5, 1));
    await service.flushConfirmDigest(5);

    expect(notifyService.sendMessage).not.toHaveBeenCalled();
  });

  it('TEACHING_APP_URL đổi được gốc link', async () => {
    process.env.TEACHING_APP_URL = 'https://staging.example.vn/';
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.TEACHING_SCHEDULE,
      message: 'Lịch dạy tuần tới.',
      meta: { url: TEACHER_URL },
    });

    expect(notifyService.sendMessage).toHaveBeenCalledWith(
      'zalo-5',
      `Lịch dạy tuần tới.\n👉 https://staging.example.vn${TEACHER_URL}`,
    );
  });

  it('createNotifications(): gửi hàng loạt chỉ tới người đã liên kết Zalo', async () => {
    const { service, notifyService } = makeService({
      employees: [
        { id: 1, zaloUserId: 'zalo-1' },
        { id: 2, zaloUserId: null },
      ],
    });

    await service.createNotifications({
      receiverIds: [1, 2],
      type: NotificationType.TEACHING_REPLACEMENT_REQUEST,
      message: 'Giáo viên đã từ chối buổi dạy.',
    });

    expect(notifyService.sendToMany).toHaveBeenCalledTimes(1);
    expect(notifyService.sendToMany).toHaveBeenCalledWith(
      ['zalo-1'],
      'Giáo viên đã từ chối buổi dạy.',
    );
  });
});

describe('NotificationService — gộp tin Zalo yêu cầu xác nhận lịch dạy', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.TEACHING_NOTIFICATION_ZALO;
  });

  it('không gửi ngay; yên 30 giây thì gửi 1 tin có tiêu đề + link', async () => {
    const { service, notifyService, gateway } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    await service.create(confirmRequest(5, 1));
    // Thông báo trong app vẫn tới ngay.
    expect(gateway.emitToUser).toHaveBeenCalledTimes(1);
    expect(notifyService.sendMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(notifyService.sendMessage).toHaveBeenCalledTimes(1);
    expect(notifyService.sendMessage).toHaveBeenCalledWith(
      'zalo-5',
      '📅 LỊCH DẠY CẦN XÁC NHẬN\n' +
        'Bạn được xếp buổi dạy số 1. Vui lòng xác nhận hoặc từ chối.\n' +
        `👉 ${TEACHER_LINK}`,
    );
  });

  it('xếp liền nhiều lịch → mỗi giáo viên 1 tin liệt kê các lịch', async () => {
    const { service, notifyService } = makeService({
      employees: [
        { id: 5, zaloUserId: 'zalo-5' },
        { id: 6, zaloUserId: 'zalo-6' },
      ],
    });

    await service.create(confirmRequest(5, 1));
    await jest.advanceTimersByTimeAsync(10_000);
    await service.create(confirmRequest(6, 2));
    await service.create(confirmRequest(5, 3));
    await jest.advanceTimersByTimeAsync(29_000);
    expect(notifyService.sendMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);

    expect(notifyService.sendMessage).toHaveBeenCalledTimes(2);
    expect(notifyService.sendMessage).toHaveBeenCalledWith(
      'zalo-5',
      '📅 LỊCH DẠY CẦN XÁC NHẬN\n' +
        'Bạn được xếp 2 lịch dạy mới:\n' +
        '• Buổi số 1\n' +
        '• Buổi số 3\n' +
        'Vui lòng xác nhận hoặc từ chối.\n' +
        `👉 ${TEACHER_LINK}`,
    );
    expect(notifyService.sendMessage).toHaveBeenCalledWith(
      'zalo-6',
      expect.stringContaining('Bạn được xếp buổi dạy số 2.'),
    );
  });

  it('Nhân sự xếp liên tục không ngừng → chậm nhất 2 phút sau lịch đầu vẫn gửi', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    for (let n = 1; n <= 12; n++) {
      await service.create(confirmRequest(5, n));
      await jest.advanceTimersByTimeAsync(10_000);
    }

    expect(notifyService.sendMessage).toHaveBeenCalledTimes(1);
    expect(notifyService.sendMessage.mock.calls[0][1]).toContain('Bạn được xếp 12 lịch dạy mới:');
  });

  it('quá 15 lịch thì rút gọn phần còn lại', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    for (let n = 1; n <= 20; n++) await service.create(confirmRequest(5, n));
    await service.flushConfirmDigest(5);

    const text = notifyService.sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('Bạn được xếp 20 lịch dạy mới:');
    expect(text).toContain('• Buổi số 15\n… và 5 lịch khác');
    expect(text).not.toContain('Buổi số 16');
  });

  it('Zalo lỗi khi gửi tin gộp thì nuốt lỗi', async () => {
    const { service } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
      sendMessage: jest.fn().mockRejectedValue(new Error('Zalo từ chối, mã -213')),
    });

    await service.create(confirmRequest(5, 1));
    await expect(service.flushConfirmDigest(5)).resolves.toBeUndefined();
  });
});
