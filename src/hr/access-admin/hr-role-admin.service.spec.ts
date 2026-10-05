import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { HrAccountRoleAssignment } from '../access/entities/hr-account-role-assignment.entity';
import { HrAccessRepository } from '../access/hr-access.repository';
import { HrAccessService, HrGrant } from '../access/hr-access.service';
import { HrPermission, HrScope } from '../access/hr-permission';
import { hrToday } from '../common/effective-date';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditService } from '../audit/hr-audit.service';
import { AssignHrRoleDto } from './dto/assign-hr-role.dto';
import { MIN_PROTECTED_HR_ADMINS } from '../access-safety/hr-admin-quota';
import {
  HrAccessSafetyService,
  QuotaSimulation,
} from '../access-safety/hr-access-safety.service';
import {
  addDays,
  MAX_SENSITIVE_ACCESS_DAYS,
  SENSITIVE_ACCESS_DURATION_MESSAGE,
  SENSITIVE_ACCESS_REQUIRES_END_MESSAGE,
} from './hr-grant-policy';
import { HrRoleAdminRepository } from './hr-role-admin.repository';
import { HrRoleAdminService } from './hr-role-admin.service';
import { OrgScopeUnitValidator } from '../organization/org-scope-unit.validator';

const ADMIN = 158;
const TARGET = 151;
const TODAY = hrToday();
const actor = {
  accountId: ADMIN,
  name: 'HR',
  roles: ['nhansu'],
  ip: '1.1.1.1',
};

const grant = (
  permission: HrPermission,
  scope: HrScope,
  scopeRefId: number | null = null,
): HrGrant => ({
  permission,
  scope,
  scopeRefId,
  source: 'assignment',
  via: `assignment#1:${permission}`,
  effectiveFrom: null,
  effectiveTo: null,
});

/** Người thao tác giữ MỌI quyền ở một phạm vi (mặc định COMPANY). */
const allGrants = (
  scope: HrScope = HrScope.COMPANY,
  ref: number | null = null,
) => Object.values(HrPermission).map((p) => grant(p, scope, ref));

/** Quyền của từng HR role trong kịch bản test (khớp seed + role giả ROLE_A). */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  HR_ADMIN: ['ACCESS_ADMIN', 'ACCESS_VIEW', 'AUDIT_VIEW'],
  LINE_MANAGER: ['EMPLOYEE_VIEW'],
  PAYROLL_VIEWER: ['SALARY_VIEW'],
  HR_SENSITIVE_VIEWER: ['IDENTITY_REVEAL', 'BANK_REVEAL'],
  AUDITOR: ['AUDIT_VIEW', 'ACCESS_VIEW'],
  ROLE_A: ['EMPLOYEE_VIEW', 'SALARY_VIEW'],
};

const assignment = (
  over: Partial<HrAccountRoleAssignment> = {},
): HrAccountRoleAssignment => ({
  id: 50,
  accountId: TARGET,
  roleCode: 'PAYROLL_VIEWER',
  scope: HrScope.COMPANY,
  scopeRefId: null,
  effectiveFrom: TODAY,
  effectiveTo: null,
  reason: 'cấp để thử',
  grantedBy: ADMIN,
  grantedAt: new Date(),
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  version: 1,
  ...over,
});

function setup(
  opts: {
    /** Quyền hiệu lực thực tế của người thao tác (mặc định: mọi quyền, COMPANY). */
    actorGrants?: HrGrant[];
    targetInScope?: boolean;
    /** Protected admin trước / sau (khi loại assignment đang thu hồi). */
    admins?: { before: number[]; after: number[] };
    /** scopeRefId mà Organization coi là KHÔNG hợp lệ (mặc định: mọi đơn vị hợp lệ). */
    invalidUnits?: number[];
  } = {},
) {
  const admins = opts.admins ?? { before: [1, 2, 3], after: [1, 2, 3] };
  const calls: string[] = [];
  const txManager = { queryRunner: { isTransactionActive: true } };
  const dataSource = {
    manager: {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(txManager)),
    },
  } as unknown as DataSource;

  const repo = {
    listRoles: jest.fn(),
    findRole: jest.fn((code: string) =>
      Promise.resolve(
        code in ROLE_PERMISSIONS
          ? { code, isActive: true }
          : code === 'OLD_ROLE'
            ? { code, isActive: false }
            : null,
      ),
    ),
    listRolePermissionCodes: jest.fn((code: string) =>
      Promise.resolve(ROLE_PERMISSIONS[code] ?? []),
    ),
    listAssignments: jest.fn(() => Promise.resolve([])),
    findAssignment: jest.fn((id: number) =>
      Promise.resolve(id === 50 ? assignment() : null),
    ),
    findUnrevokedDuplicate: jest.fn(() => Promise.resolve(null)),
    insertAssignment: jest.fn((_m: unknown, row: object) =>
      Promise.resolve(assignment({ ...row, id: 77 })),
    ),
    findAssignmentForUpdate: jest.fn((_m: unknown, id: number) => {
      calls.push('select-for-update');
      return Promise.resolve(id === 50 ? assignment() : null);
    }),
    revokeAssignment: jest.fn(() => {
      calls.push('update');
      return Promise.resolve(1);
    }),
  };
  const accounts = {
    findAccount: jest.fn((id: number) =>
      Promise.resolve(
        id === 999 ? null : { id, roles: [], isActive: id !== 404 },
      ),
    ),
  };
  const access = {
    assertCanAccess: jest.fn(() =>
      opts.targetInScope === false
        ? Promise.reject(new NotFoundException('Không tìm thấy dữ liệu'))
        : Promise.resolve(),
    ),
    getGrants: jest.fn((_id: number, permission?: HrPermission) =>
      Promise.resolve(
        (opts.actorGrants ?? allGrants()).filter(
          (g) => !permission || g.permission === permission,
        ),
      ),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve('1')) };

  // Service trung tâm THẬT (luật quota thật); chỉ thay phần đụng DB.
  const safety = new HrAccessSafetyService(
    dataSource,
    audit as unknown as HrAuditService,
  );
  jest.spyOn(safety, 'lock').mockImplementation(() => {
    calls.push('lock');
    return Promise.resolve();
  });
  jest
    .spyOn(safety, 'protectedAdminIds')
    .mockImplementation((_m, _on, sim: QuotaSimulation = {}) => {
      const simulated =
        !!sim.excludeAssignmentIds?.length || !!sim.excludeAccountIds?.length;
      calls.push(simulated ? 'count-after' : 'count-before');
      return Promise.resolve(simulated ? admins.after : admins.before);
    });

  const scopeUnits = {
    isValid: jest.fn((_scope: string, id: number) =>
      Promise.resolve(!(opts.invalidUnits ?? []).includes(id)),
    ),
  };

  const service = new HrRoleAdminService(
    dataSource,
    repo as unknown as HrRoleAdminRepository,
    accounts as unknown as HrAccessRepository,
    access as unknown as HrAccessService,
    audit as unknown as HrAuditService,
    safety,
    scopeUnits as unknown as OrgScopeUnitValidator,
  );
  return {
    service,
    repo,
    scopeUnits,
    access,
    audit,
    txManager,
    dataSource,
    safety,
    calls,
  };
}

