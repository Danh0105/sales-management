import { HrScope } from './hr-permission';

export interface ScopeRef {
  scope: HrScope;
  scopeRefId: number | null;
}

/** Scope cần id tham chiếu (phòng ban / chi nhánh cụ thể). */
export const SCOPES_REQUIRING_REF: readonly HrScope[] = [
  HrScope.ORG_UNIT,
  HrScope.BRANCH,
];

/** Trả về lý do sai, hoặc null nếu cặp scope + scopeRefId hợp lệ. */
export function scopeRefError(
  scope: HrScope,
  scopeRefId: unknown,
): string | null {
  const needsRef = SCOPES_REQUIRING_REF.includes(scope);
  const hasRef = scopeRefId !== null && scopeRefId !== undefined;
  if (needsRef && !hasRef) return `Scope ${scope} bắt buộc có scopeRefId`;
  if (!needsRef && hasRef) return `Scope ${scope} không dùng scopeRefId`;
  if (hasRef && !(Number.isInteger(scopeRefId) && (scopeRefId as number) > 0)) {
    return 'scopeRefId phải là số nguyên dương';
  }
  return null;
}

/**
 * Phạm vi `held` có bao trùm phạm vi `requested` không — dùng để chặn cấp
 * (hoặc thu hồi) quyền rộng hơn phạm vi quản trị của chính mình.
 *
 * - ALL bao trùm mọi thứ; chỉ ALL mới cấp được ALL.
 * - COMPANY bao trùm mọi scope trừ ALL.
 * - Scope hẹp chỉ bao trùm đúng scope đó, cùng đơn vị (held không gắn đơn vị
 *   thì bao trùm mọi đơn vị cùng loại).
 */
export function scopeCovers(held: ScopeRef, requested: ScopeRef): boolean {
  if (held.scope === HrScope.ALL) return true;
  if (held.scope === HrScope.COMPANY) return requested.scope !== HrScope.ALL;
  return (
    held.scope === requested.scope &&
    (held.scopeRefId === null || held.scopeRefId === requested.scopeRefId)
  );
}
