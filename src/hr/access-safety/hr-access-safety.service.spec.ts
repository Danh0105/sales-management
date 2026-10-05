import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditService } from '../audit/hr-audit.service';
import {
  breaksAdminQuota,
  MIN_PROTECTED_HR_ADMINS,
  quotaErrorBody,
} from './hr-admin-quota';
import {
  HrAccessSafetyService,
  QuotaSimulation,
} from './hr-access-safety.service';

describe('breaksAdminQuota', () => {
  it.each([
    [3, 2, false],
    [2, 1, true],
    [2, 2, false],
    [1, 1, false],
    [1, 0, true],
    [0, 0, false],
    [5, 1, true],
  ])('trước %i, sau %i → chặn: %s', (before, after, expected) => {
    expect(breaksAdminQuota(before, after)).toBe(expected);
  });

  it('message 409 rõ ràng theo từng thao tác', () => {
    expect(quotaErrorBody('deactivate', 2, 1)).toMatchObject({
      statusCode: 409,
      code: 'HR_ADMIN_MINIMUM',
      message:
        'Cannot deactivate this account because it would leave the company with fewer than the required HR administrators. Assign another HR administrator first.',
      minimum: MIN_PROTECTED_HR_ADMINS,
    });
  });
});

/**
 * Dựng service với DB giả: `protectedAdminIds` trả theo kịch bản; `query`
 * trả kết quả cho các truy vấn phụ (đã cài HRM?, lịch sử quyền, role hợp lệ...).
 */
function setup(
  opts: {
    installed?: boolean;
    protectedIds?: number[];
    activeIds?: number[];
    hasHistory?: boolean;
    roleQualifies?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const manager = {
    queryRunner: { isTransactionActive: true },
    query: jest.fn((sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        calls.push('lock');
        return Promise.resolve([]);
      }
      if (sql.includes('to_regclass'))
        return Promise.resolve([{ installed: opts.installed ?? true }]);
      if (sql.includes('AS has'))
        return Promise.resolve([{ has: opts.hasHistory ?? false }]);
      if (sql.includes('AS ok'))
        return Promise.resolve([{ ok: opts.roleQualifies ?? true }]);
      return Promise.resolve([]);
    }),
  } as unknown as EntityManager;
  const dataSource = {
    manager,
    transaction: jest.fn((cb: (m: EntityManager) => unknown) => cb(manager)),
  } as unknown as DataSource;
  const audit = { record: jest.fn(() => Promise.resolve('1')) };
  const service = new HrAccessSafetyService(
    dataSource,
    audit as unknown as HrAuditService,
  );

  const ids = opts.protectedIds ?? [1, 2, 3];
  jest
    .spyOn(service, 'protectedAdminIds')
    .mockImplementation((_m, _on, sim: QuotaSimulation = {}) => {
      calls.push('count');
      return Promise.resolve(
        ids.filter(
          (id) =>
            !(sim.excludeAccountIds ?? []).includes(id) &&
            // assignment id = account id * 10 trong kịch bản giả
            !(sim.excludeAssignmentIds ?? []).includes(id * 10),
        ),
      );
    });
  jest
    .spyOn(service, 'activeAdminIds')
    .mockResolvedValue(opts.activeIds ?? ids);

  return { service, manager, dataSource, audit, calls };
}

