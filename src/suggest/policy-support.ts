import type { EntityManager } from 'typeorm';

/**
 * Hỗ trợ tiền mặt (`httienmat`) và hỗ trợ thiết bị (`htthietbi`) trong chính
 * sách đã duyệt của các môn một trường trong một năm học — kinh doanh chỉ tạo
 * được Đề xuất chi Năm cho trường khi một trong hai có số tiền (16/11/2026).
 */

/** Đã chi / đang đề xuất / còn lại của một dòng hỗ trợ (theo các đề xuất chi Năm đã tích dòng đó). */
export interface PolicySupportUsage {
  /** `policyId:CASH|EQUIPMENT:itemIndex`. */
  rowKey: string;
  /** Vị trí dòng trong `httienmat` / `htthietbi`. */
  itemIndex: number;
  /** Mốc tối đa đề xuất được: tiền mặt = Thành tiền thực tế, thiết bị = Thành tiền. */
  capAmount: number;
  /** Đề xuất đã hoàn thành ghi vào. */
  spentAmount: number;
  /** Đề xuất khác chưa xong đang giữ. */
  heldAmount: number;
  /** capAmount − spentAmount − heldAmount (không âm). */
  remainingAmount: number;
}

export interface PolicyCashSupportRow extends PolicySupportUsage {
  policyId: number;
  subjectId: number;
  subjectName: string | null;
  type: string | null;
  /** Số tiền chính sách gốc. */
  money: number;
  depreciationYears: number;
  months: number;
  periods: number;
  students: number;
  realStudents: number;
  realPeriods: number;
  /** Thành tiền thực tế — số chạy về QL thu chi (cùng công thức FE `getCashSupportActualAmount`). */
  actualAmount: number;
}

export interface PolicyEquipmentSupportRow extends PolicySupportUsage {
  policyId: number;
  subjectId: number;
  subjectName: string | null;
  category: string | null;
  qty: number;
  price: number;
  amount: number;
  months: number;
  depreciationYears: number;
}

export interface PolicySupport {
  schoolId: number;
  schoolYear: string;
  cash: PolicyCashSupportRow[];
  equipment: PolicyEquipmentSupportRow[];
  cashTotal: number;
  cashActualTotal: number;
  equipmentTotal: number;
  hasCash: boolean;
  hasEquipment: boolean;
  /** Tổng Đã chi / Còn lại của mọi dòng (tiền mặt + thiết bị). */
  spentTotal: number;
  remainingTotal: number;
}

export const policySupportRowKey = (
  policyId: number,
  type: 'CASH' | 'EQUIPMENT',
  itemIndex: number,
) => `${policyId}:${type}:${itemIndex}`;

/**
 * Đề xuất ở các trạng thái này không còn giữ phần của dòng: đã hoàn thành
 * (phần đã ghi nằm ở `spent_amount`), bị từ chối hoặc đã rút.
 */
export const POLICY_SUPPORT_RELEASED_STATUSES = [
  'SPENT',
  'REPAIR_ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
];

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

// Mốc mặc định của form chính sách (MoneyForm) — khớp FE utils/cashSupport.ts.
const DEFAULT_STUDENTS = 1000;
const DEFAULT_MONTHS = 9;
const DEFAULT_PERIODS = 36;

export function cashSupportActualAmount(
  item: Record<string, unknown>,
  mode?: string | null,
): number {
  const money = num(item.money ?? item.amount);
  const depreciationYears = num(item.depreciationYears ?? 1);
  if (money <= 0 || depreciationYears <= 0) return 0;
  const depreciated = money / depreciationYears;
  const realStudents = num(item.realStudents) || num(item.students);
  if (mode === 'TIET') {
    const realPeriods = num(item.realPeriods) || num(item.periods);
    return realStudents > 0 && realPeriods > 0
      ? Math.round(
          (depreciated / DEFAULT_STUDENTS / DEFAULT_PERIODS) *
            realStudents *
            realPeriods,
        )
      : 0;
  }
  const months = num(item.months);
  return realStudents > 0 && months > 0
    ? Math.round(
        (depreciated / DEFAULT_STUDENTS / DEFAULT_MONTHS) * realStudents * months,
      )
    : 0;
}

export function equipmentSupportAmount(item: Record<string, unknown>): number {
  const explicit = num(item.totalAmount ?? item.total ?? item.amount);
  return explicit || num(item.qty) * num(item.price);
}

const asItems = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object',
      )
    : [];

/**
 * Chính sách đã được Giám đốc duyệt (bản mới nhất của mỗi môn), kèm Đã chi /
 * đang đề xuất / còn lại của từng dòng. `excludeSuggestId`: đang sửa đề xuất
 * đó — phần của chính nó không tính là đang bị giữ.
 */
