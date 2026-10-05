import { createHash } from 'crypto';
import { addDays } from '../../access-admin/hr-grant-policy';
import {
  ORG_CODE_PATTERN,
  ORG_LEADER_ROLES,
  ORG_UNIT_TYPES,
  OrgLeaderRole,
  OrgUnitStatus,
  OrgUnitType,
  periodsOverlap,
} from '../org-policy';
import { OrgNode, OrgSnapshot } from '../org-tree';
import { leaderViolation, structureViolation } from '../org-validation';

/**
 * Backfill lịch sử cơ cấu (Phase 1.2.2) — mô phỏng HOÀN TOÀN trong bộ nhớ:
 * gộp dữ liệu hiện có với kế hoạch, rồi kiểm tra toàn bộ cấu trúc tại MỌI mốc
 * thời gian bằng chính các luật của API (org-validation). Không truy cập DB.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ─── Kế hoạch (file JSON do người vận hành soạn) ──────────────────────

/** Ref tạm của đơn vị mới trong một kế hoạch (chữ thường, số, _). */
export const PLAN_REF_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
/**
 * Khoá nội bộ của đơn vị mới chưa có mã. `:` không bao giờ có trong mã thật
 * (ORG_CODE_PATTERN) nên hai không gian khoá không đụng nhau.
 */
export const refKey = (ref: string) => `ref:${ref}`;
export const isRefKey = (key: string) => key.startsWith('ref:');

export interface PlanRevision {
  effectiveFrom: string;
  unitType: OrgUnitType;
  name: string;
  /** Cha là đơn vị ĐÃ CÓ — mã thật (vd. DV0001). */
  parentCode?: string | null;
  /** Cha là đơn vị MỚI trong cùng kế hoạch — ref tạm. */
  parentRef?: string | null;
  status?: OrgUnitStatus;
}

export interface OrgBackfillPlan {
  /**
   * Đơn vị mới hoàn toàn — khai bằng `ref` tạm, KHÔNG tự chọn mã: hệ thống
   * sinh DV#### theo thứ tự phụ thuộc (cha trước con). Revision cuối để mở.
   */
  units?: { ref: string; code?: never; revisions: PlanRevision[] }[];
  /** Revision CHÈN TRƯỚC revision đầu tiên của đơn vị đã có — tham chiếu bằng mã thật. */
  history?: { code: string; revisions: PlanRevision[] }[];
  leaders?: {
    /** Đơn vị đã có (mã thật) — hoặc `unitRef` cho đơn vị mới trong kế hoạch. */
    unitCode?: string;
    unitRef?: string;
    employeeCode: string;
    leaderRole: OrgLeaderRole;
    isApprovalAuthority: boolean;
    positionCode?: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
  }[];
}

// ─── Trạng thái hiện có (đọc từ DB) ────────────────────────────────────

