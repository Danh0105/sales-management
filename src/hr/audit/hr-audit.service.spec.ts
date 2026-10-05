import { DataSource, EntityManager } from 'typeorm';
import { HrAuditLog } from './entities/hr-audit-log.entity';
import { HrAuditAction } from './hr-audit-action';
import { HrAuditService, HrAuditValidationError } from './hr-audit.service';

function manager(inTransaction: boolean) {
  const insert = jest.fn((_target: unknown, row: Partial<HrAuditLog>) => {
    void row;
    return Promise.resolve({ identifiers: [{ id: '42' }] });
  });
  const m = {
    queryRunner: inTransaction ? { isTransactionActive: true } : undefined,
    insert,
  } as unknown as EntityManager & { insert: typeof insert };
  return m;
}

const actor = {
  accountId: 158,
  name: 'HR',
  roles: ['nhansu'],
  ip: '198.51.100.7',
  userAgent: 'UA',
  requestId: 'r1',
};

describe('HrAuditService', () => {
  const standaloneManager = manager(false);
  const service = new HrAuditService({
    manager: standaloneManager,
  } as unknown as DataSource);

  it('happy path: ghi đủ trường trong transaction, trả id', async () => {
    const m = manager(true);
    await expect(
      service.record(m, {
        actor,
        action: HrAuditAction.HOLIDAY_CREATE,
        entity: 'holiday',
        entityId: 7,
        newValue: { date: '2026-09-02', name: 'Quốc khánh' },
      }),
    ).resolves.toBe('42');
    expect(m.insert).toHaveBeenCalledWith(HrAuditLog, {
      actorAccountId: 158,
      actorName: 'HR',
      actorRoles: ['nhansu'],
      action: 'HOLIDAY_CREATE',
      entity: 'holiday',
      entityId: '7',
      oldValue: null,
      newValue: { date: '2026-09-02', name: 'Quốc khánh' },
      reason: null,
      ip: '198.51.100.7',
      userAgent: 'UA',
      requestId: 'r1',
    });
  });

  it('transaction: record() ngoài transaction bị từ chối', async () => {
    await expect(
      service.record(manager(false), {
        actor,
        action: HrAuditAction.HOLIDAY_CREATE,
        entity: 'holiday',
      }),
    ).rejects.toThrow('phải ghi trong transaction');
  });

  it('che dữ liệu nhạy cảm trong old/new value trước khi ghi', async () => {
    const m = manager(true);
    await service.record(m, {
      actor,
      action: HrAuditAction.ACCESS_GRANT,
      entity: 'account_permission_grant',
      reason: 'bổ nhiệm',
      oldValue: { bankAccount: '0011002233445', salary: 18000000 },
      newValue: { identityNumber: '079201001234', password: 'x' },
    });
    const row = m.insert.mock.calls[0][1];
    expect(row.oldValue).toEqual({
      bankAccount: '********3445',
      salary: '***',
    });
    expect(row.newValue).toEqual({
      identityNumber: '********1234',
      password: '[REDACTED]',
    });
  });

  it('giá trị quá 32KB → thay bằng đánh dấu truncated', async () => {
    const m = manager(true);
    await service.record(m, {
      actor,
      action: HrAuditAction.HOLIDAY_UPDATE,
      entity: 'holiday',
      newValue: { blob: 'x'.repeat(40_000) },
    });
    expect(m.insert.mock.calls[0][1].newValue).toEqual({
      _truncated: true,
      bytes: expect.any(Number),
    });
  });

  describe('validation', () => {
    const base = { actor, entity: 'holiday' };

    it.each([
      [
        'hành động lạ',
        { ...base, action: 'DROP_ALL' as HrAuditAction },
        'không hợp lệ',
      ],
      [
        'entity sai định dạng',
        {
          ...base,
          action: HrAuditAction.HOLIDAY_CREATE,
          entity: 'Holiday; DROP',
        },
        'Tên entity',
      ],
      [
        'entityId quá dài',
        {
          ...base,
          action: HrAuditAction.HOLIDAY_CREATE,
          entityId: 'x'.repeat(65),
        },
        '64',
      ],
      [
        'reveal không có lý do',
        { ...base, action: HrAuditAction.IDENTITY_REVEAL },
        'bắt buộc phải có lý do',
      ],
      [
        'cấp quyền với lý do toàn khoảng trắng',
        { ...base, action: HrAuditAction.ACCESS_GRANT, reason: '   ' },
        'bắt buộc phải có lý do',
      ],
      [
        'lý do quá dài',
        {
          ...base,
          action: HrAuditAction.ACCESS_GRANT,
          reason: 'x'.repeat(2001),
        },
        'Lý do quá',
      ],
    ])('%s', async (_label, entry, message) => {
      const m = manager(true);
      await expect(service.record(m, entry)).rejects.toThrow(message);
      await expect(service.record(m, entry)).rejects.toBeInstanceOf(
        HrAuditValidationError,
      );
      expect(m.insert).not.toHaveBeenCalled();
    });
  });

  describe('recordStandalone', () => {
    it('cho phép hành động chỉ đọc (xem CCCD đầy đủ)', async () => {
      await expect(
        service.recordStandalone({
          actor,
          action: HrAuditAction.IDENTITY_REVEAL,
          entity: 'employee',
          entityId: 12,
          reason: 'đối chiếu hồ sơ BHXH',
        }),
      ).resolves.toBe('42');
      expect(standaloneManager.insert).toHaveBeenCalled();
    });

    it('từ chối hành động làm đổi dữ liệu — bắt dùng transaction', async () => {
      await expect(
        service.recordStandalone({
          actor,
          action: HrAuditAction.ACCESS_GRANT,
          entity: 'account_permission_grant',
          reason: 'x',
        }),
      ).rejects.toThrow('phải dùng record(manager');
    });
  });
});
