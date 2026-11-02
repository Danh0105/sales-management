import { HrGrant } from '../access/hr-access.service';
import { HrPermission, HrScope } from '../access/hr-permission';

/**
 * Chính sách cấp quyền HR — NƠI DUY NHẤT định nghĩa danh sách quyền nhạy cảm
 * (M2), giới hạn thời gian, và luật "không cấp quá quyền của chính mình" (M1).
 * Service, bootstrap và spec đều import từ đây; không chép số 180 đi nơi khác.
 */

/**
 * M2 — quyền XEM/REVEAL dữ liệu nhạy cảm. Chỉ gồm các mã quyền ĐANG có trong
 * `HrPermission`: CCCD/CMND/hộ chiếu (IDENTITY_REVEAL), tài khoản ngân hàng
 * (BANK_REVEAL), lương (SALARY_VIEW). Chưa có quyền riêng cho thuế/BHXH/
 * IDENTITY_VIEW/BANK_VIEW — khi thêm, bổ sung vào đây.
 *
 * Cố ý KHÔNG gồm ACCESS_ADMIN: protected HR admin phải không có effectiveTo
 * (xem access-safety/hr-admin-quota.ts), nên role quản trị không thuộc M2.
 */
export const SENSITIVE_ACCESS_PERMISSIONS: readonly HrPermission[] = [
  HrPermission.SALARY_VIEW,
  HrPermission.IDENTITY_REVEAL,
  HrPermission.BANK_REVEAL,
  HrPermission.HEALTH_DOCUMENT_VIEW,
];

/**
 * M2 — tổng số NGÀY LỊCH có quyền tối đa, tính CẢ hai đầu (effectiveTo là
 * inclusive): from = 2026-01-01 → effectiveTo muộn nhất 2026-06-29 = 180 ngày.
 * Dùng `latestSensitiveEffectiveTo()`, không tự cộng số ngày ở nơi khác.
 */
export const MAX_SENSITIVE_ACCESS_DAYS = 180;

export const SENSITIVE_ACCESS_DURATION_MESSAGE = `Sensitive access assignments cannot exceed ${MAX_SENSITIVE_ACCESS_DAYS} days.`;
export const SENSITIVE_ACCESS_REQUIRES_END_MESSAGE = `Sensitive access assignments require effectiveTo (at most ${MAX_SENSITIVE_ACCESS_DAYS} days in total, counting both effectiveFrom and effectiveTo).`;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Cộng ngày trên chuỗi `YYYY-MM-DD` bằng lịch UTC thuần — không phụ thuộc
 * múi giờ của server/Node, nên không lệch ±1 ngày quanh nửa đêm hay tháng/năm
 * nhuận. (Ngày "hôm nay" theo giờ Việt Nam do `hrToday()` quyết định.)
 */
