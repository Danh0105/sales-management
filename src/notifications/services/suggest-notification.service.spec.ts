import { SuggestNotificationService } from './suggest-notification.service';
import { NotificationType } from '../enums/notification-type.enum';

/**
 * `SuggestReviewedEvent`/`SuggestApprovedEvent`/`SuggestCreatedEvent` chỉ mang
 * `receiverIds`/`tokens` (số nhiều) — trước đây service này đọc nhầm
 * `event.receiverId`/`event.senderId` (số ít, không tồn tại trên các event
 * này) nên không tạo được thông báo DB đúng người, và chưa từng gọi FCM.
 */
describe('SuggestNotificationService', () => {
  function makeService() {
    const notificationService = {
      createNotifications: jest.fn().mockResolvedValue(undefined),
    };
    const fcmService = {
      sendToMultiple: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SuggestNotificationService(
      notificationService as any,
      fcmService as any,
    );
    return { service, notificationService, fcmService };
  }

  describe('handleSuggestCreated', () => {
    it('tạo 1 bản ghi thông báo cho MỖI người nhận và gửi push tới MỌI token', async () => {
      const { service, notificationService, fcmService } = makeService();

      await service.handleSuggestCreated({
        suggestId: 10,
        message: 'A gửi một đề xuất mới',
        receiverIds: [1, 2, 3],
        tokens: ['t1', 't2', 't3', 't4'],
        senderId: 9,
      });

      expect(notificationService.createNotifications).toHaveBeenCalledWith({
        receiverIds: [1, 2, 3],
        senderId: 9,
        type: NotificationType.SUGGEST,
        entityId: 10,
        message: 'A gửi một đề xuất mới',
        meta: { suggestId: 10 },
      });
      expect(fcmService.sendToMultiple).toHaveBeenCalledWith(
        ['t1', 't2', 't3', 't4'],
        expect.any(String),
        'A gửi một đề xuất mới',
        expect.objectContaining({ suggestId: '10' }),
      );
    });

    it('không có người nhận thì không tạo thông báo lẫn gửi push', async () => {
      const { service, notificationService, fcmService } = makeService();

      await service.handleSuggestCreated({
        suggestId: 10,
        message: 'x',
        receiverIds: [],
        tokens: [],
      });

      expect(notificationService.createNotifications).not.toHaveBeenCalled();
      expect(fcmService.sendToMultiple).not.toHaveBeenCalled();
    });
  });

  describe('handleSuggestReviewed', () => {
    it('dùng receiverIds/tokens của event (không phải receiverId/senderId số ít)', async () => {
      const { service, notificationService, fcmService } = makeService();

      await service.handleSuggestReviewed({
        suggestId: 20,
        message: 'B đã kiểm tra đề xuất #20, chờ duyệt',
        receiverIds: [5, 6],
        tokens: ['creator-token', 'director-1-token', 'director-2-token'],
        reviewerId: 7,
        status: 'APPROVED',
      });

      expect(notificationService.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({ receiverIds: [5, 6], senderId: 7, entityId: 20 }),
      );
      expect(fcmService.sendToMultiple).toHaveBeenCalledWith(
        ['creator-token', 'director-1-token', 'director-2-token'],
        expect.any(String),
        'B đã kiểm tra đề xuất #20, chờ duyệt',
        expect.anything(),
      );
    });
  });

  describe('handleSuggestApproved', () => {
    it('đọc đúng field lồng trong event.data (SuggestApprovedEvent bọc data)', async () => {
      const { service, notificationService, fcmService } = makeService();

      await service.handleSuggestApproved({
        data: {
          suggestId: 30,
          message: 'C đã phê duyệt đề xuất #30',
          receiverIds: [8],
          tokens: ['creator-ios', 'creator-android'],
          actorId: 11,
        },
      });

      expect(notificationService.createNotifications).toHaveBeenCalledWith(
        expect.objectContaining({ receiverIds: [8], senderId: 11, entityId: 30 }),
      );
      expect(fcmService.sendToMultiple).toHaveBeenCalledWith(
        ['creator-ios', 'creator-android'],
        expect.any(String),
        'C đã phê duyệt đề xuất #30',
        expect.anything(),
      );
    });
  });
});
