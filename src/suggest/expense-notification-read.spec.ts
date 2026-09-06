import { SuggestService } from './suggest.service';
import { SuggestStatus } from './SuggestStatus.enum';
import { ExpenseRole } from './constants/expense-roles';
import { NotificationType } from '../notifications/enums/notification-type.enum';

/**
 * Khi một người trong nhóm giữ bước đã xử lý xong, lời nhắc "đến lượt bạn" của
 * những người CÙNG nhóm cũng phải tự tắt (giám đốc 1 duyệt → giám đốc 2, 3 hết
 * chưa đọc), nhưng thông báo của nhóm khác thì giữ nguyên.
 */
describe('Đánh dấu đã đọc theo nhóm giữ bước — đề xuất chi', () => {
  function makeService(roleIds: number[] = []) {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    const notificationService = {
      markAsReadByTypeEntityForReceivers: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).notificationService = notificationService;
    (service as any).logger = { error: jest.fn() };
    (service as any).getEmployeeIdsByRoles = jest.fn().mockResolvedValue(roleIds);
    return { service, notificationService };
  }

  const callMark = (service: SuggestService, suggest: any, from: SuggestStatus, actorId: number) =>
    (service as any).markExpenseStepNotificationsRead(suggest, from, {
      id: actorId,
      roles: [ExpenseRole.DIRECTOR],
    });

  it('duyệt xong: tắt nhắc cho MỌI người giữ bước duyệt, không chỉ người vừa bấm', async () => {
    // 3 giám đốc/sales admin cùng nhận "cần duyệt"
    const { service, notificationService } = makeService([11, 12, 13]);

    await callMark(service, { id: 55, createdBy: 99 }, SuggestStatus.PENDING_APPROVAL, 11);

    expect(notificationService.markAsReadByTypeEntityForReceivers).toHaveBeenCalledWith(
      NotificationType.SUGGEST,
      55,
      expect.arrayContaining([11, 12, 13]),
    );
    // Người tạo đơn KHÔNG bị đánh dấu — họ cần thấy kết quả "đã duyệt".
    const receivers =
      notificationService.markAsReadByTypeEntityForReceivers.mock.calls[0][2];
    expect(receivers).not.toContain(99);
  });

  it('bước của kế toán công nợ: tắt nhắc cho cả nhóm kế toán công nợ', async () => {
    const { service, notificationService } = makeService([21, 22]);

    await callMark(service, { id: 56, createdBy: 99 }, SuggestStatus.APPROVED, 21);

    expect(notificationService.markAsReadByTypeEntityForReceivers).toHaveBeenCalledWith(
      NotificationType.SUGGEST,
      56,
      expect.arrayContaining([21, 22]),
    );
  });

  it('bước của chủ đơn (đã nhận tiền): đánh dấu cho chính chủ đơn', async () => {
    const { service, notificationService } = makeService([]);

    await callMark(service, { id: 57, createdBy: 99 }, SuggestStatus.CASH_RELEASED, 99);

    const receivers =
      notificationService.markAsReadByTypeEntityForReceivers.mock.calls[0][2];
    expect(receivers).toContain(99);
  });

  it('lỗi đánh dấu không được làm hỏng bước chuyển trạng thái', async () => {
    const { service, notificationService } = makeService([11]);
    notificationService.markAsReadByTypeEntityForReceivers.mockRejectedValue(
      new Error('DB lỗi'),
    );

    await expect(
      callMark(service, { id: 58, createdBy: 99 }, SuggestStatus.PENDING_APPROVAL, 11),
    ).resolves.toBeUndefined();
  });
});
