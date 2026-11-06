import { toNumber } from '../school-expenses/expense-calculations';

/**
 * Bảng Chi Ngoài dạng chỉ đọc cho màn duyệt đề xuất chi và cây lịch sử.
 * Công thức giữ đúng như màn Quản lý thu chi (ManagementExpenseRow): tính lại từ
 * đơn giá, không dùng `totalOutside` đã lưu vì dòng cũ có thể theo công thức cũ.
 */
export interface ManagementViewOtherCost {
  key: string;
  name: string;
  unitPrice: number;
  tax: number;
  expense: number;
}

export interface ManagementViewRow {
  rowIndex: number;
  content: string;
  standalone: boolean;
  totalPeriods: number;
  studentCount: number;
  monthsCount: number;
  ql1UnitPrice: number;
  ql1Tax: number;
  ql1Expense: number;
  ql2UnitPrice: number;
  ql2Tax: number;
  ql2Expense: number;
  otherCosts: ManagementViewOtherCost[];
  totalOutside: number;
  paymentDate: string | null;
  cashAccount: string | null;
  paidAmount: number;
  remaining: number;
  payer: string | null;
  note: string | null;
}

export interface ManagementViewSection {
  schoolExpenseId: number;
  periodId: number | null;
  periodName: string;
  subjectId: number;
  subjectName: string;
  schoolYear: string | null;
  confirmed: boolean;
  finalized: boolean;
  otherCostColumns: { key: string; name: string }[];
  rows: ManagementViewRow[];
  totals: {
    ql1Expense: number;
    ql2Expense: number;
    otherCostExpenses: Record<string, number>;
    totalOutside: number;
    paidAmount: number;
    remaining: number;
  };
}

const STANDALONE_CONTENT = 'Chi ngoài bổ sung';

const otherCostKey = (cost: any, index: number) =>
  cost?.policyOtherCostId != null
    ? `policy:${cost.policyOtherCostId}`
    : `name:${(cost?.name ?? '').trim() || index}`;

const periodLabel = (period: any) =>
  period?.name ||
  (period?.month && period?.year
    ? `Tháng ${period.month}/${period.year}`
    : 'Không rõ kỳ');

const dateOnly = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

function buildRow(item: any, revenue: any): ManagementViewRow {
  // Dòng đi kèm Doanh Thu dùng chung Nội dung và số lượng của Doanh Thu; dòng
  // thêm riêng tự giữ các trường này.
  const shared = revenue ?? item;
  const totalPeriods = toNumber(shared?.totalPeriods, 0);
  const studentCount = toNumber(shared?.studentCount, 0);
  const monthsCount = toNumber(shared?.monthsCount, 0);
  const quantity = (studentCount > 0 ? studentCount : totalPeriods) * monthsCount;

  const ql1UnitPrice = toNumber(item?.ql1UnitPrice, 0);
  const ql1Tax = toNumber(item?.ql1Tax, 0);
  const ql2UnitPrice = toNumber(item?.ql2UnitPrice, 0);
  const ql2Tax = toNumber(item?.ql2Tax, 0);
  const ql1Expense = Math.max(0, ql1UnitPrice - ql1Tax) * quantity;
  const ql2Expense = Math.max(0, ql2UnitPrice - ql2Tax) * quantity;

  const otherCosts = (item?.otherCosts ?? []).map(
    (cost: any, index: number): ManagementViewOtherCost => {
      const unitPrice = toNumber(cost?.unitPrice, 0);
      const tax = toNumber(cost?.tax, 0);
      return {
        key: otherCostKey(cost, index),
        name: cost?.name?.trim() || `Chi khác ${index + 1}`,
        unitPrice,
        tax,
        expense: Math.max(0, unitPrice - tax) * quantity,
      };
    },
  );
  const totalOutside =
    ql1Expense +
    ql2Expense +
    otherCosts.reduce(
      (sum: number, cost: ManagementViewOtherCost) => sum + cost.expense,
      0,
    );
  const paidAmount = toNumber(item?.paidAmount, 0);

  return {
    rowIndex: toNumber(item?.rowIndex, 0),
    content: revenue
      ? (revenue.content ?? '')
      : (item?.content ?? STANDALONE_CONTENT),
    standalone: !revenue,
    totalPeriods,
    studentCount,
    monthsCount,
    ql1UnitPrice,
    ql1Tax,
    ql1Expense,
    ql2UnitPrice,
    ql2Tax,
    ql2Expense,
    otherCosts,
    totalOutside,
    paymentDate: dateOnly(item?.expenseDate),
    cashAccount: item?.cashAccount ?? null,
    paidAmount,
    remaining: totalOutside - paidAmount,
    payer: item?.payer ?? null,
    note: item?.note ?? null,
  };
}

