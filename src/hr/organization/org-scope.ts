import { ForbiddenException } from '@nestjs/common';
import type { HrGrant } from '../access/hr-access.service';
import {
  HrPermission,
  HrScope,
  UNRESTRICTED_SCOPES,
} from '../access/hr-permission';
import { OrgSnapshot } from './org-tree';

/**
 * Phạm vi của `ORG_MANAGE` trên cây tổ chức (thuần):
 *
 * - COMPANY / ALL: toàn bộ cơ cấu.
 * - BRANCH X (X phải là đơn vị loại BRANCH tại ngày xét) và ORG_UNIT X: chỉ
 *   các đơn vị CON CHÁU của X — không sửa/đóng/đặt lãnh đạo cho chính X (việc
 *   đó thuộc cấp trên), nhưng được tạo đơn vị mới ngay dưới X.
 * - SELF / TEAM: không quản lý được cơ cấu.
 */
export function orgManageGrants(grants: HrGrant[]): HrGrant[] {
  return grants.filter((g) => g.permission === HrPermission.ORG_MANAGE);
}

export function hasUnrestrictedOrgManage(grants: HrGrant[]): boolean {
  return orgManageGrants(grants).some((g) =>
    UNRESTRICTED_SCOPES.includes(g.scope),
  );
}

function scopedRoots(grants: HrGrant[], snapshot: OrgSnapshot): number[] {
  return orgManageGrants(grants)
    .filter((g) => g.scopeRefId !== null)
    .filter((g) =>
      g.scope === HrScope.BRANCH
        ? snapshot.get(g.scopeRefId!)?.unitType === 'BRANCH'
        : g.scope === HrScope.ORG_UNIT,
    )
    .map((g) => g.scopeRefId!);
}

/** Được sửa / đóng / đặt lãnh đạo cho đơn vị `unitId` tại ngày của snapshot. */
export function canManageUnit(
  grants: HrGrant[],
  snapshot: OrgSnapshot,
  unitId: number,
): boolean {
  if (hasUnrestrictedOrgManage(grants)) return true;
  return scopedRoots(grants, snapshot).some((root) =>
    snapshot.isStrictDescendant(unitId, root),
  );
}

/** Được đặt một đơn vị (mới hoặc chuyển tới) ngay dưới `parentId`. */
export function canPlaceUnder(
  grants: HrGrant[],
  snapshot: OrgSnapshot,
  parentId: number,
): boolean {
  if (hasUnrestrictedOrgManage(grants)) return true;
  return scopedRoots(grants, snapshot).some(
    (root) => parentId === root || snapshot.isStrictDescendant(parentId, root),
  );
}

export function outOfOrgScope() {
  return new ForbiddenException({
    statusCode: 403,
    code: 'HR_ORG_OUT_OF_SCOPE',
    message: 'Đơn vị nằm ngoài phạm vi quản lý cơ cấu của bạn',
  });
}
