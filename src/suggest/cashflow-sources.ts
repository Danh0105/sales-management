import type { EntityManager } from 'typeorm';

import { allocateSuggestPayment } from '../management-expense-item/suggest-payments';
import type { ManagementViewSection } from './expense-management-view';

/**
 * Đề xuất chi tháng lấy khoản chưa chi từ QL thu chi (13/11/2026). Một đề xuất
 * chỉ thuộc một bảng nguồn; mỗi dòng đề xuất (`suggest_monthly_items`) là một
 * "khoản":
 * - MANAGEMENT — "Chi chính sách tháng" (đề xuất chi tháng
 *   có từ trước): một môn của bảng thu chi một kỳ, bảng Chi Ngoài.
 * - SCHOOL_EXPENSE — "Đề xuất Chi Trường": một môn của bảng thu chi một kỳ,
 *   bảng Chi Trường.
 * - SCHOOL_TEACHER — "Đề xuất Chi GV trường": lương một giáo viên của trường
 *   trong kỳ (mọi môn), bảng Giáo viên trường.
 * Đồng bộ khi kinh doanh xác nhận đã chi, theo ID dòng (xem các hàm record*).
 */

export const CASHFLOW_SOURCES = [
  'MANAGEMENT',
  'SCHOOL_EXPENSE',
  'SCHOOL_TEACHER',
] as const;
export type CashflowSource = (typeof CASHFLOW_SOURCES)[number];

export const CASHFLOW_SOURCE_LABELS: Record<CashflowSource, string> = {
  MANAGEMENT: 'Chi chính sách tháng',
  SCHOOL_EXPENSE: 'Đề xuất Chi Trường',
  SCHOOL_TEACHER: 'Đề xuất Chi GV trường',
};

/** Tên bảng nguồn trong QL thu chi — dùng trong thông báo lỗi / lịch sử. */
export const CASHFLOW_TABLE_LABELS: Record<CashflowSource, string> = {
  MANAGEMENT: 'Chi Ngoài',
  SCHOOL_EXPENSE: 'Chi Trường',
  SCHOOL_TEACHER: 'Giáo viên trường',
};

export const isCashflowSource = (value: unknown): value is CashflowSource =>
  typeof value === 'string' &&
  (CASHFLOW_SOURCES as readonly string[]).includes(value);

/**
 * Quy trình Kế toán (16/11/2026): kinh doanh tạo đề xuất cho một trường + một
 * kỳ kế toán, Kế toán nhập số liệu bảng rồi gửi, Kế toán trưởng → Giám đốc →
 * Kế toán công nợ lập lệnh chi → Thủ quỹ → kinh doanh.
 */
export const ACCOUNTANT_CHAIN = 'ACCOUNTANT_CHAIN';

export const isAccountantChain = (s: {
  isMonthlyExpense?: boolean | null;
  approvalFlow?: string | null;
}) => !!s.isMonthlyExpense && s.approvalFlow === ACCOUNTANT_CHAIN;

/**
 * "Đề xuất chi tháng" tích chọn (từ 19/11/2026): một trường + một kỳ kế toán,
 * kinh doanh tích Chi trường (bảng Chi Trường) / Chi Ban quản lí (bảng Chi
 * Ngoài) — chỉ môn đã xác nhận BBCS — / Chi giáo viên (bảng Giáo viên trường,
 * Kế toán đã nhập), nhập một số tiền ≤ tổng Còn chi đã chọn → Kế toán hoặc Kế
 * toán công nợ nhập số tiền từng khoản (mỗi khoản ≤ Còn chi, tổng ≤ số kinh
 * doanh nhập) → Giám đốc (bỏ Kế toán trưởng) → Kế toán công nợ lập lệnh chi →
 * Thủ quỹ → kinh doanh. Mỗi khoản mang bảng nguồn riêng
 * (`suggest_monthly_items.cashflow_source`).
 */
export const SALES_PICK = 'SALES_PICK';

export const isSalesPick = (s: {
  isMonthlyExpense?: boolean | null;
  approvalFlow?: string | null;
}) => !!s.isMonthlyExpense && s.approvalFlow === SALES_PICK;

/** Chi tháng có Giám đốc duyệt từng khoản trước, Kế toán công nợ lập lệnh chi sau. */
export const isMonthlyChain = (s: {
  isMonthlyExpense?: boolean | null;
  approvalFlow?: string | null;
}) => isAccountantChain(s) || isSalesPick(s);

/** Tên loại khoản ở "Đề xuất chi tháng" tích chọn. */
export const SALES_PICK_SOURCE_LABELS: Record<CashflowSource, string> = {
  SCHOOL_EXPENSE: 'Chi trường',
  MANAGEMENT: 'Chi Ban quản lí',
  SCHOOL_TEACHER: 'Chi giáo viên',
};

