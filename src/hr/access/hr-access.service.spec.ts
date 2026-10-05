import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { isEffectiveOn } from '../common/effective-date';
import { HrAccountPermissionGrant } from './entities/hr-account-permission-grant.entity';
import { HrRolePermission } from './entities/hr-role-permission.entity';
import {
  HrAccessRepository,
  HrAccountSnapshot,
  HrRoleAssignmentGrantRow,
} from './hr-access.repository';
import { HrAccessService } from './hr-access.service';
import { HrPermission, HrScope } from './hr-permission';
import { HrScopeResolver } from './hr-scope-resolver';

const TODAY = '2026-09-25';
const { EMPLOYEE_VIEW, SALARY_VIEW, IDENTITY_REVEAL } = HrPermission;

/** Repo giả chạy đúng luật lọc của repo thật (role IN, hiệu lực theo ngày). */
function fakeRepo(data: {
  accounts: HrAccountSnapshot[];
  roles?: Partial<HrRolePermission>[];
  grants?: Partial<HrAccountPermissionGrant>[];
  assignments?: (HrRoleAssignmentGrantRow & { accountId: number })[];
}) {
  const repo = {
    findActiveRoleAssignmentGrants: jest.fn(
      (accountId: number, _on: string, permission?: string) =>
        Promise.resolve(
          (data.assignments ?? []).filter(
            (a) =>
              a.accountId === accountId &&
              (!permission || a.permissionCode === permission),
          ),
        ),
    ),
    findAccount: jest.fn((id: number) =>
      Promise.resolve(data.accounts.find((a) => a.id === id) ?? null),
    ),
    findRolePermissions: jest.fn((roles: string[], permission?: string) =>
      Promise.resolve(
        (data.roles ?? []).filter(
          (r) =>
            roles.includes(r.role!) &&
            (!permission || r.permissionCode === permission),
        ),
      ),
    ),
    findActiveAccountGrants: jest.fn(
      (accountId: number, on: string, permission?: string) =>
        Promise.resolve(
          (data.grants ?? []).filter(
            (g) =>
              g.accountId === accountId &&
              (!permission || g.permissionCode === permission) &&
              isEffectiveOn(g.effectiveFrom!, g.effectiveTo ?? null, on),
          ),
        ),
    ),
  };
  return repo as unknown as HrAccessRepository & typeof repo;
}

function resolver(overrides: Partial<HrScopeResolver> = {}): HrScopeResolver {
  return {
    isInTeam: jest.fn(() => Promise.resolve(false)),
    isInOrgUnit: jest.fn(() => Promise.resolve(false)),
    isInBranch: jest.fn(() => Promise.resolve(false)),
    ...overrides,
  };
}

const HR_STAFF: HrAccountSnapshot = {
  id: 1,
  roles: ['nhansu'],
  isActive: true,
};
const MANAGER: HrAccountSnapshot = { id: 2, roles: ['sales'], isActive: true };
const TEACHER: HrAccountSnapshot = {
  id: 3,
  roles: ['giaovien_ctv'],
  isActive: true,
};
const LOCKED_HR: HrAccountSnapshot = {
  id: 4,
  roles: ['nhansu'],
  isActive: false,
};
const DEV: HrAccountSnapshot = {
  id: 5,
  roles: ['dev', 'nhansu'],
  isActive: true,
};

const ROLE_SEED: Partial<HrRolePermission>[] = [
  {
    role: 'nhansu',
    permissionCode: EMPLOYEE_VIEW,
    scope: HrScope.COMPANY,
    scopeRefId: null,
  },
  {
    role: 'sales',
    permissionCode: EMPLOYEE_VIEW,
    scope: HrScope.TEAM,
    scopeRefId: null,
  },
  {
    role: 'giaovien_ctv',
    permissionCode: EMPLOYEE_VIEW,
    scope: HrScope.SELF,
    scopeRefId: null,
  },
];

