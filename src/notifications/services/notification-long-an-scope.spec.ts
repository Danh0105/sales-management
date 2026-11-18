import { NotificationType } from '../enums/notification-type.enum';
import { NotificationService } from './notification.service';

function makeService(inScope: Partial<Record<'policy' | 'subject' | 'sender', boolean>> = {}) {
  const employeeRepo = {
    find: jest.fn().mockResolvedValue([
      { id: 1, roles: ['director_la'] },
      { id: 2, roles: ['director_la', 'director'] },
      { id: 3, roles: ['director'] },
    ]),
  };
  const longAnScope = {
    policyInScope: jest.fn().mockResolvedValue(!!inScope.policy),
    subjectInScope: jest.fn().mockResolvedValue(!!inScope.subject),
    employeeIsLongAnOnly: jest.fn().mockResolvedValue(!!inScope.sender),
    reportInScope: jest.fn().mockResolvedValue(!!inScope.sender),
  };
  const service = new NotificationService(
    {} as any,
    {} as any,
    employeeRepo as any,
    {} as any,
    longAnScope as any,
  );
  return { service, longAnScope };
}

describe('NotificationService — phạm vi Giám đốc Long An', () => {
  it('nhận chính sách khi trường thuộc Long An', async () => {
    const { service, longAnScope } = makeService({ policy: true });
    await expect(
      service.scopeBusinessReceiverIds([1, 2, 3], 99, { kind: 'policy', policyId: 7 }),
    ).resolves.toEqual([1, 2, 3]);
    expect(longAnScope.policyInScope).toHaveBeenCalledWith(7);
  });

  it('không nhận chính sách của trường tỉnh khác, kể cả người gửi có vùng Long An', async () => {
    const { service } = makeService({ policy: false, sender: true });
    await expect(
      service.scopeBusinessReceiverIds([1, 2, 3], 99, { kind: 'policy', policyId: 7 }),
    ).resolves.toEqual([2, 3]);
  });

  it('kiểm tra theo môn khi chính sách chưa có id', async () => {
    const { service, longAnScope } = makeService({ subject: true });
    await expect(
      service.scopeBusinessReceiverIds([1], 99, { kind: 'policy', subjectId: 5 }),
    ).resolves.toEqual([1]);
    expect(longAnScope.subjectInScope).toHaveBeenCalledWith(5);
  });

  it('nhận báo cáo thuộc Long An dù nhân viên kiêm tỉnh', async () => {
    const { service } = makeService({ sender: true });
    await expect(
      service.scopeBusinessReceiverIds([1, 3], 99, { kind: 'report', reportId: 77 }),
    ).resolves.toEqual([1, 3]);
  });

  it('không nhận báo cáo tỉnh khác của cùng nhân viên kiêm tỉnh', async () => {
    const { service } = makeService({ sender: false });
    await expect(
      service.scopeBusinessReceiverIds([1, 3], 99, { kind: 'report', reportId: 78 }),
    ).resolves.toEqual([3]);
  });

  it('không khai báo nguồn thì không nhận', async () => {
    const { service } = makeService({ policy: true, subject: true, sender: true });
    await expect(service.scopeBusinessReceiverIds([1, 3], 99)).resolves.toEqual([3]);
  });

  it('báo cáo hệ thống không có người gửi thì không nhận', async () => {
    const { service } = makeService({ sender: true });
    await expect(
      service.scopeBusinessReceiverIds([1, 3], undefined, { kind: 'report' }),
    ).resolves.toEqual([3]);
  });

  it.each([
    [NotificationType.SUGGEST],
    [NotificationType.SYSTEM],
    [NotificationType.EXPENSE_REQUEST],
  ])('createNotifications: loại %s không tới Giám đốc Long An', async (type) => {
    const { service } = makeService({ policy: true, subject: true, sender: true });
    await expect(
      service.createNotifications({ receiverIds: [1], type, entityId: 7, senderId: 99 }),
    ).resolves.toEqual([]);
  });
});
