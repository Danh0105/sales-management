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

describe('NotificationService — gửi kèm Zalo OA cho thông báo giảng dạy', () => {
  afterEach(() => {
    delete process.env.TEACHING_NOTIFICATION_ZALO;
  });

  it('create(): type giảng dạy + receiver có zaloUserId → gửi Zalo', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: 'zalo-5' }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
      message: 'Bạn được xếp buổi dạy mới.',
    });

    expect(notifyService.sendMessage).toHaveBeenCalledWith(
      'zalo-5',
      'Bạn được xếp buổi dạy mới.',
    );
  });

  it('create(): receiver không có zaloUserId → không gửi', async () => {
    const { service, notifyService } = makeService({
      employees: [{ id: 5, zaloUserId: null }],
    });

    await service.create({
      receiverId: 5,
      type: NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
      message: 'Bạn được xếp buổi dạy mới.',
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
        type: NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
        message: 'Bạn được xếp buổi dạy mới.',
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
      type: NotificationType.TEACHING_SCHEDULE_CONFIRM_REQUEST,
      message: 'Bạn được xếp buổi dạy mới.',
    });

    expect(notifyService.sendMessage).not.toHaveBeenCalled();
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