function build(
  extra: {
    grants?: Partial<HrAccountPermissionGrant>[];
    roles?: Partial<HrRolePermission>[];
    assignments?: (HrRoleAssignmentGrantRow & { accountId: number })[];
    scopes?: HrScopeResolver;
  } = {},
) {
  const repo = fakeRepo({
    accounts: [HR_STAFF, MANAGER, TEACHER, LOCKED_HR, DEV],
    roles: extra.roles ?? ROLE_SEED,
    grants: extra.grants,
    assignments: extra.assignments,
  });
  const scopes = extra.scopes ?? resolver();
  return { service: new HrAccessService(repo, scopes), repo, scopes };
}

describe('HrAccessService', () => {
  describe('HR role đã gán (assignment)', () => {
    const assignment = {
      accountId: TEACHER.id,
      assignmentId: 12,
      roleCode: 'PAYROLL_VIEWER',
      scope: HrScope.COMPANY,
      scopeRefId: null,
      permissionCode: SALARY_VIEW,
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-12-31',
    };

    it('quyền từ HR role được gán cộng vào quyền hiệu lực, có nguồn gốc + thời hạn', async () => {
      const { service } = build({ assignments: [assignment] });
      await expect(
        service.getGrants(TEACHER.id, SALARY_VIEW, TODAY),
      ).resolves.toEqual([
        {
          permission: SALARY_VIEW,
          scope: HrScope.COMPANY,
          scopeRefId: null,
          source: 'assignment',
          via: 'assignment#12:PAYROLL_VIEWER',
          effectiveFrom: '2026-09-01',
          effectiveTo: '2026-12-31',
        },
      ]);
    });

    it('quyền lẻ mang theo thời hạn của chính nó', async () => {
      const { service } = build({
        grants: [
          {
            id: 7,
            accountId: TEACHER.id,
            permissionCode: SALARY_VIEW,
            scope: HrScope.BRANCH,
            scopeRefId: 3,
            effectiveFrom: '2026-09-01',
            effectiveTo: '2026-10-31',
          },
        ],
      });
      const [g] = await service.getGrants(TEACHER.id, SALARY_VIEW, TODAY);
      expect(g).toMatchObject({
        source: 'account',
        effectiveFrom: '2026-09-01',
        effectiveTo: '2026-10-31',
      });
    });

    it('tài khoản bị khoá → assignment cũng không có tác dụng', async () => {
      const { service } = build({
        assignments: [{ ...assignment, accountId: LOCKED_HR.id }],
      });
      await expect(
        service.hasPermission(LOCKED_HR.id, SALARY_VIEW, TODAY),
      ).resolves.toBe(false);
    });

    it('mỗi lần kiểm tra đều đọc lại DB (không cache) → thu hồi có hiệu lực ngay', async () => {
      const data = { assignments: [assignment] };
      const { service, repo } = build(data);
      await expect(
        service.hasPermission(TEACHER.id, SALARY_VIEW, TODAY),
      ).resolves.toBe(true);
      repo.findActiveRoleAssignmentGrants.mockResolvedValueOnce([]);
      await expect(
        service.hasPermission(TEACHER.id, SALARY_VIEW, TODAY),
      ).resolves.toBe(false);
      expect(repo.findActiveRoleAssignmentGrants).toHaveBeenCalledTimes(2);
    });
  });

  describe('happy path', () => {
    it('Nhân sự có EMPLOYEE_VIEW + COMPANY xem được bất kỳ ai', async () => {
      const { service } = build();
      await expect(
        service.assertCanAccess(
          HR_STAFF.id,
          EMPLOYEE_VIEW,
          { accountId: 999 },
          { on: TODAY },
        ),
      ).resolves.toBeUndefined();
    });

    it('SELF: giáo viên xem được hồ sơ của chính mình', async () => {
      const { service } = build();
      await expect(
        service.canAccess(
          TEACHER.id,
          EMPLOYEE_VIEW,
          { accountId: TEACHER.id },
          TODAY,
        ),
      ).resolves.toBe(true);
    });

    it('trả nguồn gốc quyền để giải thích được; role cũ là vô thời hạn (null/null, không expiry giả)', async () => {
      const { service } = build();
      await expect(
        service.getGrants(HR_STAFF.id, EMPLOYEE_VIEW, TODAY),
      ).resolves.toEqual([
        {
          permission: EMPLOYEE_VIEW,
          scope: HrScope.COMPANY,
          scopeRefId: null,
          source: 'role',
          via: 'nhansu',
          effectiveFrom: null,
          effectiveTo: null,
        },
      ]);
    });
  });

  describe('validation', () => {
    it('mã quyền không có trong danh mục → lỗi lập trình, không âm thầm trả rỗng', async () => {
      const { service } = build();
      await expect(
        service.getGrants(HR_STAFF.id, 'SUPER_ADMIN' as HrPermission, TODAY),
      ).rejects.toThrow('Mã quyền HR không hợp lệ');
    });

    it('bỏ qua dòng quyền có scope lạ trong DB thay vì coi như được phép', async () => {
      const { service } = build({
        roles: [
          {
            role: 'nhansu',
            permissionCode: EMPLOYEE_VIEW,
            scope: 'GOD' as HrScope,
            scopeRefId: null,
          },
        ],
      });
      await expect(
        service.canAccess(HR_STAFF.id, EMPLOYEE_VIEW, { accountId: 9 }, TODAY),
      ).resolves.toBe(false);
    });
  });

  describe('permission', () => {
    it('Nhân sự KHÔNG mặc nhiên có SALARY_VIEW / IDENTITY_REVEAL', async () => {
      const { service } = build();
      await expect(
        service.hasPermission(HR_STAFF.id, SALARY_VIEW, TODAY),
      ).resolves.toBe(false);
      await expect(
        service.hasPermission(HR_STAFF.id, IDENTITY_REVEAL, TODAY),
      ).resolves.toBe(false);
    });

    it('tài khoản đã khoá mất toàn bộ quyền, kể cả JWT còn hạn', async () => {
      const { service } = build();
      await expect(
        service.getGrants(LOCKED_HR.id, undefined, TODAY),
      ).resolves.toEqual([]);
    });

    it('tài khoản không tồn tại → không có quyền', async () => {
      const { service } = build();
      await expect(
        service.hasPermission(12345, EMPLOYEE_VIEW, TODAY),
      ).resolves.toBe(false);
    });

    it('tài khoản dev nhận quyền theo role như mọi tài khoản (quyết định 25/09/2026)', async () => {
      const { service } = build();
      await expect(
        service.hasPermission(DEV.id, EMPLOYEE_VIEW, TODAY),
      ).resolves.toBe(true);
    });
  });

  describe('out-of-scope / IDOR', () => {
    it('SELF: đổi id trên URL sang người khác → 404 như không tồn tại', async () => {
      const { service } = build();
      await expect(
        service.assertCanAccess(
          TEACHER.id,
          EMPLOYEE_VIEW,
          { accountId: HR_STAFF.id },
          { on: TODAY },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('onDeny: forbidden → 403', async () => {
      const { service } = build();
      await expect(
        service.assertCanAccess(
          TEACHER.id,
          EMPLOYEE_VIEW,
          { accountId: HR_STAFF.id },
          { on: TODAY, onDeny: 'forbidden' },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('SELF không khớp hồ sơ chưa có tài khoản (accountId null)', async () => {
      const { service } = build();
      await expect(
        service.canAccess(
          TEACHER.id,
          EMPLOYEE_VIEW,
          { accountId: null, employeeId: 50 },
          TODAY,
        ),
      ).resolves.toBe(false);
    });

    it('TEAM khi chưa có dữ liệu tổ chức → fail-closed, quản lý không xem được ai', async () => {
      const { service } = build();
      await expect(
        service.canAccess(
          MANAGER.id,
          EMPLOYEE_VIEW,
          { accountId: TEACHER.id },
          TODAY,
        ),
      ).resolves.toBe(false);
    });

    it('TEAM giao cho resolver với đúng người xem, đối tượng và ngày', async () => {
      const scopes = resolver({
        isInTeam: jest.fn(() => Promise.resolve(true)),
      });
      const { service } = build({ scopes });
      await expect(
        service.canAccess(
          MANAGER.id,
          EMPLOYEE_VIEW,
          { accountId: TEACHER.id },
          TODAY,
        ),
      ).resolves.toBe(true);
      expect(scopes.isInTeam).toHaveBeenCalledWith(
        MANAGER.id,
        { accountId: TEACHER.id },
        TODAY,
      );
    });

    it('ORG_UNIT / BRANCH truyền scopeRefId của grant cho resolver', async () => {
      const scopes = resolver({
        isInOrgUnit: jest.fn(() => Promise.resolve(false)),
        isInBranch: jest.fn(() => Promise.resolve(true)),
      });
      const { service } = build({
        scopes,
        roles: [
          {
            role: 'sales',
            permissionCode: EMPLOYEE_VIEW,
            scope: HrScope.ORG_UNIT,
            scopeRefId: 10,
          },
        ],
        grants: [
          {
            id: 1,
            accountId: MANAGER.id,
            permissionCode: EMPLOYEE_VIEW,
            scope: HrScope.BRANCH,
            scopeRefId: 3,
            effectiveFrom: '2026-01-01',
            effectiveTo: null,
          },
        ],
      });
      await expect(
        service.canAccess(MANAGER.id, EMPLOYEE_VIEW, { employeeId: 77 }, TODAY),
      ).resolves.toBe(true);
      expect(scopes.isInOrgUnit).toHaveBeenCalledWith(
        MANAGER.id,
        10,
        { employeeId: 77 },
        TODAY,
      );
      expect(scopes.isInBranch).toHaveBeenCalledWith(
        MANAGER.id,
        3,
        { employeeId: 77 },
        TODAY,
      );
    });

    it('quyền của permission khác không được dùng thay (EMPLOYEE_VIEW ≠ SALARY_VIEW)', async () => {
      const { service } = build();
      await expect(
        service.canAccess(HR_STAFF.id, SALARY_VIEW, { accountId: 999 }, TODAY),
      ).resolves.toBe(false);
    });
  });

  describe('historical / effective date', () => {
    const grant = (effectiveFrom: string, effectiveTo: string | null) => ({
      id: 1,
      accountId: MANAGER.id,
      permissionCode: SALARY_VIEW,
      scope: HrScope.COMPANY,
      scopeRefId: null,
      effectiveFrom,
      effectiveTo,
    });

    it.each([
      ['đang hiệu lực', '2026-01-01', null, true],
      ['ngày bắt đầu (inclusive)', TODAY, null, true],
      ['ngày kết thúc (inclusive)', '2026-01-01', TODAY, true],
      ['đã hết hạn hôm qua', '2026-01-01', '2026-09-24', false],
      ['chưa tới ngày hiệu lực', '2026-09-26', null, false],
    ])('%s', async (_label, from, to, expected) => {
      const { service } = build({ grants: [grant(from, to)] });
      await expect(
        service.hasPermission(MANAGER.id, SALARY_VIEW, TODAY),
      ).resolves.toBe(expected);
    });

    it('xét quyền tại một ngày trong quá khứ', async () => {
      const { service } = build({
        grants: [grant('2026-01-01', '2026-06-30')],
      });
      await expect(
        service.hasPermission(MANAGER.id, SALARY_VIEW, '2026-03-15'),
      ).resolves.toBe(true);
      await expect(
        service.hasPermission(MANAGER.id, SALARY_VIEW, TODAY),
      ).resolves.toBe(false);
    });
  });
});