describe('HrAccessSafetyService', () => {
  it('lock() ngoài transaction → lỗi lập trình', async () => {
    const { service } = setup();
    await expect(
      service.lock({ queryRunner: undefined } as unknown as EntityManager),
    ).rejects.toThrow('phải gọi trong transaction');
  });

  describe('assertCanRevokeAssignment', () => {
    it('3 protected → thu hồi 1 → còn 2: cho phép', async () => {
      const { service, manager } = setup({ protectedIds: [1, 2, 3] });
      await expect(
        service.assertCanRevokeAssignment(manager, 30),
      ).resolves.toEqual({ before: 3, after: 2 });
    });

    it('2 protected → thu hồi 1 → còn 1: 409', async () => {
      const { service, manager } = setup({ protectedIds: [1, 2] });
      await expect(
        service.assertCanRevokeAssignment(manager, 20),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('assertCanChangeAssignment (thêm effectiveTo / đổi scope / đổi role)', () => {
    it('protected admin thêm effectiveTo khi chỉ còn 2 → 409', async () => {
      const { service, manager } = setup({ protectedIds: [1, 2] });
      await expect(
        service.assertCanChangeAssignment(manager, 20, 2, {
          roleCode: 'HR_ADMIN',
          scope: 'COMPANY',
          effectiveTo: '2026-12-31',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          message: expect.stringContaining('Cannot change this assignment'),
        }),
      });
    });

    it('thêm effectiveTo khi còn 3 protected → cho phép (còn 2)', async () => {
      const { service, manager } = setup({ protectedIds: [1, 2, 3] });
      await expect(
        service.assertCanChangeAssignment(manager, 30, 3, {
          roleCode: 'HR_ADMIN',
          scope: 'COMPANY',
          effectiveTo: '2026-12-31',
        }),
      ).resolves.toEqual({ before: 3, after: 2 });
    });

    it('đổi scope sang BRANCH khi chỉ còn 2 → 409 (không còn quản trị công ty)', async () => {
      const { service, manager } = setup({ protectedIds: [1, 2] });
      await expect(
        service.assertCanChangeAssignment(manager, 20, 2, {
          roleCode: 'HR_ADMIN',
          scope: 'BRANCH',
          effectiveTo: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('đổi sang role không có ACCESS_ADMIN khi chỉ còn 2 → 409', async () => {
      const { service, manager } = setup({
        protectedIds: [1, 2],
        roleQualifies: false,
      });
      await expect(
        service.assertCanChangeAssignment(manager, 20, 2, {
          roleCode: 'AUDITOR',
          scope: 'COMPANY',
          effectiveTo: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('đổi COMPANY → ALL (vẫn protected) khi chỉ còn 2 → cho phép', async () => {
      const { service, manager } = setup({ protectedIds: [1, 2] });
      await expect(
        service.assertCanChangeAssignment(manager, 20, 2, {
          roleCode: 'HR_ADMIN',
          scope: 'ALL',
          effectiveTo: null,
        }),
      ).resolves.toEqual({ before: 2, after: 2 });
    });
  });

  describe('guardAccountRemoval', () => {
    const actor = { accountId: 158, name: 'HR', roles: ['nhansu'] };

    it('2 protected → khoá 1 trong số đó → 409, KHÔNG ghi', async () => {
      const { service } = setup({ protectedIds: [1, 2] });
      const write = jest.fn();
      const error = await service
        .guardAccountRemoval(2, 'deactivate', actor, write)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'HR_ADMIN_MINIMUM',
        message: expect.stringContaining('Cannot deactivate this account'),
      });
      expect(write).not.toHaveBeenCalled();
    });

    it('3 protected → khoá 1 → ghi + audit ACCOUNT_DEACTIVATE', async () => {
      const { service, audit, manager } = setup({ protectedIds: [1, 2, 3] });
      const write = jest.fn(() => Promise.resolve('ok'));
      await expect(
        service.guardAccountRemoval(3, 'deactivate', actor, write),
      ).resolves.toBe('ok');
      expect(write).toHaveBeenCalledWith(manager);
      expect(audit.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          action: HrAuditAction.ACCOUNT_DEACTIVATE,
          entity: 'account',
          entityId: 3,
          newValue: expect.objectContaining({
            protectedAdminCount: { before: 3, after: 2 },
          }),
        }),
      );
    });

    it('tài khoản bình thường (không quản trị) → ghi như cũ, không audit HR', async () => {
      const { service, audit } = setup({
        protectedIds: [1, 2],
        activeIds: [1, 2],
      });
      const write = jest.fn(() => Promise.resolve('ok'));
      await expect(
        service.guardAccountRemoval(99, 'deactivate', actor, write),
      ).resolves.toBe('ok');
      expect(write).toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('HRM chưa cài (chưa chạy migration HR) → ghi như cũ, không khoá, không đếm', async () => {
      const { service, calls } = setup({ installed: false });
      const write = jest.fn(() => Promise.resolve('ok'));
      await service.guardAccountRemoval(2, 'deactivate', actor, write);
      expect(write).toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('xoá tài khoản còn lịch sử quyền HR → 409 HR_ACCESS_HISTORY (thay vì 500 do FK)', async () => {
      const { service } = setup({ hasHistory: true });
      const write = jest.fn();
      await expect(
        service.guardAccountRemoval(3, 'delete', actor, write),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'HR_ACCESS_HISTORY' }),
      });
      expect(write).not.toHaveBeenCalled();
    });

    it('thứ tự: khoá quota TRƯỚC khi đếm, ghi SAU khi đếm', async () => {
      const { service, calls } = setup();
      await service.guardAccountRemoval(3, 'deactivate', actor, () => {
        calls.push('write');
        return Promise.resolve();
      });
      expect(calls).toEqual(['lock', 'count', 'count', 'write']);
    });
  });
});