/** Mặc định role KHÔNG nhạy cảm để các test luồng chung không vướng M2. */
const dto = (over: Partial<AssignHrRoleDto> = {}): AssignHrRoleDto => ({
  roleCode: 'LINE_MANAGER',
  scope: HrScope.COMPANY,
  reason: 'bổ nhiệm quản lý trực tiếp',
  ...over,
});

describe('HrRoleAdminService — cấp quyền', () => {
  it('happy path: tạo assignment + audit ACCESS_GRANT trong cùng transaction', async () => {
    const { service, repo, audit, txManager } = setup();
    const created = await service.assign(ADMIN, actor, TARGET, dto());

    expect(created.id).toBe(77);
    expect(repo.insertAssignment).toHaveBeenCalledWith(txManager, {
      accountId: TARGET,
      roleCode: 'LINE_MANAGER',
      scope: HrScope.COMPANY,
      scopeRefId: null,
      effectiveFrom: TODAY,
      effectiveTo: null,
      reason: 'bổ nhiệm quản lý trực tiếp',
      grantedBy: ADMIN,
    });
    expect(audit.record).toHaveBeenCalledWith(
      txManager,
      expect.objectContaining({
        action: HrAuditAction.ACCESS_GRANT,
        entity: 'account_role_assignment',
        entityId: 77,
        reason: 'bổ nhiệm quản lý trực tiếp',
        oldValue: null,
      }),
    );
  });

  it('gán role kèm scope ORG_UNIT/BRANCH có đơn vị', async () => {
    const { service, repo } = setup();
    await service.assign(
      ADMIN,
      actor,
      TARGET,
      dto({ scope: HrScope.BRANCH, scopeRefId: 3 }),
    );
    expect(repo.insertAssignment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: HrScope.BRANCH, scopeRefId: 3 }),
    );
  });

  describe('bảo mật', () => {
    it('không tự cấp cho chính mình — kể cả khi là quản trị COMPANY', async () => {
      const { service, repo } = setup();
      await expect(
        service.assign(ADMIN, actor, ADMIN, dto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.insertAssignment).not.toHaveBeenCalled();
    });

    it('accountId ngoài phạm vi ACCESS_ADMIN → 404, không ghi gì', async () => {
      const { service, repo, audit } = setup({ targetInScope: false });
      await expect(
        service.assign(ADMIN, actor, TARGET, dto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.insertAssignment).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('phạm vi tài khoản đích được kiểm bằng ACCESS_ADMIN của người thao tác', async () => {
      const { service, access } = setup();
      await service.assign(ADMIN, actor, TARGET, dto());
      expect(access.assertCanAccess).toHaveBeenCalledWith(
        ADMIN,
        HrPermission.ACCESS_ADMIN,
        {
          accountId: TARGET,
        },
      );
    });

    it('quản trị COMPANY không cấp được scope ALL', async () => {
      const { service } = setup();
      await expect(
        service.assign(ADMIN, actor, TARGET, dto({ scope: HrScope.ALL })),
      ).rejects.toThrow('rộng hơn phạm vi quản trị');
    });

    it('quản trị BRANCH 3 không cấp được COMPANY hay BRANCH 4', async () => {
      const { service } = setup({
        actorGrants: allGrants(HrScope.BRANCH, 3),
      });
      await expect(
        service.assign(ADMIN, actor, TARGET, dto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.assign(
          ADMIN,
          actor,
          TARGET,
          dto({ scope: HrScope.BRANCH, scopeRefId: 4 }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('quản trị ALL cấp được ALL', async () => {
      const { service, repo } = setup({
        actorGrants: allGrants(HrScope.ALL),
      });
      await service.assign(ADMIN, actor, TARGET, dto({ scope: HrScope.ALL }));
      expect(repo.insertAssignment).toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it.each([
      [
        'ORG_UNIT thiếu scopeRefId',
        dto({ scope: HrScope.ORG_UNIT }),
        'bắt buộc có scopeRefId',
      ],
      [
        'COMPANY kèm scopeRefId',
        dto({ scopeRefId: 5 }),
        'không dùng scopeRefId',
      ],
      ['hiệu lực từ quá khứ', dto({ effectiveFrom: '2020-01-01' }), 'quá khứ'],
      [
        'effectiveTo trước effectiveFrom',
        dto({ effectiveFrom: '2099-02-01', effectiveTo: '2099-01-01' }),
        'effectiveTo',
      ],
      ['role không tồn tại', dto({ roleCode: 'SUPER_ADMIN' }), 'không tồn tại'],
      ['role đã tắt', dto({ roleCode: 'OLD_ROLE' }), 'đã tắt'],
    ])('%s → 400', async (_label, input, message) => {
      const { service, repo } = setup();
      const call = service.assign(ADMIN, actor, TARGET, input);
      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.assign(ADMIN, actor, TARGET, input)).rejects.toThrow(
        message,
      );
      expect(repo.insertAssignment).not.toHaveBeenCalled();
    });

    describe('đơn vị của scope (HR_SCOPE_UNIT_INVALID)', () => {
      const unitDto = (scope: HrScope, scopeRefId: number, over = {}) =>
        dto({ scope, scopeRefId, effectiveFrom: '2099-03-01', ...over });

      it('đơn vị không hợp lệ → 400 HR_SCOPE_UNIT_INVALID, một thông báo chung, không ghi', async () => {
        const { service, repo, scopeUnits } = setup({ invalidUnits: [987] });
        const err = await service
          .assign(ADMIN, actor, TARGET, unitDto(HrScope.BRANCH, 987))
          .catch((e: BadRequestException) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toEqual({
          statusCode: 400,
          code: 'HR_SCOPE_UNIT_INVALID',
          message:
            'Đơn vị của phạm vi quyền không hợp lệ tại ngày hiệu lực — chọn lại đơn vị.',
        });
        // Kiểm tra tại effectiveFrom của assignment, đúng loại scope.
        expect(scopeUnits.isValid).toHaveBeenCalledWith(
          HrScope.BRANCH,
          987,
          '2099-03-01',
        );
        expect(repo.insertAssignment).not.toHaveBeenCalled();
      });

      it('thứ tự: ngày → hình dạng scope → đơn vị → tài khoản đích → M1', async () => {
        const { service, access, scopeUnits } = setup({ invalidUnits: [987] });
        // Ngày sai báo trước, chưa đụng Organization.
        await expect(
          service.assign(
            ADMIN,
            actor,
            TARGET,
            unitDto(HrScope.BRANCH, 987, { effectiveFrom: '2020-01-01' }),
          ),
        ).rejects.toThrow('quá khứ');
        // Hình dạng scope sai (COMPANY kèm scopeRefId) báo trước, chưa đụng Organization.
        await expect(
          service.assign(ADMIN, actor, TARGET, unitDto(HrScope.COMPANY, 987)),
        ).rejects.toThrow('không dùng scopeRefId');
        expect(scopeUnits.isValid).not.toHaveBeenCalled();
        // Đơn vị sai báo TRƯỚC kiểm tra phạm vi tài khoản đích.
        await expect(
          service.assign(ADMIN, actor, TARGET, unitDto(HrScope.ORG_UNIT, 987)),
        ).rejects.toThrow('không hợp lệ tại ngày hiệu lực');
        expect(access.assertCanAccess).not.toHaveBeenCalled();
      });

      it('đơn vị hợp lệ → đi tiếp kiểm tra tài khoản đích + M1 như cũ', async () => {
        const { service, access, repo } = setup();
        await service.assign(ADMIN, actor, TARGET, unitDto(HrScope.BRANCH, 3));
        expect(access.assertCanAccess).toHaveBeenCalled();
        expect(repo.insertAssignment).toHaveBeenCalled();
      });

      it('đơn vị hợp lệ nhưng ngoài quyền người cấp → vẫn do M1 chặn (403), không phải HR_SCOPE_UNIT_INVALID', async () => {
        const { service } = setup({
          actorGrants: allGrants(HrScope.BRANCH, 3),
        });
        const err = await service
          .assign(ADMIN, actor, TARGET, unitDto(HrScope.BRANCH, 4))
          .catch((e: ForbiddenException) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
      });

      it('SELF/TEAM/COMPANY/ALL không gọi kiểm tra đơn vị', async () => {
        const { service, scopeUnits } = setup({
          actorGrants: allGrants(HrScope.ALL),
        });
        await service.assign(ADMIN, actor, TARGET, dto({ scope: HrScope.ALL }));
        await service.assign(ADMIN, actor, 8, dto({ scope: HrScope.COMPANY }));
        expect(scopeUnits.isValid).not.toHaveBeenCalled();
      });
    });

    it('tài khoản không tồn tại → 404; bị khoá → 400', async () => {
      const { service } = setup();
      await expect(
        service.assign(ADMIN, actor, 999, dto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.assign(ADMIN, actor, 404, dto())).rejects.toThrow(
        'bị khoá',
      );
    });
  });

  describe('trùng lặp', () => {
    it('đã có assignment chưa thu hồi cùng role + scope → 409 kèm id đang có', async () => {
      const { service, repo, audit } = setup();
      repo.findUnrevokedDuplicate.mockResolvedValueOnce(
        assignment({ id: 12 }) as never,
      );
      const error = await service
        .assign(ADMIN, actor, TARGET, dto())
        .catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        existingAssignmentId: 12,
      });
      expect(repo.insertAssignment).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('hai request cùng lúc: request sau vấp unique index → 409, không phải 500', async () => {
      const { service, repo } = setup();
      const driverError = Object.assign(new Error('duplicate key'), {
        code: '23505',
      });
      repo.insertAssignment.mockRejectedValueOnce(
        new QueryFailedError('INSERT', [], driverError) as never,
      );
      await expect(
        service.assign(ADMIN, actor, TARGET, dto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('audit lỗi → cả thao tác lỗi (không có cấp quyền mà thiếu audit)', async () => {
      const { service, audit } = setup();
      audit.record.mockRejectedValueOnce(new Error('audit down') as never);
      await expect(service.assign(ADMIN, actor, TARGET, dto())).rejects.toThrow(
        'audit down',
      );
    });
  });
});

describe('HrRoleAdminService — thu hồi', () => {
  const revokeDto = { reason: 'chuyển bộ phận', version: 1 };

  it('happy path: thu hồi theo version + audit ACCESS_REVOKE có old/new', async () => {
    const { service, repo, audit, txManager } = setup();
    repo.findAssignment
      .mockResolvedValueOnce(assignment())
      .mockResolvedValueOnce(
        assignment({ revokedAt: new Date(), revokedBy: ADMIN, version: 2 }),
      );

    const revoked = await service.revoke(ADMIN, actor, 50, revokeDto);

    expect(revoked.version).toBe(2);
    expect(repo.revokeAssignment).toHaveBeenCalledWith(
      txManager,
      50,
      1,
      ADMIN,
      'chuyển bộ phận',
    );
    expect(audit.record).toHaveBeenCalledWith(
      txManager,
      expect.objectContaining({
        action: HrAuditAction.ACCESS_REVOKE,
        entityId: 50,
        oldValue: expect.objectContaining({ revokedAt: null, version: 1 }),
        newValue: expect.objectContaining({ version: 2, revokedBy: ADMIN }),
      }),
    );
  });

  it('assignment không tồn tại → 404', async () => {
    const { service } = setup();
    await expect(
      service.revoke(ADMIN, actor, 1, revokeDto),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('assignment của tài khoản ngoài phạm vi → 404 (không lộ là có tồn tại)', async () => {
    const { service, repo } = setup({ targetInScope: false });
    await expect(
      service.revoke(ADMIN, actor, 50, revokeDto),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.revokeAssignment).not.toHaveBeenCalled();
  });

  it('không tự thu hồi quyền của chính mình', async () => {
    const { service, repo } = setup();
    repo.findAssignment.mockResolvedValueOnce(assignment({ accountId: ADMIN }));
    await expect(
      service.revoke(ADMIN, actor, 50, revokeDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('quản trị COMPANY không thu hồi được assignment scope ALL', async () => {
    const { service, repo } = setup();
    repo.findAssignment.mockResolvedValueOnce(
      assignment({ scope: HrScope.ALL }),
    );
    await expect(
      service.revoke(ADMIN, actor, 50, revokeDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('đã thu hồi rồi → 409', async () => {
    const { service, repo } = setup();
    repo.findAssignment.mockResolvedValueOnce(
      assignment({ revokedAt: new Date() }),
    );
    await expect(service.revoke(ADMIN, actor, 50, revokeDto)).rejects.toThrow(
      'đã được thu hồi',
    );
  });

  it('version lệch (người khác vừa sửa) → 409, không ghi đè', async () => {
    const { service, repo } = setup();
    repo.findAssignment.mockResolvedValueOnce(assignment({ version: 3 }));
    await expect(
      service.revoke(ADMIN, actor, 50, revokeDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.revokeAssignment).not.toHaveBeenCalled();
  });

  it('race: UPDATE có điều kiện version không trúng dòng nào → 409, không audit', async () => {
    const { service, repo, audit } = setup();
    repo.revokeAssignment.mockResolvedValueOnce(0);
    await expect(
      service.revoke(ADMIN, actor, 50, revokeDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  describe('số quản trị HR tối thiểu', () => {
    const adminAssignment = () => assignment({ roleCode: 'HR_ADMIN' });

    it('còn 3 → thu hồi còn 2: thành công, audit ghi số quản trị trước/sau', async () => {
      const { service, repo, audit } = setup({
        admins: { before: [1, 2, TARGET], after: [1, 2] },
      });
      repo.findAssignment
        .mockResolvedValueOnce(adminAssignment())
        .mockResolvedValueOnce(
          assignment({
            roleCode: 'HR_ADMIN',
            revokedAt: new Date(),
            version: 2,
          }),
        );
      repo.findAssignmentForUpdate.mockResolvedValueOnce(adminAssignment());

      await service.revoke(ADMIN, actor, 50, revokeDto);

      expect(repo.revokeAssignment).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: HrAuditAction.ACCESS_REVOKE,
          newValue: expect.objectContaining({
            protectedAdminCount: { before: 3, after: 2 },
          }),
        }),
      );
    });

    it('còn 2 → thu hồi còn 1: 409 HR_ADMIN_MINIMUM, không UPDATE, không audit', async () => {
      const { service, repo, audit } = setup({
        admins: { before: [1, TARGET], after: [1] },
      });
      repo.findAssignment.mockResolvedValueOnce(adminAssignment());
      repo.findAssignmentForUpdate.mockResolvedValueOnce(adminAssignment());

      const error = await service
        .revoke(ADMIN, actor, 50, revokeDto)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'HR_ADMIN_MINIMUM',
        protectedAdminCount: 2,
        protectedAdminCountAfter: 1,
        minimum: MIN_PROTECTED_HR_ADMINS,
        message: expect.stringContaining('Cannot revoke this assignment'),
      });
      expect(repo.revokeAssignment).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('thu hồi role KHÔNG phải quản trị khi chỉ có 1 quản trị → vẫn được (số quản trị không đổi)', async () => {
      const { service, repo } = setup({ admins: { before: [1], after: [1] } });
      await service.revoke(ADMIN, actor, 50, revokeDto);
      expect(repo.revokeAssignment).toHaveBeenCalled();
    });

    it('người bị thu hồi còn assignment protected khác → số protected admin không đổi → được phép', async () => {
      const { service, repo } = setup({
        admins: { before: [1, TARGET], after: [1, TARGET] },
      });
      repo.findAssignment.mockResolvedValueOnce(adminAssignment());
      repo.findAssignmentForUpdate.mockResolvedValueOnce(adminAssignment());
      await service.revoke(ADMIN, actor, 50, revokeDto);
      expect(repo.revokeAssignment).toHaveBeenCalled();
    });

    it('thứ tự: khoá → SELECT FOR UPDATE → đếm trước/sau → UPDATE (đếm nằm TRONG khoá)', async () => {
      const { service, calls } = setup();
      await service.revoke(ADMIN, actor, 50, revokeDto);
      expect(calls).toEqual([
        'lock',
        'select-for-update',
        'count-before',
        'count-after',
        'update',
      ]);
    });

    it('dưới khoá mới thấy assignment đã bị request khác thu hồi → 409', async () => {
      const { service, repo } = setup();
      repo.findAssignmentForUpdate.mockResolvedValueOnce(
        assignment({ revokedAt: new Date(), version: 2 }),
      );
      await expect(service.revoke(ADMIN, actor, 50, revokeDto)).rejects.toThrow(
        'đã được thu hồi',
      );
      expect(repo.revokeAssignment).not.toHaveBeenCalled();
    });
  });
});

describe('HrRoleAdminService — xem', () => {
  it('xem assignment của tài khoản: kiểm tra phạm vi ACCESS_VIEW trước', async () => {
    const { service, access } = setup({ targetInScope: false });
    await expect(
      service.accountAssignments(ADMIN, TARGET),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(access.assertCanAccess).toHaveBeenCalledWith(
      ADMIN,
      HrPermission.ACCESS_VIEW,
      {
        accountId: TARGET,
      },
    );
  });

  it('permission của role không tồn tại → 404', async () => {
    const { service } = setup();
    await expect(service.rolePermissions('NOPE')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('M1 — không cấp quyền vượt quyền hiệu lực của chính mình', () => {
  const { ACCESS_ADMIN, EMPLOYEE_VIEW, SALARY_VIEW } = HrPermission;
  const { COMPANY, ORG_UNIT, BRANCH } = HrScope;
  const ADMIN_COMPANY = grant(ACCESS_ADMIN, COMPANY);

  const m1Error = async (p: Promise<unknown>) => {
    const e = await p.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ForbiddenException);
    return (e as ForbiddenException).getResponse() as Record<string, unknown>;
  };

  it('[1] có X → cấp X cùng scope → pass', async () => {
    const { service, repo } = setup({
      actorGrants: [ADMIN_COMPANY, grant(EMPLOYEE_VIEW, COMPANY)],
    });
    await service.assign(
      ADMIN,
      actor,
      TARGET,
      dto({ roleCode: 'LINE_MANAGER' }),
    );
    expect(repo.insertAssignment).toHaveBeenCalled();
  });

  it('[2] không có X → cấp X → 403 kèm danh sách quyền thiếu', async () => {
    const { service, repo } = setup({
      actorGrants: [ADMIN_COMPANY, grant(EMPLOYEE_VIEW, COMPANY)],
    });
    const body = await m1Error(
      service.assign(
        ADMIN,
        actor,
        TARGET,
        dto({ roleCode: 'PAYROLL_VIEWER', effectiveTo: TODAY }),
      ),
    );
    expect(body).toMatchObject({
      code: 'HR_GRANT_EXCEEDS_OWN_ACCESS',
      missingPermissions: ['SALARY_VIEW'],
    });
    expect(repo.insertAssignment).not.toHaveBeenCalled();
  });

  it('[3] có X ở ORG_UNIT A → cấp X ở ORG_UNIT A → pass', async () => {
    const { service, repo } = setup({
      actorGrants: [
        grant(ACCESS_ADMIN, ORG_UNIT, 7),
        grant(EMPLOYEE_VIEW, ORG_UNIT, 7),
      ],
    });
    await service.assign(
      ADMIN,
      actor,
      TARGET,
      dto({ scope: ORG_UNIT, scopeRefId: 7 }),
    );
    expect(repo.insertAssignment).toHaveBeenCalled();
  });

  it('[4] có X ở ORG_UNIT A → cấp X ở COMPANY → 403', async () => {
    const { service, repo } = setup({
      actorGrants: [ADMIN_COMPANY, grant(EMPLOYEE_VIEW, ORG_UNIT, 7)],
    });
    const body = await m1Error(service.assign(ADMIN, actor, TARGET, dto()));
    expect(body.missingPermissions).toEqual(['EMPLOYEE_VIEW']);
    expect(repo.insertAssignment).not.toHaveBeenCalled();
  });

  it('[5] có quyền ở Branch A → cấp ở Branch B → 403', async () => {
    const { service } = setup({
      actorGrants: [
        grant(ACCESS_ADMIN, BRANCH, 1),
        grant(EMPLOYEE_VIEW, BRANCH, 1),
      ],
    });
    await expect(
      service.assign(
        ADMIN,
        actor,
        TARGET,
        dto({ scope: BRANCH, scopeRefId: 2 }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[6] cấp HR_ADMIN khi thiếu một phần quyền của nó → 403', async () => {
    const { service } = setup({
      actorGrants: [ADMIN_COMPANY, grant(HrPermission.ACCESS_VIEW, COMPANY)],
    });
    const body = await m1Error(
      service.assign(ADMIN, actor, TARGET, dto({ roleCode: 'HR_ADMIN' })),
    );
    expect(body.missingPermissions).toEqual(['AUDIT_VIEW']);
  });

  it('[6] cố cấp ACCESS_ADMIN ở COMPANY khi bản thân chỉ có ACCESS_ADMIN ORG_UNIT → 403', async () => {
    const { service } = setup({
      actorGrants: [
        grant(ACCESS_ADMIN, ORG_UNIT, 7),
        grant(HrPermission.ACCESS_VIEW, COMPANY),
        grant(HrPermission.AUDIT_VIEW, COMPANY),
      ],
    });
    await expect(
      service.assign(ADMIN, actor, TARGET, dto({ roleCode: 'HR_ADMIN' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[7] nhiều nguồn: EMPLOYEE_VIEW COMPANY (role cũ) + SALARY_VIEW BRANCH 3 (assignment) → Role A ở BRANCH 3 được; COMPANY / BRANCH 4 không', async () => {
    const actorGrants: HrGrant[] = [
      ADMIN_COMPANY,
      { ...grant(EMPLOYEE_VIEW, COMPANY), source: 'role', via: 'nhansu' },
      grant(SALARY_VIEW, BRANCH, 3),
    ];
    const ok = setup({ actorGrants });
    await ok.service.assign(
      ADMIN,
      actor,
      TARGET,
      dto({
        roleCode: 'ROLE_A',
        scope: BRANCH,
        scopeRefId: 3,
        effectiveTo: TODAY,
      }),
    );
    expect(ok.repo.insertAssignment).toHaveBeenCalled();

    const denied = setup({ actorGrants });
    const body = await m1Error(
      denied.service.assign(
        ADMIN,
        actor,
        TARGET,
        dto({ roleCode: 'ROLE_A', effectiveTo: TODAY }),
      ),
    );
    expect(body.missingPermissions).toEqual(['SALARY_VIEW']);
    await expect(
      denied.service.assign(
        ADMIN,
        actor,
        TARGET,
        dto({
          roleCode: 'ROLE_A',
          scope: BRANCH,
          scopeRefId: 4,
          effectiveTo: TODAY,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[7] cùng một quyền ở hai đơn vị → cấp được ở cả hai', async () => {
    const { service, repo } = setup({
      actorGrants: [
        ADMIN_COMPANY,
        grant(EMPLOYEE_VIEW, BRANCH, 3),
        grant(EMPLOYEE_VIEW, BRANCH, 4),
      ],
    });
    await service.assign(
      ADMIN,
      actor,
      TARGET,
      dto({ scope: BRANCH, scopeRefId: 4 }),
    );
    expect(repo.insertAssignment).toHaveBeenCalled();
  });

  it('[8] ĐẶC BIỆT: Role A = EMPLOYEE_VIEW + SALARY_VIEW, người cấp chỉ có EMPLOYEE_VIEW → 403', async () => {
    const { service, repo, audit } = setup({
      actorGrants: [ADMIN_COMPANY, grant(EMPLOYEE_VIEW, COMPANY)],
    });
    const body = await m1Error(
      service.assign(
        ADMIN,
        actor,
        TARGET,
        dto({ roleCode: 'ROLE_A', effectiveTo: TODAY }),
      ),
    );
    expect(body.missingPermissions).toEqual(['SALARY_VIEW']);
    expect(repo.insertAssignment).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('[8] scope tương đối: có quyền TEAM/SELF không cấp được TEAM/SELF cho người khác', async () => {
    const { service } = setup({
      actorGrants: [
        ADMIN_COMPANY,
        grant(EMPLOYEE_VIEW, HrScope.TEAM),
        grant(EMPLOYEE_VIEW, HrScope.SELF),
      ],
    });
    await expect(
      service.assign(ADMIN, actor, TARGET, dto({ scope: HrScope.TEAM })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.assign(ADMIN, actor, TARGET, dto({ scope: HrScope.SELF })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[8] đọc quyền hiệu lực THỰC TẾ lúc cấp (mọi nguồn, không lọc theo tên role)', async () => {
    const { service, access } = setup();
    await service.assign(ADMIN, actor, TARGET, dto());
    expect(access.getGrants).toHaveBeenCalledWith(ADMIN);
  });

  it('[9] audit ghi đúng người cấp, tài khoản đích, role, scope, quyền được cấp', async () => {
    const { service, audit, txManager } = setup();
    await service.assign(
      ADMIN,
      actor,
      TARGET,
      dto({
        roleCode: 'ROLE_A',
        scope: BRANCH,
        scopeRefId: 3,
        effectiveTo: TODAY,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(txManager, {
      actor,
      action: HrAuditAction.ACCESS_GRANT,
      entity: 'account_role_assignment',
      entityId: 77,
      oldValue: null,
      newValue: expect.objectContaining({
        accountId: TARGET,
        roleCode: 'ROLE_A',
        scope: BRANCH,
        scopeRefId: 3,
        grantedPermissions: ['EMPLOYEE_VIEW', 'SALARY_VIEW'],
        sensitiveAccess: true,
      }),
      reason: 'bổ nhiệm quản lý trực tiếp',
    });
  });
});

describe('M2 — quyền xem dữ liệu nhạy cảm có thời hạn tối đa', () => {
  const MAX = MAX_SENSITIVE_ACCESS_DAYS;
  const sensitive = (over: Partial<AssignHrRoleDto>) =>
    dto({ roleCode: 'PAYROLL_VIEWER', ...over });

  const m2Error = async (p: Promise<unknown>) => {
    const e = await p.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  };

  it('[1] 30 ngày → pass', async () => {
    const { service, repo } = setup();
    await service.assign(
      ADMIN,
      actor,
      TARGET,
      sensitive({ effectiveTo: addDays(TODAY, 30) }),
    );
    expect(repo.insertAssignment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ effectiveTo: addDays(TODAY, 30) }),
    );
  });

  it('[2] offset MAX−1 = đúng MAX ngày có quyền (tính cả hai đầu) → pass', async () => {
    const { service, repo } = setup();
    await service.assign(
      ADMIN,
      actor,
      TARGET,
      sensitive({ effectiveTo: addDays(TODAY, MAX - 1) }),
    );
    expect(repo.insertAssignment).toHaveBeenCalled();
  });

  it('[3] offset MAX = MAX+1 ngày có quyền → 400 rõ ràng, không tự sửa dữ liệu', async () => {
    const { service, repo } = setup();
    const body = await m2Error(
      service.assign(
        ADMIN,
        actor,
        TARGET,
        sensitive({ effectiveTo: addDays(TODAY, MAX) }),
      ),
    );
    expect(body).toMatchObject({
      code: 'HR_SENSITIVE_ACCESS_DURATION',
      message: SENSITIVE_ACCESS_DURATION_MESSAGE,
      maxDays: MAX,
      latestEffectiveTo: addDays(TODAY, MAX - 1),
    });
    expect(repo.insertAssignment).not.toHaveBeenCalled();
  });

  it('[4] không truyền effectiveTo → 400', async () => {
    const { service } = setup();
    const body = await m2Error(
      service.assign(ADMIN, actor, TARGET, sensitive({})),
    );
    expect(body.message).toBe(SENSITIVE_ACCESS_REQUIRES_END_MESSAGE);
  });

  it('[4] mốc tính từ effectiveFrom (ở tương lai), không phải từ hôm nay', async () => {
    const from = addDays(TODAY, 10);
    const ok = setup();
    await ok.service.assign(
      ADMIN,
      actor,
      TARGET,
      sensitive({ effectiveFrom: from, effectiveTo: addDays(from, MAX - 1) }),
    );
    expect(ok.repo.insertAssignment).toHaveBeenCalled();
    const denied = setup();
    await m2Error(
      denied.service.assign(
        ADMIN,
        actor,
        TARGET,
        sensitive({ effectiveFrom: from, effectiveTo: addDays(from, MAX) }),
      ),
    );
  });

  it('[5] role không nhạy cảm → không bị giới hạn (không hạn, hoặc dài hơn MAX)', async () => {
    const a = setup();
    await a.service.assign(
      ADMIN,
      actor,
      TARGET,
      dto({ roleCode: 'LINE_MANAGER' }),
    );
    expect(a.repo.insertAssignment).toHaveBeenCalled();
    const b = setup();
    await b.service.assign(
      ADMIN,
      actor,
      TARGET,
      dto({ roleCode: 'AUDITOR', effectiveTo: addDays(TODAY, MAX * 3) }),
    );
    expect(b.repo.insertAssignment).toHaveBeenCalled();
  });

  it('[6] protected HR_ADMIN (không effectiveTo) → M2 không chặn', async () => {
    const { service, repo } = setup();
    await service.assign(ADMIN, actor, TARGET, dto({ roleCode: 'HR_ADMIN' }));
    expect(repo.insertAssignment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ roleCode: 'HR_ADMIN', effectiveTo: null }),
    );
  });

  it('[7] role có cả quyền thường + nhạy cảm (ROLE_A) → coi là nhạy cảm', async () => {
    const { service } = setup();
    await m2Error(
      service.assign(ADMIN, actor, TARGET, dto({ roleCode: 'ROLE_A' })),
    );
  });

  it('[7] HR_SENSITIVE_VIEWER (CCCD + ngân hàng) → nhạy cảm', async () => {
    const { service } = setup();
    await m2Error(
      service.assign(
        ADMIN,
        actor,
        TARGET,
        dto({ roleCode: 'HR_SENSITIVE_VIEWER' }),
      ),
    );
  });
});

describe('M1 — thời hạn: không cấp quyền LÂU HƠN quyền của chính mình', () => {
  const MAX = MAX_SENSITIVE_ACCESS_DAYS;
  const { ACCESS_ADMIN, SALARY_VIEW, EMPLOYEE_VIEW } = HrPermission;
  const { COMPANY, BRANCH } = HrScope;
  const ADMIN_COMPANY = grant(ACCESS_ADMIN, COMPANY);

  /** Quyền của người cấp: bắt đầu hôm nay, còn `days` ngày tính cả hai đầu. */
  const held = (
    permission: HrPermission,
    scope: HrScope,
    days: number | null,
    ref: number | null = null,
    from: string = TODAY,
  ): HrGrant => ({
    ...grant(permission, scope, ref),
    effectiveFrom: from,
    effectiveTo: days === null ? null : addDays(from, days - 1),
  });

  /** Cấp PAYROLL_VIEWER kéo dài `days` ngày (tính cả hai đầu) từ hôm nay. */
  const payroll = (days: number, over: Partial<AssignHrRoleDto> = {}) =>
    dto({
      roleCode: 'PAYROLL_VIEWER',
      effectiveTo: addDays(TODAY, days - 1),
      ...over,
    });

  const periodError = async (p: Promise<unknown>) => {
    const e = await p.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ForbiddenException);
    return (e as ForbiddenException).getResponse() as Record<string, unknown>;
  };

  it('[1] người cấp còn MAX ngày → cấp MAX ngày → pass', async () => {
    const { service, repo } = setup({
      actorGrants: [ADMIN_COMPANY, held(SALARY_VIEW, COMPANY, MAX)],
    });
    await service.assign(ADMIN, actor, TARGET, payroll(MAX));
    expect(repo.insertAssignment).toHaveBeenCalled();
  });

  it('[2] người cấp còn 30 ngày → cấp 30 ngày → pass (cùng ngày hết hạn)', async () => {
    const { service, repo } = setup({
      actorGrants: [ADMIN_COMPANY, held(SALARY_VIEW, COMPANY, 30)],
    });
    await service.assign(ADMIN, actor, TARGET, payroll(30));
    expect(repo.insertAssignment).toHaveBeenCalled();
  });

  it('[3] người cấp còn 30 ngày → cấp 31 ngày → 403, nêu rõ quyền và hạn của người cấp', async () => {
    const { service, repo, audit } = setup({
      actorGrants: [ADMIN_COMPANY, held(SALARY_VIEW, COMPANY, 30)],
    });
    const body = await periodError(
      service.assign(ADMIN, actor, TARGET, payroll(31)),
    );
    expect(body).toMatchObject({
      code: 'HR_GRANT_EXCEEDS_OWN_ACCESS',
      missingPermissions: [],
      periodNotCovered: [
        { permission: 'SALARY_VIEW', yourEffectiveTo: addDays(TODAY, 29) },
      ],
    });
    expect(repo.insertAssignment).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('[4] người cấp vô thời hạn (vd. role cũ) → cấp nhạy cảm MAX ngày → pass', async () => {
    const { service, repo } = setup({
      actorGrants: [
        ADMIN_COMPANY,
        { ...grant(SALARY_VIEW, COMPANY), source: 'role', via: 'legacy' },
      ],
    });
    await service.assign(ADMIN, actor, TARGET, payroll(MAX));
    expect(repo.insertAssignment).toHaveBeenCalled();
  });

  it('[5] quyền người cấp hết hạn TRƯỚC ngày target bắt đầu → 403', async () => {
    const { service } = setup({
      actorGrants: [ADMIN_COMPANY, held(SALARY_VIEW, COMPANY, 10)],
    });
    const from = addDays(TODAY, 20);
    const body = await periodError(
      service.assign(
        ADMIN,
        actor,
        TARGET,
        dto({
          roleCode: 'PAYROLL_VIEWER',
          effectiveFrom: from,
          effectiveTo: addDays(from, 5),
        }),
      ),
    );
    expect(body.periodNotCovered).toEqual([
      { permission: 'SALARY_VIEW', yourEffectiveTo: addDays(TODAY, 9) },
    ]);
  });

  it('[6] nhiều grant: BRANCH 3 còn 30 ngày + COMPANY còn 90 ngày → cấp BRANCH 3 trong 60 ngày → pass', async () => {
    const { service, repo } = setup({
      actorGrants: [
        ADMIN_COMPANY,
        held(SALARY_VIEW, BRANCH, 30, 3),
        held(SALARY_VIEW, COMPANY, 90),
      ],
    });
    await service.assign(
      ADMIN,
      actor,
      TARGET,
      payroll(60, { scope: BRANCH, scopeRefId: 3 }),
    );
    expect(repo.insertAssignment).toHaveBeenCalled();
  });

  it('[7] đúng scope nhưng thời hạn không phủ → 403 (lý do: thời hạn)', async () => {
    const { service } = setup({
      actorGrants: [ADMIN_COMPANY, held(SALARY_VIEW, BRANCH, 30, 3)],
    });
    const body = await periodError(
      service.assign(
        ADMIN,
        actor,
        TARGET,
        payroll(60, { scope: BRANCH, scopeRefId: 3 }),
      ),
    );
    expect(body.missingPermissions).toEqual([]);
    expect(body.periodNotCovered).toEqual([
      { permission: 'SALARY_VIEW', yourEffectiveTo: addDays(TODAY, 29) },
    ]);
  });

  it('[8] thời hạn đủ nhưng scope không phủ → 403 (lý do: phạm vi)', async () => {
    const { service } = setup({
      actorGrants: [ADMIN_COMPANY, held(SALARY_VIEW, BRANCH, MAX, 3)],
    });
    const body = await periodError(
      service.assign(ADMIN, actor, TARGET, payroll(30)),
    );
    expect(body.missingPermissions).toEqual(['SALARY_VIEW']);
    expect(body.periodNotCovered).toEqual([]);
  });

  it('quyền thường có hạn không cấp được quyền đó VÔ THỜI HẠN (vd. admin tạm không tạo được admin vĩnh viễn)', async () => {
    const { service } = setup({
      actorGrants: [ADMIN_COMPANY, held(EMPLOYEE_VIEW, COMPANY, 90)],
    });
    const body = await periodError(
      service.assign(ADMIN, actor, TARGET, dto({ roleCode: 'LINE_MANAGER' })),
    );
    expect(body.periodNotCovered).toEqual([
      { permission: 'EMPLOYEE_VIEW', yourEffectiveTo: addDays(TODAY, 89) },
    ]);
  });
});
