import type { EntityManager } from 'typeorm';

/**
 * Hỗ trợ tiền mặt (`httienmat`) và hỗ trợ thiết bị (`htthietbi`) trong chính
 * sách đã duyệt của các môn một trường trong một năm học — kinh doanh chỉ tạo
 * được Đề xuất chi Năm cho trường khi một trong hai có số tiền (16/11/2026).
 */

export interface PolicyCashSupportRow {
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

export interface PolicyEquipmentSupportRow {
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
}

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

/** Chính sách đã được Giám đốc duyệt (bản mới nhất của mỗi môn). */
export async function loadPolicySupport(
  manager: EntityManager,
  schoolId: number,
  schoolYear: string,
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
    for (const item of asItems(data.httienmat)) {
      const money = num(item.money ?? item.amount);
      if (money <= 0) continue;
      cash.push({
        ...base,
        type: text(item.type),
        money,
        depreciationYears: num(item.depreciationYears ?? 1),
        months: num(item.months),
        periods: num(item.periods),
        students: num(item.students),
        realStudents: num(item.realStudents),
        realPeriods: num(item.realPeriods),
        actualAmount: cashSupportActualAmount(item, mode),
      });
    }
    for (const item of asItems(data.htthietbi)) {
      const amount = equipmentSupportAmount(item);
      if (amount <= 0) continue;
      equipment.push({
        ...base,
        category: text(item.category ?? item.name),
        qty: num(item.qty),
        price: num(item.price),
        amount,
        months: num(item.months),
        depreciationYears: num(item.depreciationYears ?? 1),
      });
    }
  }

  const sum = (values: number[]) =>
    Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
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
  };
}
