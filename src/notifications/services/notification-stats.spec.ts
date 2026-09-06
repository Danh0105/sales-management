import { NotificationType } from '../enums/notification-type.enum';
import { NotificationService } from './notification.service';

describe('NotificationService.getNotificationStats', () => {
  it('luôn trả đủ loại thông báo để client đọc unread an toàn', async () => {
    const qb: any = {
      select: jest.fn(),
      addSelect: jest.fn(),
      where: jest.fn(),
      groupBy: jest.fn(),
      addGroupBy: jest.fn(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    for (const method of [
      'select',
      'addSelect',
      'where',
      'groupBy',
      'addGroupBy',
    ]) {
      qb[method].mockReturnValue(qb);
    }
    const service = new NotificationService(
      { createQueryBuilder: jest.fn().mockReturnValue(qb) } as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getNotificationStats(12);

    for (const type of Object.values(NotificationType)) {
      expect(result[type]).toEqual({ unread: 0, read: 0 });
    }
    expect(result[NotificationType.TEACHER_LOCATION_CHANGE_REQUEST]).toEqual({
      unread: 0,
      read: 0,
    });
  });
});
