import type { HrGrant } from '../access/hr-access.service';
import { HrPermission, HrScope } from '../access/hr-permission';
import { grantScopeCovers } from '../access-admin/hr-grant-policy';
import type { OrgUnitType } from './org-policy';
import type { OrgNode, OrgSnapshot } from './org-tree';

/**
 * Danh sách đơn vị cho ô chọn phạm vi khi CẤP QUYỀN HR (trang Phân quyền) —
 * projection tối thiểu dành cho ACCESS_ADMIN, không mở API cây tổ chức.
 *
 * - Chỉ phạm vi có gắn đơn vị: BRANCH → chi nhánh; ORG_UNIT → phòng ban/nhóm.
 * - Chỉ đơn vị ĐANG HOẠT ĐỘNG tại `asOf` (ngày bắt đầu hiệu lực của quyền).
 * - Chỉ đơn vị mà phạm vi ACCESS_ADMIN của người xem BAO TRÙM, theo đúng luật
 *   M1 (`grantScopeCovers` — dùng lại, không sao chép): COMPANY/ALL → tất cả;
 *   BRANCH/ORG_UNIT có đơn vị → đúng đơn vị đó và đúng loại phạm vi đó;
 *   SELF/TEAM → không có lựa chọn nào.
 * - Không có lãnh đạo, nhân viên hay dữ liệu nội bộ.
 *
 * Đây CHỈ là gợi ý cho giao diện. POST cấp quyền vẫn qua M1 đầy đủ
 * (permission + scope + period) — gửi id ngoài danh sách vẫn bị từ chối.
 */
export const SCOPE_OPTION_TYPES = ['BRANCH', 'ORG_UNIT'] as const;
export type ScopeOptionType = (typeof SCOPE_OPTION_TYPES)[number];

export const SCOPE_OPTION_UNIT_TYPES: Record<ScopeOptionType, OrgUnitType[]> = {
  BRANCH: ['BRANCH'],
  ORG_UNIT: ['DEPARTMENT', 'TEAM'],
};

export interface ScopeOptionView {
  id: number;
  code: string;
  name: string;
  unitType: OrgUnitType;
  parentId: number | null;
  /** `Công ty > Chi nhánh > Phòng`. */
  path: string;
}

export const isScopeOptionType = (scope: string): scope is ScopeOptionType =>
  (SCOPE_OPTION_TYPES as readonly string[]).includes(scope);

/**
 * NGUỒN SỰ THẬT DUY NHẤT: đơn vị (revision tại ngày đang xét) có dùng được làm
 * phạm vi `scopeType` không — tồn tại, ACTIVE, đúng loại. Dùng chung cho
 * `scopeOptions` (ô chọn) và `OrgScopeUnitValidator` (kiểm tra khi cấp quyền).
 */
export function isScopeUnitAllowed(
  node: Pick<OrgNode, 'status' | 'unitType'> | null | undefined,
  scopeType: ScopeOptionType,
): boolean {
  return (
    !!node &&
    node.status === 'ACTIVE' &&
    SCOPE_OPTION_UNIT_TYPES[scopeType].includes(node.unitType)
  );
}

export function scopeOptions(
  snapshot: OrgSnapshot,
  scopeType: ScopeOptionType,
  actorGrants: readonly HrGrant[],
): ScopeOptionView[] {
  const adminGrants = actorGrants.filter(
    (g) => g.permission === HrPermission.ACCESS_ADMIN,
  );
  return snapshot
    .all()
    .filter((n) => isScopeUnitAllowed(n, scopeType))
    .filter((n) =>
      adminGrants.some((g) =>
        grantScopeCovers(g, { scope: scopeType as HrScope, scopeRefId: n.id }),
      ),
    )
    .map((n) => ({
      id: n.id,
      code: n.code,
      name: n.name,
      unitType: n.unitType,
      parentId: n.parentId,
      path: [
        ...snapshot
          .ancestors(n.id)
          .reverse()
          .map((a) => a.name),
        n.name,
      ].join(' > '),
    }))
    .sort((a, b) => a.path.localeCompare(b.path, 'vi') || a.id - b.id);
}