export function addDays(isoDate: string, days: number): string {
  const m = ISO_DATE.exec(isoDate);
  if (!m) throw new Error(`Ngày không hợp lệ: ${isoDate}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** Role chứa ít nhất một quyền M2 → assignment của nó là "sensitive". */
export function isSensitiveAccess(permissionCodes: readonly string[]): boolean {
  return permissionCodes.some((p) =>
    (SENSITIVE_ACCESS_PERMISSIONS as readonly string[]).includes(p),
  );
}

/**
 * M2 — `effectiveTo` muộn nhất để tổng thời gian có quyền (tính cả hai đầu)
 * đúng MAX_SENSITIVE_ACCESS_DAYS: `effectiveFrom + (MAX − 1)`.
 */
export function latestSensitiveEffectiveTo(effectiveFrom: string): string {
  return addDays(effectiveFrom, MAX_SENSITIVE_ACCESS_DAYS - 1);
}

/** Số ngày lịch có quyền, tính cả hai đầu (from = to → 1 ngày). */
export function inclusiveDays(
  effectiveFrom: string,
  effectiveTo: string,
): number {
  const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
  return Math.round((toMs(effectiveTo) - toMs(effectiveFrom)) / 86_400_000) + 1;
}

/**
 * M2 — trả thông báo lỗi, hoặc null nếu thời hạn hợp lệ. Từ chối, không tự
 * sửa dữ liệu người dùng gửi.
 */
export function sensitiveDurationError(
  effectiveFrom: string,
  effectiveTo: string | null,
): string | null {
  if (effectiveTo === null) return SENSITIVE_ACCESS_REQUIRES_END_MESSAGE;
  if (effectiveTo > latestSensitiveEffectiveTo(effectiveFrom)) {
    return SENSITIVE_ACCESS_DURATION_MESSAGE;
  }
  return null;
}

export interface ScopeRef {
  scope: HrScope;
  scopeRefId: number | null;
}

/**
 * M1 — phạm vi quyền `held` của người cấp có CHỨA phạm vi `requested` không,
 * theo nghĩa TẬP DỮ LIỆU (`grantedScope ⊆ actorScope`):
 *
 * - ALL chứa mọi phạm vi; COMPANY chứa mọi phạm vi trừ ALL.
 * - ORG_UNIT/BRANCH có đơn vị cụ thể chỉ chứa ĐÚNG đơn vị đó (chưa có cây tổ
 *   chức để suy ra đơn vị con — Phase 1).
 * - SELF/TEAM và ORG_UNIT/BRANCH không gắn đơn vị là phạm vi TƯƠNG ĐỐI theo
 *   người giữ ("hồ sơ của tôi", "nhóm của tôi"): cấp cùng tên scope cho người
 *   khác là trao một tập dữ liệu KHÁC → không bao giờ được tính là chứa.
 */
export function grantScopeCovers(held: ScopeRef, requested: ScopeRef): boolean {
  if (held.scope === HrScope.ALL) return true;
  if (held.scope === HrScope.COMPANY) return requested.scope !== HrScope.ALL;
  if (
    (held.scope === HrScope.ORG_UNIT || held.scope === HrScope.BRANCH) &&
    held.scopeRefId !== null
  ) {
    return (
      requested.scope === held.scope && requested.scopeRefId === held.scopeRefId
    );
  }
  return false;
}

export interface Period {
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/**
 * M1 — khoảng hiệu lực của quyền người cấp (`held`) có bao trùm khoảng được
 * cấp (`target`) không: `held.from <= target.from` VÀ `held.to >= target.to`.
 * `null` = không giới hạn phía đó. Target vô thời hạn chỉ được bao bởi quyền
 * cũng vô thời hạn. Không tự rút ngắn target.
 */
export function periodCovers(
  held: Period,
  target: { effectiveFrom: string; effectiveTo: string | null },
): boolean {
  const fromOk =
    held.effectiveFrom === null || held.effectiveFrom <= target.effectiveFrom;
  const toOk =
    held.effectiveTo === null ||
    (target.effectiveTo !== null && held.effectiveTo >= target.effectiveTo);
  return fromOk && toOk;
}

export type UncoveredReason = 'NOT_HELD_AT_SCOPE' | 'PERIOD_NOT_COVERED';

export interface UncoveredPermission {
  permission: string;
  reason: UncoveredReason;
  /**
   * Với PERIOD_NOT_COVERED: ngày cuối muộn nhất mà người cấp đang có quyền này
   * ở phạm vi phù hợp (null = không giới hạn nhưng bắt đầu muộn hơn target).
   */
  actorEffectiveTo?: string | null;
}

/**
 * M1 — quyền trong role mà người cấp KHÔNG bao trùm được về
 * permission + scope + thời hạn. Rỗng = được cấp.
 *
 * Mỗi quyền xét độc lập (có một phần quyền của role KHÔNG đủ để cấp cả role),
 * và chỉ cần ÍT NHẤT MỘT grant của người cấp bao trùm đủ cả ba — không lấy
 * grant đầu tiên. Quyền hiệu lực tính từ mọi nguồn (role cũ, HR role đã gán,
 * quyền lẻ); role cũ không có hạn nên là vô thời hạn.
 */
export function uncoveredPermissions(
  rolePermissions: readonly string[],
  actorGrants: readonly HrGrant[],
  requested: ScopeRef,
  target: { effectiveFrom: string; effectiveTo: string | null },
): UncoveredPermission[] {
  const result: UncoveredPermission[] = [];
  for (const permission of rolePermissions) {
    const atScope = actorGrants.filter(
      (g) =>
        (g.permission as string) === permission &&
        grantScopeCovers(g, requested),
    );
    if (!atScope.length) {
      result.push({ permission, reason: 'NOT_HELD_AT_SCOPE' });
      continue;
    }
    if (!atScope.some((g) => periodCovers(g, target))) {
      const unlimited = atScope.some((g) => g.effectiveTo === null);
      result.push({
        permission,
        reason: 'PERIOD_NOT_COVERED',
        actorEffectiveTo: unlimited
          ? null
          : atScope
              .map((g) => g.effectiveTo as string)
              .sort()
              .at(-1),
      });
    }
  }
  return result;
}
