import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hrToday } from '../common/effective-date';
import { HrAccessRepository } from './hr-access.repository';
import {
  HrPermission,
  HrScope,
  isHrPermission,
  UNRESTRICTED_SCOPES,
} from './hr-permission';
import { HR_SCOPE_RESOLVER } from './hr-scope-resolver';
import type { HrAccessTarget, HrScopeResolver } from './hr-scope-resolver';

/** Một quyền đang có hiệu lực, kèm nguồn gốc để giải thích được "vì sao có quyền". */
export interface HrGrant {
  permission: HrPermission;
  scope: HrScope;
  scopeRefId: number | null;
  /**
   * `role`: role cũ trong `employee.roles` (qua `hr.role_permissions`);
   * `assignment`: HR role được gán (`hr.account_role_assignments`);
   * `account`: quyền lẻ cấp riêng (`hr.account_permission_grants`).
   */
  source: 'role' | 'assignment' | 'account';
  /** `nhansu` / `assignment#12:HR_ADMIN` / `grant#7`. */
  via: string;
  /**
   * Khoảng hiệu lực của CHÍNH nguồn quyền này (YYYY-MM-DD, `effectiveTo`
   * inclusive). `null` = không giới hạn phía đó — role cũ luôn null/null (quyền
   * vô thời hạn trong phạm vi ánh xạ cho phép, không tạo expiry giả).
   * Chỉ dùng nội bộ (M1 kiểm tra thời hạn); không trả ra API `/me`.
   */
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface AssertAccessOptions {
  /**
   * Cách từ chối khi đối tượng nằm ngoài phạm vi. Mặc định `not_found`: trả
   * 404 như thể bản ghi không tồn tại, để người ngoài phạm vi không dò được
   * id nào có thật (chống enumeration kèm IDOR).
   */
  onDeny?: 'not_found' | 'forbidden';
  /** Ngày xét hiệu lực (YYYY-MM-DD), mặc định hôm nay theo giờ Việt Nam. */
  on?: string;
}

@Injectable()
export class HrAccessService {
  constructor(
    private readonly repo: HrAccessRepository,
    @Inject(HR_SCOPE_RESOLVER) private readonly scopes: HrScopeResolver,
  ) {}

  /**
   * Toàn bộ quyền đang hiệu lực của tài khoản (lọc theo `permission` nếu có).
   * Tài khoản không tồn tại hoặc đã khoá → không có quyền nào.
   */
  async getGrants(
    accountId: number,
    permission?: HrPermission,
    on: string = hrToday(),
  ): Promise<HrGrant[]> {
    if (permission !== undefined && !isHrPermission(permission)) {
      throw new Error(`Mã quyền HR không hợp lệ: ${String(permission)}`);
    }

    const account = await this.repo.findAccount(accountId);
    if (!account || !account.isActive) return [];

    // Tài khoản `dev` nhận quyền theo role như mọi tài khoản khác (quyết định
    // nghiệp vụ 25/09/2026) — kể cả role nó tự gán qua /employees/me/dev-roles.
    // Luôn đọc mới từ DB, không cache: thu hồi có hiệu lực ngay request kế tiếp.
    // Chạy tuần tự, không Promise.all: khi được gọi trong một transaction, cả
    // ba truy vấn dùng chung MỘT kết nối — pg không cho truy vấn chồng nhau.
    const byRole = await this.repo.findRolePermissions(
      account.roles,
      permission,
    );
    const byAssignment = await this.repo.findActiveRoleAssignmentGrants(
      accountId,
      on,
      permission,
    );
    const byAccount = await this.repo.findActiveAccountGrants(
      accountId,
      on,
      permission,
    );

    const grants: HrGrant[] = [
      ...byRole.map((g) => ({
        permission: g.permissionCode as HrPermission,
        scope: g.scope,
        scopeRefId: g.scopeRefId,
        source: 'role' as const,
        via: g.role,
        effectiveFrom: null,
        effectiveTo: null,
      })),
      ...byAssignment.map((g) => ({
        permission: g.permissionCode as HrPermission,
        scope: g.scope,
        scopeRefId: g.scopeRefId,
        source: 'assignment' as const,
        via: `assignment#${g.assignmentId}:${g.roleCode}`,
        effectiveFrom: g.effectiveFrom,
        effectiveTo: g.effectiveTo,
      })),
      ...byAccount.map((g) => ({
        permission: g.permissionCode as HrPermission,
        scope: g.scope,
        scopeRefId: g.scopeRefId,
        source: 'account' as const,
        via: `grant#${g.id}`,
        effectiveFrom: g.effectiveFrom,
        effectiveTo: g.effectiveTo,
      })),
    ];

    // Bỏ qua mã quyền/scope lạ trong DB thay vì để nó rơi vào nhánh mặc định nào đó.
    return grants.filter(
      (g) =>
        isHrPermission(g.permission) &&
        (Object.values(HrScope) as string[]).includes(g.scope),
    );
  }

  async hasPermission(
    accountId: number,
    permission: HrPermission,
    on?: string,
  ): Promise<boolean> {
    return (await this.getGrants(accountId, permission, on)).length > 0;
  }

  /** Đối tượng có nằm trong ít nhất một phạm vi được cấp của quyền này không. */
  async canAccess(
    accountId: number,
    permission: HrPermission,
    target: HrAccessTarget,
    on: string = hrToday(),
  ): Promise<boolean> {
    const grants = await this.getGrants(accountId, permission, on);
    for (const grant of grants) {
      if (await this.grantCovers(accountId, grant, target, on)) return true;
    }
    return false;
  }

  /**
   * Chốt chống IDOR: gọi SAU khi đã tự đọc bản ghi đích từ DB. Không có quyền
   * hoặc đối tượng ngoài phạm vi → 404 (mặc định) hoặc 403.
   */
  async assertCanAccess(
    accountId: number,
    permission: HrPermission,
    target: HrAccessTarget,
    options: AssertAccessOptions = {},
  ): Promise<void> {
    const allowed = await this.canAccess(
      accountId,
      permission,
      target,
      options.on,
    );
    if (allowed) return;

    if (options.onDeny === 'forbidden') {
      throw new ForbiddenException('Bạn không có quyền thao tác dữ liệu này');
    }
    throw new NotFoundException('Không tìm thấy dữ liệu');
  }

  private async grantCovers(
    viewerId: number,
    grant: HrGrant,
    target: HrAccessTarget,
    on: string,
  ): Promise<boolean> {
    if (UNRESTRICTED_SCOPES.includes(grant.scope)) return true;

    switch (grant.scope) {
      case HrScope.SELF:
        return target.accountId != null && target.accountId === viewerId;
      case HrScope.TEAM:
        return this.scopes.isInTeam(viewerId, target, on);
      case HrScope.ORG_UNIT:
        return this.scopes.isInOrgUnit(viewerId, grant.scopeRefId, target, on);
      case HrScope.BRANCH:
        return this.scopes.isInBranch(viewerId, grant.scopeRefId, target, on);
      default:
        return false;
    }
  }
}
