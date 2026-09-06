import { NotificationType } from '../enums/notification-type.enum';
import { NotificationService } from './notification.service';

function makeService() {
  const repo = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const service = new NotificationService(
    repo as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, repo };
}

describe('NotificationService — đánh dấu đã đọc khi thao tác xong ngoài chuông thông báo', () => {
  it('markAllAsReadByTypeAndEntity(): đánh dấu mọi người nhận chưa đọc của cùng type+entity', async () => {
    const { service, repo } = makeService();

    await service.markAllAsReadByTypeAndEntity(NotificationType.POLICY, 42);

    expect(repo.update).toHaveBeenCalledWith(
      { type: NotificationType.POLICY, entityId: 42, isRead: false },
      { isRead: true },
    );
  });

  it('markAsReadByTypeEntityForReceiver(): chỉ đánh dấu cho đúng receiverId', async () => {
    const { service, repo } = makeService();

    await service.markAsReadByTypeEntityForReceiver(
      NotificationType.SUGGEST,
      7,
      99,
    );

    expect(repo.update).toHaveBeenCalledWith(
      {
        type: NotificationType.SUGGEST,
        entityId: 7,
        receiverId: 99,
        isRead: false,
      },
      { isRead: true },
    );
  });
});