/** `unitCode`/`parentCode`: mã thật, hoặc `ref:<ref>` cho đơn vị mới chưa có mã. */
export interface ExistingRevision {
  unitCode: string;
  unitType: OrgUnitType;
  name: string;
  parentCode: string | null;
  status: OrgUnitStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ExistingLeader {
  unitCode: string;
  employeeId: number;
  leaderRole: OrgLeaderRole;
  isApprovalAuthority: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ExistingOrgState {
  unitIds: Map<string, number>;
  revisions: ExistingRevision[];
  leaders: ExistingLeader[];
  employees: Map<string, { id: number; status: string; name: string }>;
  positions: Map<string, { id: number; isActive: boolean }>;
  /** Ref đã dùng ở các lần backfill trước (hr.org_backfill_runs) → mã đã cấp. */
  appliedRefs?: Map<string, { code: string; runId: number }>;
}

// ─── Kết quả ──────────────────────────────────────────────────────────

export interface BackfillRevision extends ExistingRevision {
  source: 'NEW_UNIT' | 'PREPEND';
}

export interface BackfillLeader extends ExistingLeader {
  employeeCode: string;
  positionId: number | null;
}

export interface BackfillResult {
  errors: string[];
  /** Ref đơn vị mới theo thứ tự phụ thuộc (cha trước con) — thứ tự cấp mã. */
  newUnitRefs: string[];
  revisions: BackfillRevision[];
  leaders: BackfillLeader[];
  checkpoints: number;
}

function normalizeRevisions(
  code: string,
  list: PlanRevision[],
  today: string,
  errors: string[],
): ExistingRevision[] {
  if (!Array.isArray(list) || !list.length) {
    errors.push(`${code}: cần ít nhất một revision`);
    return [];
  }
  const out: ExistingRevision[] = [];
  list.forEach((r, i) => {
    const where = `${code} revision #${i + 1}`;
    if (!ISO.test(r.effectiveFrom ?? ''))
      errors.push(`${where}: effectiveFrom phải dạng YYYY-MM-DD`);
    else if (r.effectiveFrom > today)
      errors.push(
        `${where}: backfill chỉ cho ngày đến hôm nay (${today}); thay đổi tương lai dùng API thường`,
      );
    if (!ORG_UNIT_TYPES.includes(r.unitType))
      errors.push(`${where}: unitType không hợp lệ`);
    if (!r.name?.trim()) errors.push(`${where}: thiếu name`);
    if (r.status && !['ACTIVE', 'INACTIVE'].includes(r.status))
      errors.push(`${where}: status không hợp lệ`);
    if (r.parentCode && r.parentRef)
      errors.push(`${where}: chỉ khai một trong parentCode / parentRef`);
    if (r.parentRef && !PLAN_REF_PATTERN.test(r.parentRef))
      errors.push(`${where}: parentRef "${r.parentRef}" không hợp lệ`);
    if (i > 0 && list[i - 1].effectiveFrom >= r.effectiveFrom) {
      errors.push(
        `${where}: effectiveFrom phải tăng dần so với revision trước`,
      );
    }
    out.push({
      unitCode: code,
      unitType: r.unitType,
      name: (r.name ?? '').trim(),
      parentCode:
        r.unitType === 'COMPANY'
          ? null
          : r.parentRef
            ? refKey(r.parentRef)
            : (r.parentCode ?? null),
      status: r.status ?? 'ACTIVE',
      effectiveFrom: r.effectiveFrom,
      effectiveTo: null,
    });
  });
  // Nối liền: revision trước kết thúc ngay trước revision sau.
  for (let i = 0; i < out.length - 1; i++) {
    if (ISO.test(out[i + 1].effectiveFrom))
      out[i].effectiveTo = addDays(out[i + 1].effectiveFrom, -1);
  }
  return out;
}

/**
 * Thứ tự cấp mã cho đơn vị mới: cha (qua `parentRef` ở BẤT KỲ revision nào)
 * trước con; hoà thì theo thứ tự khai trong kế hoạch → luôn cùng kết quả với
 * cùng một kế hoạch. Vòng tham chiếu `parentRef` → lỗi.
 */
export function dependencyOrder(
  refs: string[],
  revisions: ExistingRevision[],
  errors: string[],
): string[] {
  const parents = new Map<string, Set<string>>(refs.map((r) => [r, new Set()]));
  for (const r of revisions) {
    if (!isRefKey(r.unitCode) || r.parentCode === null) continue;
    if (!isRefKey(r.parentCode)) continue;
    const child = r.unitCode.slice(4);
    const parent = r.parentCode.slice(4);
    if (parents.has(child) && parents.has(parent))
      parents.get(child)!.add(parent);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < refs.length) {
    const next = refs.find(
      (r) => !done.has(r) && [...parents.get(r)!].every((p) => done.has(p)),
    );
    if (!next) {
      const stuck = refs.filter((r) => !done.has(r));
      errors.push(
        `Vòng tham chiếu parentRef giữa các đơn vị mới: ${stuck.join(', ')}`,
      );
      return [...order, ...stuck];
    }
    order.push(next);
    done.add(next);
  }
  return order;
}

/** Kiểm tra kế hoạch trên trạng thái hiện có. `errors` rỗng = ghi được. */
export function validateBackfill(
  plan: OrgBackfillPlan,
  existing: ExistingOrgState,
  today: string,
): BackfillResult {
  const errors: string[] = [];
  const revisions: BackfillRevision[] = [];
  /** Ref đơn vị mới, theo thứ tự khai trong kế hoạch. */
  const planRefs: string[] = [];

  for (const [i, u] of (plan.units ?? []).entries()) {
    const where = `Đơn vị mới #${i + 1}`;
    if ((u as { code?: unknown }).code !== undefined) {
      errors.push(
        `${where}: không được tự chọn mã ("code") — khai "ref" tạm, hệ thống sinh DV####`,
      );
      continue;
    }
    if (!PLAN_REF_PATTERN.test(u.ref ?? '')) {
      errors.push(
        `${where}: ref "${u.ref ?? ''}" không hợp lệ (chữ thường, số, _; 2–64 ký tự, bắt đầu bằng chữ)`,
      );
      continue;
    }
    if (planRefs.includes(u.ref)) {
      errors.push(`ref "${u.ref}": khai trùng trong kế hoạch`);
      continue;
    }
    const applied = existing.appliedRefs?.get(u.ref);
    if (applied) {
      errors.push(
        `ref "${u.ref}": đã được tạo ở lần backfill #${applied.runId} thành ${applied.code} — tham chiếu bằng mã ${applied.code} (parentCode/unitCode/history), không khai lại`,
      );
      continue;
    }
    planRefs.push(u.ref);
    revisions.push(
      ...normalizeRevisions(refKey(u.ref), u.revisions, today, errors).map(
        (r) => ({ ...r, source: 'NEW_UNIT' as const }),
      ),
    );
  }

  const historyCodes = new Set<string>();
  for (const h of plan.history ?? []) {
    if (!ORG_CODE_PATTERN.test(h.code ?? '') || !existing.unitIds.has(h.code)) {
      errors.push(
        `${h.code}: phần "history" chỉ dành cho đơn vị đã có (tham chiếu bằng mã thật)`,
      );
      continue;
    }
    if (historyCodes.has(h.code)) {
      errors.push(`${h.code}: khai "history" trùng`);
      continue;
    }
    historyCodes.add(h.code);
    const first = existing.revisions
      .filter((r) => r.unitCode === h.code)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
    const list = normalizeRevisions(h.code, h.revisions, today, errors);
    if (!first || !list.length) continue;
    const last = list[list.length - 1];
    if (last.effectiveFrom >= first.effectiveFrom) {
      errors.push(
        `${h.code}: lịch sử chèn thêm phải bắt đầu trước revision đầu tiên hiện có (${first.effectiveFrom})`,
      );
      continue;
    }
    last.effectiveTo = addDays(first.effectiveFrom, -1);
    revisions.push(...list.map((r) => ({ ...r, source: 'PREPEND' as const })));
  }

  const planKeys = new Set(planRefs.map(refKey));
  for (const r of revisions) {
    if (r.parentCode === null) continue;
    if (isRefKey(r.parentCode)) {
      if (!planKeys.has(r.parentCode))
        errors.push(
          `${r.unitCode} (${r.effectiveFrom}): parentRef "${r.parentCode.slice(4)}" không có trong phần "units" của kế hoạch`,
        );
    } else if (!existing.unitIds.has(r.parentCode)) {
      errors.push(
        `${r.unitCode} (${r.effectiveFrom}): đơn vị cha "${r.parentCode}" không tồn tại`,
      );
    }
  }

  const newUnitRefs = dependencyOrder(planRefs, revisions, errors);

  // Lãnh đạo
  const leaders: BackfillLeader[] = [];
  (plan.leaders ?? []).forEach((l, i) => {
    const unitKey = l.unitRef ? refKey(l.unitRef) : (l.unitCode ?? '');
    const where = `Lãnh đạo #${i + 1} (${unitKey}/${l.employeeCode})`;
    const employee = existing.employees.get(l.employeeCode);
    const position = l.positionCode
      ? existing.positions.get(l.positionCode)
      : undefined;
    if (!!l.unitCode === !!l.unitRef)
      errors.push(`${where}: khai đúng một trong unitCode / unitRef`);
    else if (
      l.unitRef ? !planKeys.has(unitKey) : !existing.unitIds.has(unitKey)
    )
      errors.push(
        l.unitRef
          ? `${where}: unitRef không có trong phần "units" của kế hoạch`
          : `${where}: đơn vị không tồn tại`,
      );
    if (!employee)
      errors.push(`${where}: không có hồ sơ nhân viên mã ${l.employeeCode}`);
    if (!ORG_LEADER_ROLES.includes(l.leaderRole))
      errors.push(`${where}: leaderRole không hợp lệ`);
    if (l.leaderRole === 'DEPUTY' && l.isApprovalAuthority)
      errors.push(`${where}: phó không làm người duyệt chính`);
    if (l.positionCode && !position)
      errors.push(`${where}: không có chức danh ${l.positionCode}`);
    if (!ISO.test(l.effectiveFrom ?? ''))
      errors.push(`${where}: effectiveFrom phải dạng YYYY-MM-DD`);
    else if (l.effectiveFrom > today)
      errors.push(`${where}: backfill chỉ cho ngày đến hôm nay`);
    const to = l.effectiveTo ?? null;
    if (to !== null && (!ISO.test(to) || to < l.effectiveFrom))
      errors.push(`${where}: effectiveTo không hợp lệ`);
    if (
      employee &&
      employee.status !== 'ACTIVE' &&
      (to === null || to >= today)
    ) {
      errors.push(
        `${where}: nhân viên không còn hoạt động — vai trò phải kết thúc trước hôm nay`,
      );
    }
    if (employee) {
      leaders.push({
        unitCode: unitKey,
        employeeId: employee.id,
        employeeCode: l.employeeCode,
        leaderRole: l.leaderRole,
        isApprovalAuthority: !!l.isApprovalAuthority,
        positionId: position?.id ?? null,
        effectiveFrom: l.effectiveFrom,
        effectiveTo: to,
      });
    }
  });

  if (errors.length)
    return {
      errors,
      newUnitRefs,
      revisions,
      leaders,
      checkpoints: 0,
    };

  // ── Kiểm tra toàn bộ cấu trúc tại mọi mốc thời gian ──
  const idOf = new Map<string, number>(existing.unitIds);
  // Id tạm DƯƠNG (không trùng id thật) — kiểm tra vòng lặp chỉ chạy với id > 0.
  let temp = 2_000_000_000;
  for (const key of planKeys) idOf.set(key, temp++);
  const merged: ExistingRevision[] = [...existing.revisions, ...revisions];
  const mergedLeaders: ExistingLeader[] = [...existing.leaders, ...leaders];

  const dates = new Set<string>();
  for (const r of merged) dates.add(r.effectiveFrom);
  for (const l of mergedLeaders) {
    dates.add(l.effectiveFrom);
    if (l.effectiveTo) dates.add(addDays(l.effectiveTo, 1));
  }
  const checkpoints = [...dates].sort();
  const seen = new Set<string>();
  const report = (msg: string) => {
    if (!seen.has(msg)) {
      seen.add(msg);
      errors.push(msg);
    }
  };

  for (const date of checkpoints) {
    const nodes: OrgNode[] = merged
      .filter(
        (r) =>
          r.effectiveFrom <= date &&
          (r.effectiveTo === null || r.effectiveTo >= date),
      )
      .map((r) => ({
        id: idOf.get(r.unitCode)!,
        code: r.unitCode,
        revisionId: 0,
        unitType: r.unitType,
        name: r.name,
        parentId: r.parentCode === null ? null : (idOf.get(r.parentCode) ?? 0),
        status: r.status,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
      }));
    const snapshot = new OrgSnapshot(date, nodes);
    for (const node of nodes) {
      const v = structureViolation(snapshot, node);
      if (v) report(`${date} — ${node.code}: [${v.code}] ${v.message}`);
    }
    for (const l of mergedLeaders) {
      if (
        l.effectiveFrom > date ||
        (l.effectiveTo !== null && l.effectiveTo < date)
      )
        continue;
      const v = leaderViolation(snapshot, idOf.get(l.unitCode)!, l.leaderRole);
      if (v)
        report(
          `${date} — lãnh đạo ${l.leaderRole} tại ${l.unitCode}: [${v.code}] ${v.message}`,
        );
    }
  }

  // Chồng lấn lãnh đạo: người duyệt chính / trùng cùng người.
  for (const l of leaders) {
    const mine = { from: l.effectiveFrom, to: l.effectiveTo };
    for (const other of mergedLeaders) {
      if (
        other === l ||
        other.unitCode !== l.unitCode ||
        other.leaderRole !== l.leaderRole
      )
        continue;
      if (
        !periodsOverlap(mine, {
          from: other.effectiveFrom,
          to: other.effectiveTo,
        })
      )
        continue;
      if (other.employeeId === l.employeeId) {
        report(
          `${l.unitCode}/${l.employeeCode}: trùng vai trò ${l.leaderRole} chồng thời gian`,
        );
      } else if (l.isApprovalAuthority && other.isApprovalAuthority) {
        report(
          `${l.unitCode}: hai người duyệt chính ${l.leaderRole} chồng thời gian (${l.effectiveFrom})`,
        );
      }
    }
  }

  return {
    errors,
    newUnitRefs,
    revisions,
    leaders,
    checkpoints: checkpoints.length,
  };
}

// ─── Idempotency ──────────────────────────────────────────────────────

/** JSON với khoá object sắp xếp — cùng nội dung → cùng chuỗi (bỏ qua thứ tự khoá, khoảng trắng). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Khoá idempotency của một kế hoạch (SHA-256 hex của JSON chuẩn hoá). */
export function planHash(plan: OrgBackfillPlan): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}