/** Bảng nguồn của một khoản: cột riêng của khoản (tích chọn), không thì theo đề xuất. */
export function itemSourceOf(
  row: { cashflowSource?: string | null },
  s: { isMonthlyExpense?: boolean | null; cashflowSource?: string | null },
): CashflowSource {
  if (isCashflowSource(row.cashflowSource)) return row.cashflowSource;
  return cashflowSourceOf(s) ?? 'MANAGEMENT';
}

/** Năm học của kỳ tháng thật (tháng 8 trở đi thuộc năm học bắt đầu năm đó). */
export function schoolYearOfPeriod(period: {
  month?: number | null;
  year?: number | null;
}): string | null {
  const month = Number(period.month);
  const year = Number(period.year);
  if (!(month >= 1 && month <= 12) || !(year > 2000)) return null;
  return month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

/** Bảng nguồn của đề xuất; đề xuất chi tháng cũ (trống) là Chi Ngoài, chi Năm là null. */
export function cashflowSourceOf(s: {
  isMonthlyExpense?: boolean | null;
  cashflowSource?: string | null;
}): CashflowSource | null {
  if (!s.isMonthlyExpense) return null;
  return isCashflowSource(s.cashflowSource) ? s.cashflowSource : 'MANAGEMENT';
}

/**
 * Đề xuất ở các trạng thái này không còn giữ khoản chi: đã chi xong, bị từ
 * chối hoặc đã rút — khoản (nếu còn tiền phải chi) được đề xuất lại. Các
 * trạng thái khác (kể cả Chưa chi / Đã hoàn quỹ — Kế toán còn lập lại lệnh chi
 * được) vẫn giữ khoản để không chi hai lần.
 */
export const CASHFLOW_RELEASED_STATUSES = ['SPENT', 'REJECTED', 'WITHDRAWN'];
const PROPOSED_STATUSES = [
  'PENDING_APPROVAL',
  'PENDING_ACCOUNTING',
  'PENDING_ACCOUNTANT',
  'PENDING_CHIEF_APPROVAL',
];

export type CashflowItemStatus =
  | 'UNPAID'
  | 'PROPOSED'
  | 'APPROVED_WAITING'
  | 'PARTIAL'
  | 'PAID';

export interface CashflowItemRef {
  schoolId: number | null;
  expensePeriodId: number | null;
  subjectId?: number | null;
  schoolTeacherId?: number | null;
}

/** Khoá một khoản: trường + kỳ + môn, hoặc trường + kỳ + giáo viên. */
export function cashflowItemKey(
  source: CashflowSource,
  item: CashflowItemRef,
): string {
  const owner =
    source === 'SCHOOL_TEACHER'
      ? `t${item.schoolTeacherId ?? 0}`
      : `s${item.subjectId ?? 0}`;
  return `${item.schoolId ?? 0}:${item.expensePeriodId ?? 0}:${owner}`;
}

/** Một khoản như màn tạo đề xuất hiển thị. */
export interface CashflowGroup {
  key: string;
  source: CashflowSource;
  schoolId: number;
  schoolName: string | null;
  expensePeriodId: number;
  periodMonth: number | null;
  periodYear: number | null;
  periodName: string | null;
  schoolExpenseIds: number[];
  schoolYear: string | null;
  subjectId: number | null;
  subjectName: string | null;
  schoolTeacherId: number | null;
  teacherName: string | null;
  rowCount: number;
  /** Phải chi. */
  totalAmount: number;
  /** Đã chi (nhập tay + đề xuất). */
  paidAmount: number;
  /** Còn phải chi = tổng phần chưa chi của từng dòng (dòng chi dư không bù dòng khác). */
  remainingAmount: number;
  /** Kỳ đã "Kết thúc" ở QL thu chi. */
  finalized: boolean;
  /**
   * Chi Trường: phần của các dòng Hình thức chi "Có trong HĐ" — trường giữ lại
   * qua hoá đơn nên tính là đã chi, không đề xuất được (0 với bảng khác).
   */
  inContractAmount: number;
  /**
   * Chi Trường: phần chưa chi của các dòng chưa chọn Hình thức chi — chưa đề
   * xuất được tới khi chọn "Không có trong HĐ" (0 với bảng khác).
   */
  unsetPaymentTypeAmount: number;
}

export interface OpenCashflowRequest {
  key: string;
  suggestId: number;
  code: string | null;
  status: string;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Trạng thái khoản: đang có đề xuất giữ thì theo đề xuất (chờ duyệt / đã duyệt
 * chờ chi), không thì theo số tiền.
 */
export function cashflowItemStatus(
  group: { paidAmount: number; remainingAmount: number },
  open?: { status: string } | null,
): CashflowItemStatus {
  if (open) {
    return PROPOSED_STATUSES.includes(open.status)
      ? 'PROPOSED'
      : 'APPROVED_WAITING';
  }
  if (!(group.remainingAmount > 0)) return 'PAID';
  return group.paidAmount > 0 ? 'PARTIAL' : 'UNPAID';
}

export function periodLabelOf(group: {
  periodName?: string | null;
  periodMonth?: number | null;
  periodYear?: number | null;
}): string {
  if (group.periodName) return group.periodName;
  if (!group.periodMonth || !group.periodYear) return '';
  return group.periodMonth <= 12
    ? `Tháng ${group.periodMonth}/${group.periodYear}`
    : `Kỳ ${group.periodMonth}/${group.periodYear}`;
}

/** "TH A · Tin học · Tháng 9/2026" / "TH A · GV Nguyễn Văn B · Tháng 11/2026". */
export function cashflowGroupLabel(group: CashflowGroup): string {
  return [
    group.schoolName || `Trường #${group.schoolId}`,
    group.source === 'SCHOOL_TEACHER'
      ? `GV ${group.teacherName || `#${group.schoolTeacherId}`}`
      : group.subjectName,
    periodLabelOf(group),
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Đọc khoản từ QL thu chi
// ---------------------------------------------------------------------------

export interface CashflowGroupFilter {
  schoolIds: number[];
  periodIds?: number[];
  year?: number;
  month?: number;
}

function periodWhere(filter: CashflowGroupFilter, params: unknown[]): string {
  const parts = ['se.school_id = ANY($1)'];
  params.push(filter.schoolIds);
  if (filter.periodIds) {
    params.push(filter.periodIds);
    parts.push(`se.period_id = ANY($${params.length})`);
  }
  if (filter.year) {
    params.push(filter.year);
    parts.push(`p.year = $${params.length}`);
  }
  if (filter.month) {
    params.push(filter.month);
    parts.push(`p.month = $${params.length}`);
  }
  return parts.join(' AND ');
}

/** Hình thức chi "Có trong HĐ" của dòng Chi Trường (`school_expense_items.payment_type`). */
export const SCHOOL_PAYMENT_IN_CONTRACT = 'in_contract';
/**
 * Hình thức chi "Không có trong HĐ": 19/11/2026 (user) chỉ dòng Chi Trường này
 * kinh doanh mới đề xuất chi được; dòng chưa chọn Hình thức chi thì chưa.
 */
export const SCHOOL_PAYMENT_NOT_IN_CONTRACT = 'not_in_contract';

type GroupRow = {
  school_id: number;
  school_name: string | null;
  period_id: number;
  month: number | null;
  year: number | null;
  period_name: string | null;
  sheet_ids: number[];
  finalized: boolean;
  owner_id: number;
  owner_name: string | null;
  school_year: string | null;
  row_count: number;
  total: string;
  paid: string;
  remaining: string;
  in_contract?: string | null;
  unset_type?: string | null;
};

function toGroup(source: CashflowSource, row: GroupRow): CashflowGroup {
  const isTeacher = source === 'SCHOOL_TEACHER';
  const ref = {
    schoolId: Number(row.school_id),
    expensePeriodId: Number(row.period_id),
    subjectId: isTeacher ? null : Number(row.owner_id),
    schoolTeacherId: isTeacher ? Number(row.owner_id) : null,
  };
  return {
    key: cashflowItemKey(source, ref),
    source,
    ...ref,
    schoolName: row.school_name,
    periodMonth: row.month === null ? null : Number(row.month),
    periodYear: row.year === null ? null : Number(row.year),
    periodName: row.period_name,
    schoolExpenseIds: (row.sheet_ids ?? []).map(Number),
    schoolYear: row.school_year,
    subjectName: isTeacher ? null : row.owner_name,
    teacherName: isTeacher ? row.owner_name : null,
    rowCount: Number(row.row_count),
    totalAmount: round2(num(row.total)),
    paidAmount: round2(num(row.paid)),
    remainingAmount: round2(num(row.remaining)),
    finalized: !!row.finalized,
    inContractAmount: round2(num(row.in_contract)),
    unsetPaymentTypeAmount: round2(num(row.unset_type)),
  };
}

const SHEET_SELECT = `se.school_id, sc.name AS school_name, se.period_id,
  p.month, p.year, p.name AS period_name,
  array_agg(DISTINCT se.id) AS sheet_ids, bool_or(COALESCE(se.finalized, false)) AS finalized`;

const SHEET_JOINS = `JOIN school_expenses se ON se.id = t.school_expense_id
  JOIN schools sc ON sc.id = se.school_id
  JOIN expense_periods p ON p.id = se.period_id`;

/**
 * Chi Trường theo môn: Phải chi = Σ Tiền chi trường, Còn = Σ phần chưa chi của
 * từng dòng Hình thức chi "Không có trong HĐ" (chỉ dòng này đề xuất được).
 * Dòng "Có trong HĐ" tính đã chi đủ; dòng chưa chọn Hình thức chi chưa đề xuất
 * được (phần đó ở `unsetPaymentTypeAmount`).
 */
export async function loadSchoolExpenseGroups(
  manager: EntityManager,
  filter: CashflowGroupFilter,
): Promise<CashflowGroup[]> {
  if (!filter.schoolIds.length) return [];
  const params: unknown[] = [];
  const where = periodWhere(filter, params);
  const rows = await manager.query<GroupRow[]>(
    `SELECT ${SHEET_SELECT},
       t.subject_id AS owner_id,
       COALESCE(cat.name, sub.name) AS owner_name,
       sub.school_year,
       count(*)::int AS row_count,
       SUM(t."schoolExpenseAmount")::text AS total,
       SUM(CASE WHEN t.payment_type = '${SCHOOL_PAYMENT_IN_CONTRACT}'
                THEN t."schoolExpenseAmount" ELSE t."paidAmount" END)::text AS paid,
       SUM(CASE WHEN t.payment_type = '${SCHOOL_PAYMENT_NOT_IN_CONTRACT}'
                THEN GREATEST(t."schoolExpenseAmount" - t."paidAmount", 0) ELSE 0 END)::text AS remaining,
       SUM(CASE WHEN t.payment_type = '${SCHOOL_PAYMENT_IN_CONTRACT}'
                THEN t."schoolExpenseAmount" ELSE 0 END)::text AS in_contract,
       SUM(CASE WHEN t.payment_type IS DISTINCT FROM '${SCHOOL_PAYMENT_IN_CONTRACT}'
                 AND t.payment_type IS DISTINCT FROM '${SCHOOL_PAYMENT_NOT_IN_CONTRACT}'
                THEN GREATEST(t."schoolExpenseAmount" - t."paidAmount", 0) ELSE 0 END)::text AS unset_type
     FROM school_expense_items t
     ${SHEET_JOINS}
     JOIN subjects sub ON sub.id = t.subject_id
     LEFT JOIN subject_catalogs cat ON cat.id = sub.catalog_id
     WHERE ${where}
     GROUP BY se.school_id, sc.name, se.period_id, p.month, p.year, p.name,
       t.subject_id, cat.name, sub.name, sub.school_year
     HAVING SUM(t."schoolExpenseAmount") > 0`,
    params,
  );
  return rows.map((row) => toGroup('SCHOOL_EXPENSE', row));
}

/**
 * Dòng Giáo viên trường đã trả: đủ Ngày chi + Nguồn chi (nhập tay), hoặc đã có
 * đề xuất chi ghi vào.
 */
export const TEACHER_ROW_PAID = `((t.expense_date IS NOT NULL AND t.cash_account IS NOT NULL)
  OR EXISTS (SELECT 1 FROM school_teacher_suggest_payments sp
             WHERE sp.school_teacher_expense_item_id = t.id))`;

export interface UnassignedTeacherRows {
  schoolId: number;
  schoolName: string | null;
  expensePeriodId: number;
  periodMonth: number | null;
  periodYear: number | null;
  periodName: string | null;
  rowCount: number;
  amount: number;
}

/** Giáo viên trường theo giáo viên: Phải chi = Σ Còn lại phải chi (sau thuế TNCN). */
export async function loadSchoolTeacherGroups(
  manager: EntityManager,
  filter: CashflowGroupFilter,
): Promise<{ groups: CashflowGroup[]; unassigned: UnassignedTeacherRows[] }> {
  if (!filter.schoolIds.length) return { groups: [], unassigned: [] };
  const params: unknown[] = [];
  const where = periodWhere(filter, params);
  const rows = await manager.query<GroupRow[]>(
    `SELECT ${SHEET_SELECT},
       t.school_teacher_id AS owner_id,
       st.name AS owner_name,
       min(sub.school_year) AS school_year,
       count(*)::int AS row_count,
       SUM(t.net_amount)::text AS total,
       SUM(CASE WHEN ${TEACHER_ROW_PAID} THEN t.net_amount ELSE 0 END)::text AS paid,
       SUM(CASE WHEN ${TEACHER_ROW_PAID} THEN 0 ELSE t.net_amount END)::text AS remaining
     FROM school_teacher_expense_items t
     ${SHEET_JOINS}
     JOIN school_teachers st ON st.id = t.school_teacher_id
     LEFT JOIN subjects sub ON sub.id = t.subject_id
     WHERE ${where} AND t.net_amount > 0
     GROUP BY se.school_id, sc.name, se.period_id, p.month, p.year, p.name,
       t.school_teacher_id, st.name`,
    params,
  );
  // Dòng chưa chọn giáo viên chưa đề xuất được — báo để chọn ở QL thu chi.
  const unassigned = await manager.query<
    {
      school_id: number;
      school_name: string | null;
      period_id: number;
      month: number | null;
      year: number | null;
      period_name: string | null;
      row_count: number;
      amount: string;
    }[]
  >(
    `SELECT se.school_id, sc.name AS school_name, se.period_id, p.month, p.year,
       p.name AS period_name, count(*)::int AS row_count, SUM(t.net_amount)::text AS amount
     FROM school_teacher_expense_items t
     ${SHEET_JOINS}
     WHERE ${where} AND t.net_amount > 0 AND t.school_teacher_id IS NULL
       AND NOT ${TEACHER_ROW_PAID}
     GROUP BY se.school_id, sc.name, se.period_id, p.month, p.year, p.name`,
    params,
  );
  return {
    groups: rows.map((row) => toGroup('SCHOOL_TEACHER', row)),
    unassigned: unassigned.map((row) => ({
      schoolId: Number(row.school_id),
      schoolName: row.school_name,
      expensePeriodId: Number(row.period_id),
      periodMonth: row.month === null ? null : Number(row.month),
      periodYear: row.year === null ? null : Number(row.year),
      periodName: row.period_name,
      rowCount: Number(row.row_count),
      amount: round2(num(row.amount)),
    })),
  };
}

/**
 * Chi Ngoài theo môn từ bảng đã dựng như màn QL thu chi (đơn giá, Chi khác
 * theo chính sách đã duyệt) — Còn lại = tổng cột Còn chi, đúng số lệnh chi
 * Giám đốc duyệt (`monthlyItemAmounts`).
 */
export function managementGroupsFromSections(
  sections: ManagementViewSection[],
  periods: Map<
    number,
    { month: number | null; year: number | null; name: string | null }
  >,
): CashflowGroup[] {
  const groups = new Map<string, CashflowGroup>();
  for (const section of sections) {
    if (!section.schoolId || !section.periodId) continue;
    const ref = {
      schoolId: section.schoolId,
      expensePeriodId: section.periodId,
      subjectId: section.subjectId,
    };
    const key = cashflowItemKey('MANAGEMENT', ref);
    // Cùng số lệnh chi Giám đốc duyệt (tổng cột Còn chi của bảng).
    const rowRemaining = num(section.totals?.remaining);
    const current = groups.get(key);
    if (current) {
      current.schoolExpenseIds.push(section.schoolExpenseId);
      current.rowCount += section.rows.length;
      current.totalAmount = round2(
        current.totalAmount + num(section.totals?.totalOutside),
      );
      current.paidAmount = round2(
        current.paidAmount + num(section.totals?.paidAmount),
      );
      current.remainingAmount = round2(current.remainingAmount + rowRemaining);
      current.finalized = current.finalized || section.finalized;
      continue;
    }
    const period = periods.get(section.periodId);
    groups.set(key, {
      key,
      source: 'MANAGEMENT',
      ...ref,
      schoolTeacherId: null,
      schoolName: section.schoolName,
      periodMonth: period?.month ?? null,
      periodYear: period?.year ?? null,
      periodName: period?.name ?? section.periodName ?? null,
      schoolExpenseIds: [section.schoolExpenseId],
      schoolYear: section.schoolYear,
      subjectName: section.subjectName,
      teacherName: null,
      rowCount: section.rows.length,
      totalAmount: round2(num(section.totals?.totalOutside)),
      paidAmount: round2(num(section.totals?.paidAmount)),
      remainingAmount: round2(rowRemaining),
      finalized: section.finalized,
      inContractAmount: 0,
      unsetPaymentTypeAmount: 0,
    });
  }
  // Bảng không có tiền phải chi thì không phải khoản.
  return [...groups.values()].filter((group) => group.totalAmount > 0);
}

/**
 * Khoản đang nằm trong đề xuất chưa xong (cùng bảng nguồn — khoản của "Đề xuất
 * chi tháng" tích chọn theo bảng nguồn của từng khoản). Dòng Giám đốc
 * không duyệt hoặc kinh doanh báo không chi thì không còn giữ khoản. Đề xuất
 * chi tháng cũ chưa có dòng trường đọc từ các cột đơn của `suggest`.
 */
export async function loadOpenCashflowRequests(
  manager: EntityManager,
  source: CashflowSource,
  schoolIds: number[],
  excludeSuggestId?: number | null,
): Promise<OpenCashflowRequest[]> {
  if (!schoolIds.length) return [];
  const rows = await manager.query<
    {
      suggest_id: number;
      code: string | null;
      status: string;
      school_id: number | null;
      expense_period_id: number | null;
      subject_id: number | null;
      school_teacher_id: number | null;
    }[]
  >(
    `SELECT s.id AS suggest_id, s.code, s.status::text AS status,
       i.school_id, i.expense_period_id, i.subject_id, i.school_teacher_id
     FROM suggest_monthly_items i
     JOIN suggest s ON s.id = i.suggest_id
     WHERE s.type = 'EXPENSE_REQUEST' AND s.is_monthly_expense = true
       AND COALESCE(i.cashflow_source, s.cashflow_source, 'MANAGEMENT') = $1
       AND s.status::text <> ALL($2)
       AND i.excluded = false AND i.spent IS DISTINCT FROM false
       AND i.school_id = ANY($3)
       AND ($4::int IS NULL OR s.id <> $4)
     UNION ALL
     SELECT s.id, s.code, s.status::text, s.school_id, s.expense_period_id,
       s.subject_id, NULL
     FROM suggest s
     WHERE s.type = 'EXPENSE_REQUEST' AND s.is_monthly_expense = true
       AND COALESCE(s.cashflow_source, 'MANAGEMENT') = $1
       AND s.status::text <> ALL($2)
       AND s.school_id = ANY($3)
       AND ($4::int IS NULL OR s.id <> $4)
       AND NOT EXISTS (SELECT 1 FROM suggest_monthly_items i WHERE i.suggest_id = s.id)
     ORDER BY 1`,
    [source, CASHFLOW_RELEASED_STATUSES, schoolIds, excludeSuggestId ?? null],
  );
  return rows.map((row) => ({
    key: cashflowItemKey(source, {
      schoolId: row.school_id === null ? null : Number(row.school_id),
      expensePeriodId:
        row.expense_period_id === null ? null : Number(row.expense_period_id),
      subjectId: row.subject_id === null ? null : Number(row.subject_id),
      schoolTeacherId:
        row.school_teacher_id === null ? null : Number(row.school_teacher_id),
    }),
    suggestId: Number(row.suggest_id),
    code: row.code,
    status: row.status,
  }));
}

/**
 * Trường nhân viên phụ trách: trường được giao cho nhân viên kinh doanh, cộng
 * trường thuộc phường/xã gán cho hồ sơ giáo viên công ty của nhân viên đó —
 * cùng danh sách màn tạo đề xuất đang hiện.
 */
export async function actorSchoolIds(
  manager: EntityManager,
  employeeId: number,
): Promise<number[]> {
  const rows = await manager.query<{ id: number }[]>(
    `SELECT s.id FROM schools s WHERE s.employee_id = $1
     UNION
     SELECT s.id FROM schools s
       JOIN teacher_allowed_wards taw ON taw.ward_id = s.ward_id
       JOIN teachers t ON t.id = taw.teacher_id
     WHERE t.employee_id = $1`,
    [employeeId],
  );
  return rows.map((row) => Number(row.id));
}

/** Khoá giao dịch theo khoản để hai người không cùng tạo đề xuất cho một khoản. */
export async function lockCashflowKeys(
  manager: EntityManager,
  source: CashflowSource,
  keys: string[],
) {
  for (const key of [...new Set(keys)].sort()) {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `suggest-cashflow:${source}:${key}`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Ghi ngược khi kinh doanh xác nhận đã chi
// ---------------------------------------------------------------------------

export interface CashflowPaidRow {
  monthlyItemId: number;
  schoolId: number | null;
  expensePeriodId: number | null;
  subjectId: number | null;
  schoolTeacherId: number | null;
  approvedAmount: number | null;
  label: string;
}

/**
 * Nguồn chi khi ghi Đã chi: một tài khoản (cũ) hoặc hàm lấy tiền lần lượt từ
 * nhiều nguồn Thủ quỹ đã xuất (19/11/2026) — mỗi phần một tài khoản + số tiền.
 */
export type CashTaker = (amount: number) => { cashAccount: string | null; amount: number }[];
export type CashInput = string | null | CashTaker;

export const cashTakerOf = (cash: CashInput): CashTaker =>
  typeof cash === 'function'
    ? cash
    : (amount) => (amount > 0 ? [{ cashAccount: cash, amount: round2(amount) }] : []);

/** Gộp số tiền theo tài khoản (giữ thứ tự xuất hiện) — ghi vào lịch sử. */
export function sumByAccount(
  parts: { cashAccount: string | null; amount: number }[],
): { cashAccount: string | null; amount: number }[] {
  const result: { cashAccount: string | null; amount: number }[] = [];
  for (const part of parts) {
    const found = result.find((r) => r.cashAccount === part.cashAccount);
    if (found) found.amount = round2(found.amount + part.amount);
    else result.push({ ...part });
  }
  return result;
}

/** Ghi vào lịch sử đề xuất: phần đã ghi sang bảng Chi Trường / Giáo viên trường. */
export type CashflowPaymentLog =
  | { source: CashflowSource; table: string; skipped: string }
  | {
      source: CashflowSource;
      table: string;
      skipped?: undefined;
      paidDate: string;
      cashAccount: string | null;
      /** Nhiều nguồn chi: số tiền ghi theo từng tài khoản (có khi > 1 nguồn). */
      cashAccounts?: { cashAccount: string | null; amount: number }[];
      items: {
        monthlyItemId: number;
        label: string;
        amount: number;
        /** Phần không ghi được vào dòng nào (bảng đổi sau khi Giám đốc duyệt). */
        unallocated: number;
        rows: {
          itemId: number;
          schoolExpenseId: number;
          subjectId: number;
          rowIndex: number;
          amount: number;
          /** Nhiều nguồn chi: phần của từng tài khoản trong dòng. */
          cashAccounts?: { cashAccount: string | null; amount: number }[];
        }[];
      }[];
    };

/**
 * Khoá các bảng thu chi của các khoản theo thứ tự id — cùng khoá "Lưu" bảng
 * dùng, để không ghi lẫn khi có người đang lưu.
 */
async function lockSheets(
  manager: EntityManager,
  rows: CashflowPaidRow[],
): Promise<{ id: number; school_id: number; period_id: number }[]> {
  const sheets = await manager.query<
    { id: number; school_id: number; period_id: number }[]
  >(
    `SELECT id, school_id, period_id FROM school_expenses
     WHERE (school_id, period_id) IN (
       SELECT * FROM unnest($1::int[], $2::int[])
     )
     ORDER BY id FOR UPDATE`,
    [
      rows.map((row) => row.schoolId ?? 0),
      rows.map((row) => row.expensePeriodId ?? 0),
    ],
  );
  return sheets.map((sheet) => ({
    id: Number(sheet.id),
    school_id: Number(sheet.school_id),
    period_id: Number(sheet.period_id),
  }));
}

const sheetIdsOf = (
  sheets: { id: number; school_id: number; period_id: number }[],
  row: CashflowPaidRow,
) =>
  sheets
    .filter(
      (sheet) =>
        sheet.school_id === row.schoolId &&
        sheet.period_id === row.expensePeriodId,
    )
    .map((sheet) => sheet.id);

/** Dòng ghi từ hơn một nguồn chi: kèm số tiền từng nguồn. */
export const multiAccounts = (
  parts: { cashAccount: string | null; amount: number }[] | undefined,
) => {
  const grouped = sumByAccount(parts ?? []);
  return grouped.length > 1 ? { cashAccounts: grouped } : {};
};

function paymentLog(
  source: CashflowSource,
  paidDate: string,
  cash: CashInput,
  used: { cashAccount: string | null; amount: number }[],
  items: Extract<CashflowPaymentLog, { paidDate: string }>['items'],
): CashflowPaymentLog {
  const accounts = sumByAccount(used);
  return {
    source,
    table: CASHFLOW_TABLE_LABELS[source],
    paidDate,
    cashAccount:
      typeof cash === 'function' ? (accounts[0]?.cashAccount ?? null) : cash,
    ...(accounts.length > 1 ? { cashAccounts: accounts } : {}),
    items,
  };
}

const skippedSplit = (source: CashflowSource): CashflowPaymentLog => ({
  source,
  table: CASHFLOW_TABLE_LABELS[source],
  skipped: `Lệnh chi do Kế toán lập/sửa nên không chia được theo khoản — ${CASHFLOW_TABLE_LABELS[source]} không tự ghi, nhập tay ở QL thu chi`,
});

/**
 * Chi Trường: phần của khoản (lúc Giám đốc duyệt) chia cho các dòng của môn
 * theo thứ tự, mỗi dòng tối đa phần chưa chi; dư cộng dòng cuối (Còn lại âm
 * cho thấy chỗ lệch). Cột Đã chi của dòng là tổng tay + đề xuất, phần đề xuất
 * ghi thêm vào `school_expense_suggest_payments` (theo ID dòng).
 */
export async function recordSchoolExpenseSuggestPayments(
  manager: EntityManager,
  suggestId: number,
  rows: CashflowPaidRow[],
  paidDate: string,
  cash: CashInput,
): Promise<CashflowPaymentLog | null> {
  const take = cashTakerOf(cash);
  const used: { cashAccount: string | null; amount: number }[] = [];
  const partsByItem = new Map<number, { cashAccount: string | null; amount: number }[]>();
  if (!rows.length) return null;
  if (
    rows.some(
      (row) => row.approvedAmount === null || row.approvedAmount === undefined,
    )
  ) {
    return skippedSplit('SCHOOL_EXPENSE');
  }
  const sheets = await lockSheets(manager, rows);
  const items: Extract<CashflowPaymentLog, { paidDate: string }>['items'] = [];
  for (const row of rows) {
    const amount = round2(num(row.approvedAmount));
    const sheetIds = sheetIdsOf(sheets, row);
    if (!(amount > 0) || !row.subjectId) continue;
    const lines = sheetIds.length
      ? await manager.query<
          {
            id: number;
            school_expense_id: number;
            row_index: number;
            amount: string;
            paid: string;
          }[]
        >(
          // Chỉ dòng "Không có trong HĐ" mới đề xuất được — ghi Đã chi vào đó.
          `SELECT id, school_expense_id, "rowIndex" AS row_index,
             "schoolExpenseAmount"::text AS amount, "paidAmount"::text AS paid
           FROM school_expense_items
           WHERE school_expense_id = ANY($1) AND subject_id = $2
             AND payment_type = '${SCHOOL_PAYMENT_NOT_IN_CONTRACT}'
           ORDER BY school_expense_id, "rowIndex", id`,
          [sheetIds, row.subjectId],
        )
      : [];
    const { allocations, unallocated } = allocateSuggestPayment(
      lines.map((line) => ({
        itemId: Number(line.id),
        remaining: num(line.amount) - num(line.paid),
      })),
      amount,
    );
    for (const allocation of allocations) {
      await manager.query(
        `UPDATE school_expense_items
         SET "paidAmount" = "paidAmount" + $2,
             "remaining" = "schoolExpenseAmount" - "paidAmount" - $2
         WHERE id = $1`,
        [allocation.itemId, allocation.amount],
      );
      // Nhiều nguồn chi: mỗi nguồn của dòng một bản ghi riêng (thống kê riêng).
      const parts = take(allocation.amount);
      partsByItem.set(allocation.itemId, parts);
      used.push(...parts);
      for (const part of parts) {
        await manager.query(
          `INSERT INTO school_expense_suggest_payments
             (school_expense_item_id, suggest_id, suggest_monthly_item_id,
              amount, paid_date, cash_account)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            allocation.itemId,
            suggestId,
            row.monthlyItemId,
            part.amount,
            paidDate,
            part.cashAccount,
          ],
        );
      }
    }
    items.push({
      monthlyItemId: row.monthlyItemId,
      label: row.label,
      amount,
      unallocated,
      rows: allocations.map((allocation) => {
        const line = lines.find((l) => Number(l.id) === allocation.itemId)!;
        return {
          itemId: allocation.itemId,
          schoolExpenseId: Number(line.school_expense_id),
          subjectId: row.subjectId!,
          rowIndex: Number(line.row_index),
          amount: allocation.amount,
          ...multiAccounts(partsByItem.get(allocation.itemId)),
        };
      }),
    });
  }
  return paymentLog('SCHOOL_EXPENSE', paidDate, cash, used, items);
}

/**
 * Giáo viên trường: dòng lương không trả một phần được — trả lần lượt các dòng
 * chưa trả của giáo viên (mọi môn) khi phần của khoản còn đủ cho cả dòng; ghi
 * Ngày chi + Nguồn chi vào dòng và lưu liên kết (theo ID dòng). Phần không đủ
 * cho dòng nào nữa (bảng đổi sau khi duyệt) ghi vào lịch sử.
 */
export async function recordSchoolTeacherSuggestPayments(
  manager: EntityManager,
  suggestId: number,
  rows: CashflowPaidRow[],
  paidDate: string,
  cash: CashInput,
): Promise<CashflowPaymentLog | null> {
  const take = cashTakerOf(cash);
  const used: { cashAccount: string | null; amount: number }[] = [];
  if (!rows.length) return null;
  if (
    rows.some(
      (row) => row.approvedAmount === null || row.approvedAmount === undefined,
    )
  ) {
    return skippedSplit('SCHOOL_TEACHER');
  }
  const sheets = await lockSheets(manager, rows);
  const items: Extract<CashflowPaymentLog, { paidDate: string }>['items'] = [];
  for (const row of rows) {
    const amount = round2(num(row.approvedAmount));
    const sheetIds = sheetIdsOf(sheets, row);
    if (!(amount > 0) || !row.schoolTeacherId) continue;
    const lines = sheetIds.length
      ? await manager.query<
          {
            id: number;
            school_expense_id: number;
            subject_id: number;
            row_index: number;
            net: string;
          }[]
        >(
          `SELECT t.id, t.school_expense_id, t.subject_id, t.row_index, t.net_amount::text AS net
           FROM school_teacher_expense_items t
           WHERE t.school_expense_id = ANY($1) AND t.school_teacher_id = $2
             AND t.net_amount > 0 AND NOT ${TEACHER_ROW_PAID}
           ORDER BY t.school_expense_id, t.subject_id, t.row_index, t.id
           FOR UPDATE OF t`,
          [sheetIds, row.schoolTeacherId],
        )
      : [];
    let left = amount;
    const paid: Extract<
      CashflowPaymentLog,
      { paidDate: string }
    >['items'][number]['rows'] = [];
    for (const line of lines) {
      const net = round2(num(line.net));
      if (net > left + 0.005) continue;
      // Nhiều nguồn chi: ô Nguồn chi của dòng = nguồn đầu tiên, mỗi nguồn một
      // bản ghi liên kết riêng (thống kê riêng).
      const parts = take(net);
      used.push(...parts);
      await manager.query(
        `UPDATE school_teacher_expense_items
         SET expense_date = $2, cash_account = $3
         WHERE id = $1`,
        [line.id, paidDate, parts[0]?.cashAccount ?? null],
      );
      for (const part of parts) {
        await manager.query(
          `INSERT INTO school_teacher_suggest_payments
             (school_teacher_expense_item_id, suggest_id, suggest_monthly_item_id,
              amount, paid_date, cash_account)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [line.id, suggestId, row.monthlyItemId, part.amount, paidDate, part.cashAccount],
        );
      }
      left = round2(left - net);
      paid.push({
        itemId: Number(line.id),
        schoolExpenseId: Number(line.school_expense_id),
        subjectId: Number(line.subject_id),
        rowIndex: Number(line.row_index),
        amount: net,
        ...multiAccounts(parts),
      });
    }
    items.push({
      monthlyItemId: row.monthlyItemId,
      label: row.label,
      amount,
      unallocated: Math.max(0, left),
      rows: paid,
    });
  }
  return paymentLog('SCHOOL_TEACHER', paidDate, cash, used, items);
}