export async function loadPolicySupport(
  manager: EntityManager,
  schoolId: number,
  schoolYear: string,
  excludeSuggestId: number | null = null,
): Promise<PolicySupport> {
  const rows = await manager.query<
    {
      policy_id: number;
      subject_id: number;
      subject_name: string | null;
      data: Record<string, unknown> | null;
    }[]
  >(
    `SELECT DISTINCT ON (p."subjectId")
       p.id AS policy_id, p."subjectId" AS subject_id,
       COALESCE(cat.name, sub.name) AS subject_name, p.data::jsonb AS data
     FROM policy p
     JOIN subjects sub ON sub.id = p."subjectId"
     LEFT JOIN subject_catalogs cat ON cat.id = sub.catalog_id
     WHERE sub.school_id = $1 AND sub.school_year = $2
       AND p.status = 'DIRECTOR_APPROVED'
     ORDER BY p."subjectId", p.updated_at DESC, p.id DESC`,
    [schoolId, schoolYear],
  );

  const usageRows = rows.length
    ? await manager.query<
        { policy_id: number; support_type: string; item_index: number; spent: string; held: string }[]
      >(
        `SELECT i.policy_id, i.support_type, i.item_index,
           SUM(COALESCE(i.spent_amount, 0))::text AS spent,
           SUM(CASE WHEN i.spent_amount IS NULL AND s.status::text <> ALL($2)
                    THEN i.amount ELSE 0 END)::text AS held
         FROM suggest_policy_support_items i
         JOIN suggest s ON s.id = i.suggest_id
         WHERE i.policy_id = ANY($1) AND ($3::int IS NULL OR i.suggest_id <> $3)
         GROUP BY i.policy_id, i.support_type, i.item_index`,
        [
          rows.map((row) => Number(row.policy_id)),
          POLICY_SUPPORT_RELEASED_STATUSES,
          excludeSuggestId,
        ],
      )
    : [];
  const usage = new Map(
    usageRows.map((row) => [
      policySupportRowKey(Number(row.policy_id), row.support_type as 'CASH' | 'EQUIPMENT', Number(row.item_index)),
      { spent: num(row.spent), held: num(row.held) },
    ]),
  );
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const usageOf = (
    policyId: number,
    type: 'CASH' | 'EQUIPMENT',
    itemIndex: number,
    capAmount: number,
  ): PolicySupportUsage => {
    const rowKey = policySupportRowKey(policyId, type, itemIndex);
    const used = usage.get(rowKey) ?? { spent: 0, held: 0 };
    return {
      rowKey,
      itemIndex,
      capAmount,
      spentAmount: round2(used.spent),
      heldAmount: round2(used.held),
      remainingAmount: round2(Math.max(0, capAmount - used.spent - used.held)),
    };
  };

  const cash: PolicyCashSupportRow[] = [];
  const equipment: PolicyEquipmentSupportRow[] = [];
  for (const row of rows) {
    const data = row.data ?? {};
    const mode = text(data.mode);
    const base = {
      policyId: Number(row.policy_id),
      subjectId: Number(row.subject_id),
      subjectName: row.subject_name,
    };
    // Vị trí giữ theo mảng gốc (kể cả dòng 0 đồng bị ẩn) để định danh dòng.
    asItems(data.httienmat).forEach((item, itemIndex) => {
      const money = num(item.money ?? item.amount);
      if (money <= 0) return;
      const actualAmount = cashSupportActualAmount(item, mode);
      cash.push({
        ...base,
        ...usageOf(base.policyId, 'CASH', itemIndex, actualAmount),
        type: text(item.type),
        money,
        depreciationYears: num(item.depreciationYears ?? 1),
        months: num(item.months),
        periods: num(item.periods),
        students: num(item.students),
        realStudents: num(item.realStudents),
        realPeriods: num(item.realPeriods),
        actualAmount,
      });
    });
    asItems(data.htthietbi).forEach((item, itemIndex) => {
      const amount = equipmentSupportAmount(item);
      if (amount <= 0) return;
      equipment.push({
        ...base,
        ...usageOf(base.policyId, 'EQUIPMENT', itemIndex, amount),
        category: text(item.category ?? item.name),
        qty: num(item.qty),
        price: num(item.price),
        amount,
        months: num(item.months),
        depreciationYears: num(item.depreciationYears ?? 1),
      });
    });
  }

  const sum = (values: number[]) =>
    round2(values.reduce((total, value) => total + value, 0));
  const allRows: PolicySupportUsage[] = [...cash, ...equipment];
  return {
    schoolId,
    schoolYear,
    cash,
    equipment,
    cashTotal: sum(cash.map((row) => row.money)),
    cashActualTotal: sum(cash.map((row) => row.actualAmount)),
    equipmentTotal: sum(equipment.map((row) => row.amount)),
    hasCash: cash.length > 0,
    hasEquipment: equipment.length > 0,
    spentTotal: sum(allRows.map((row) => row.spentAmount)),
    remainingTotal: sum(allRows.map((row) => row.remainingAmount)),
  };
}