/**
 * Mỗi kỳ + môn là một bảng. Đề xuất tháng chỉ lấy đúng môn của đề xuất; đề xuất
 * năm lấy mọi môn thuộc năm học của đề xuất. Kỳ mới nhất đứng trước.
 */
export function buildManagementViewSections(
  sheets: any[],
  filter: { schoolYear?: string | null; subjectId?: number | null },
): ManagementViewSection[] {
  const sections: ManagementViewSection[] = [];
  const ordered = [...sheets].sort(
    (a, b) =>
      toNumber(b?.period?.year) - toNumber(a?.period?.year) ||
      toNumber(b?.period?.month) - toNumber(a?.period?.month) ||
      toNumber(b?.id) - toNumber(a?.id),
  );

  for (const sheet of ordered) {
    const bySubject = new Map<number, any[]>();
    for (const item of sheet?.managementExpenseItems ?? []) {
      const subject = item?.subject;
      if (!subject?.id) continue;
      if (filter.subjectId && subject.id !== filter.subjectId) continue;
      if (filter.schoolYear && subject.schoolYear !== filter.schoolYear) continue;
      bySubject.set(subject.id, [...(bySubject.get(subject.id) ?? []), item]);
    }

    for (const items of bySubject.values()) {
      const subject = items[0].subject;
      const revenueByRow = new Map<number, any>();
      for (const revenue of sheet?.revenueItems ?? []) {
        if (revenue?.subject?.id === subject.id) {
          revenueByRow.set(toNumber(revenue.rowIndex, 0), revenue);
        }
      }
      const rows = items
        .map((item) =>
          buildRow(item, revenueByRow.get(toNumber(item?.rowIndex, 0))),
        )
        .sort((a, b) => a.rowIndex - b.rowIndex);

      const otherCostColumns = new Map<string, string>();
      const otherCostExpenses: Record<string, number> = {};
      for (const row of rows) {
        for (const cost of row.otherCosts) {
          if (!otherCostColumns.has(cost.key)) {
            otherCostColumns.set(cost.key, cost.name);
          }
          otherCostExpenses[cost.key] =
            (otherCostExpenses[cost.key] ?? 0) + cost.expense;
        }
      }
      const sum = (pick: (row: ManagementViewRow) => number) =>
        rows.reduce((total, row) => total + pick(row), 0);

      sections.push({
        schoolExpenseId: sheet.id,
        periodId: sheet?.period?.id ?? null,
        periodName: periodLabel(sheet?.period),
        subjectId: subject.id,
        subjectName: subject.catalog?.name || subject.name || `Môn #${subject.id}`,
        schoolYear: subject.schoolYear ?? null,
        confirmed: !!sheet?.managementExpenseConfirmed,
        finalized: !!sheet?.finalized,
        otherCostColumns: [...otherCostColumns].map(([key, name]) => ({
          key,
          name,
        })),
        rows,
        totals: {
          ql1Expense: sum((row) => row.ql1Expense),
          ql2Expense: sum((row) => row.ql2Expense),
          otherCostExpenses,
          totalOutside: sum((row) => row.totalOutside),
          paidAmount: sum((row) => row.paidAmount),
          remaining: sum((row) => row.remaining),
        },
      });
    }
  }
  return sections;
}
