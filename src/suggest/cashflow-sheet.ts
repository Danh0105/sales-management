import type { EntityManager } from 'typeorm';

import {
  SCHOOL_PAYMENT_IN_CONTRACT,
  TEACHER_ROW_PAID,
  type CashflowSource,
} from './cashflow-sources';

/**
 * Từng dòng Kế toán đã nhập ở bảng Chi Trường / Giáo viên trường của một
 * trường trong một kỳ — màn tạo đề xuất hiện cho kinh doanh xem (Chi Ngoài
 * dùng bảng dựng sẵn `buildManagementViewSections`).
 */

export interface SchoolExpenseSheetRow {
  id: number;
  rowIndex: number;
  subjectId: number;
  subjectName: string | null;
  totalPeriods: number;
  studentCount: number;
  monthsCount: number;
  teacherUnitPrice: number;
  taxUnitPrice: number;
  csvcUnitPrice: number;
  teacherAmount: number;
  taxAmount: number;
  csvcAmount: number;
  schoolExpenseAmount: number;
  /** Hình thức chi: in_contract (Có trong HĐ) / not_in_contract / trống. */
  paymentType: string | null;
  inContract: boolean;
  expenseDate: string | null;
  cashAccount: string | null;
  paidAmount: number;
  remaining: number;
  /** Còn đề xuất được: dòng "Có trong HĐ" = 0. */
  proposableAmount: number;
  payer: string | null;
  note: string | null;
  suggestCodes: string | null;
}

export interface SchoolTeacherSheetRow {
  id: number;
  rowIndex: number;
  subjectId: number | null;
  subjectName: string | null;
  schoolTeacherId: number | null;
  teacherName: string | null;
  content: string | null;
  totalPeriods: number;
  studentCount: number;
  monthsCount: number;
  unitPrice: number;
  amount: number;
  pitRate: number;
  pitAmount: number;
  netAmount: number;
  expenseDate: string | null;
  cashAccount: string | null;
  paid: boolean;
  note: string | null;
  suggestCodes: string | null;
}

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const dateOnly = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

export async function loadSheetRows(
  manager: EntityManager,
  source: Exclude<CashflowSource, 'MANAGEMENT'>,
  schoolId: number,
  periodId: number,
): Promise<SchoolExpenseSheetRow[] | SchoolTeacherSheetRow[]> {
  if (source === 'SCHOOL_EXPENSE') {
    const rows = await manager.query<Record<string, unknown>[]>(
      `SELECT t.id, t."rowIndex" AS row_index, t.subject_id,
         COALESCE(cat.name, sub.name) AS subject_name,
         t."totalPeriods" AS total_periods, t."studentCount" AS student_count,
         t."monthsCount" AS months_count, t.teacher_unit_price, t.tax_unit_price,
         t.csvc AS csvc_unit_price, t."teacherAmount" AS teacher_amount,
         t."taxAmount" AS tax_amount, t."csvcAmount" AS csvc_amount,
         t."schoolExpenseAmount" AS school_expense_amount, t.payment_type,
         t."expenseDate" AS expense_date, t."cashAccount" AS cash_account,
         t."paidAmount" AS paid_amount, t.remaining, t.payer, t.note,
         (SELECT string_agg(DISTINCT s.code, ', ')
            FROM school_expense_suggest_payments sp JOIN suggest s ON s.id = sp.suggest_id
           WHERE sp.school_expense_item_id = t.id) AS suggest_codes
       FROM school_expense_items t
       JOIN school_expenses se ON se.id = t.school_expense_id
       LEFT JOIN subjects sub ON sub.id = t.subject_id
       LEFT JOIN subject_catalogs cat ON cat.id = sub.catalog_id
       WHERE se.school_id = $1 AND se.period_id = $2
       ORDER BY COALESCE(cat.name, sub.name), t."rowIndex", t.id`,
      [schoolId, periodId],
    );
    return rows.map((row) => {
      const inContract = row.payment_type === SCHOOL_PAYMENT_IN_CONTRACT;
      const amount = num(row.school_expense_amount);
      const paid = num(row.paid_amount);
      return {
        id: Number(row.id),
        rowIndex: num(row.row_index),
        subjectId: Number(row.subject_id),
        subjectName: (row.subject_name as string) ?? null,
        totalPeriods: num(row.total_periods),
        studentCount: num(row.student_count),
        monthsCount: num(row.months_count),
        teacherUnitPrice: num(row.teacher_unit_price),
        taxUnitPrice: num(row.tax_unit_price),
        csvcUnitPrice: num(row.csvc_unit_price),
        teacherAmount: num(row.teacher_amount),
        taxAmount: num(row.tax_amount),
        csvcAmount: num(row.csvc_amount),
        schoolExpenseAmount: amount,
        paymentType: (row.payment_type as string) ?? null,
        inContract,
        expenseDate: dateOnly(row.expense_date),
        cashAccount: (row.cash_account as string) ?? null,
        paidAmount: paid,
        remaining: num(row.remaining),
        proposableAmount: inContract ? 0 : Math.max(0, Math.round((amount - paid) * 100) / 100),
        payer: (row.payer as string) ?? null,
        note: (row.note as string) ?? null,
        suggestCodes: (row.suggest_codes as string) ?? null,
      };
    });
  }

  const rows = await manager.query<Record<string, unknown>[]>(
    `SELECT t.id, t.row_index, t.subject_id, COALESCE(cat.name, sub.name) AS subject_name,
       t.school_teacher_id, st.name AS teacher_name, t.content, t.total_periods,
       t.student_count, t.months_count, t.unit_price, t.amount, t.pit_rate,
       t.pit_amount, t.net_amount, t.expense_date, t.cash_account, t.note,
       (SELECT string_agg(DISTINCT s.code, ', ')
          FROM school_teacher_suggest_payments sp JOIN suggest s ON s.id = sp.suggest_id
         WHERE sp.school_teacher_expense_item_id = t.id) AS suggest_codes,
       ${TEACHER_ROW_PAID} AS paid
     FROM school_teacher_expense_items t
     JOIN school_expenses se ON se.id = t.school_expense_id
     LEFT JOIN subjects sub ON sub.id = t.subject_id
     LEFT JOIN subject_catalogs cat ON cat.id = sub.catalog_id
     LEFT JOIN school_teachers st ON st.id = t.school_teacher_id
     WHERE se.school_id = $1 AND se.period_id = $2
     ORDER BY st.name NULLS LAST, COALESCE(cat.name, sub.name), t.row_index, t.id`,
    [schoolId, periodId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    rowIndex: num(row.row_index),
    subjectId: row.subject_id === null ? null : Number(row.subject_id),
    subjectName: (row.subject_name as string) ?? null,
    schoolTeacherId: row.school_teacher_id === null ? null : Number(row.school_teacher_id),
    teacherName: (row.teacher_name as string) ?? null,
    content: (row.content as string) ?? null,
    totalPeriods: num(row.total_periods),
    studentCount: num(row.student_count),
    monthsCount: num(row.months_count),
    unitPrice: num(row.unit_price),
    amount: num(row.amount),
    pitRate: num(row.pit_rate),
    pitAmount: num(row.pit_amount),
    netAmount: num(row.net_amount),
    expenseDate: dateOnly(row.expense_date),
    cashAccount: (row.cash_account as string) ?? null,
    paid: row.paid === true,
    note: (row.note as string) ?? null,
    suggestCodes: (row.suggest_codes as string) ?? null,
  }));
}
