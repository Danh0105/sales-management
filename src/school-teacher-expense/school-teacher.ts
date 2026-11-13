import { BadRequestException } from '@nestjs/common';

import {
  assertNonNegative,
  normalizeCashAccount,
  normalizeSharedFields,
  revenueBillingQuantity,
  toNumber,
} from '../school-expenses/expense-calculations';

/**
 * Từ kỳ tháng 11/2026, tiền "Giáo viên trường" không còn nằm trong Chi Trường
 * (chỉ còn Thuế + CSVC) mà trả thẳng cho giáo viên ở bảng Giáo viên trường.
 * Kỳ trước giữ nguyên như cũ. Dòng tuỳ chỉnh (tháng ảo > 12) theo năm của nó.
 */
export const SCHOOL_TEACHER_SPLIT_FROM = { year: 2026, month: 11 } as const;

export function schoolTeacherSplitApplies(
  period: { year?: number | null; month?: number | null } | null | undefined,
): boolean {
  const year = Number(period?.year);
  const month = Number(period?.month);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return false;
  return (
    year * 100 + month >=
    SCHOOL_TEACHER_SPLIT_FROM.year * 100 + SCHOOL_TEACHER_SPLIT_FROM.month
  );
}

/** Ai được bấm "Duyệt lương". */
export const SCHOOL_TEACHER_APPROVE_ROLES = [
  'director',
  'director_la',
  'ketoan_truong',
] as const;

/**
 * Thuế TNCN theo giáo viên (như bảng lương Excel của trường): tổng thù lao tháng
 * của một giáo viên trong bảng thu chi (mọi môn) từ 5.000.000đ thì khấu trừ 10%
 * trên từng dòng của giáo viên đó, dưới ngưỡng thì 0.
 */
export const SCHOOL_TEACHER_PIT_THRESHOLD = 5_000_000;
export const SCHOOL_TEACHER_PIT_RATE = 10;

const round2 = (value: number) => Math.round(value * 100) / 100;

function normalizeContent(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  return content.trim().slice(0, 500) || null;
}

function normalizeNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  return note.trim().slice(0, 2000) || null;
}

function normalizeDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new BadRequestException('Ngày chi của Giáo viên trường không hợp lệ');
  }
  return text;
}

function normalizeTeacherId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestException('Giáo viên của dòng Giáo viên trường không hợp lệ');
  }
  return id;
}

/**
 * Một dòng Giáo viên trường như server lưu. `sharedItem` là dòng Doanh Thu cùng
 * vị trí (dòng đi kèm) hoặc chính dòng đó (dòng thêm riêng). Thuế TNCN để 0 —
 * tính lại cho cả bảng thu chi bằng `allocateSchoolTeacherTax` sau khi lưu.
 */
export function buildSchoolTeacherItemData(
  item: any,
  index: number,
  sharedItem: any,
  standalone: boolean,
) {
  const shared = normalizeSharedFields(sharedItem, index);
  const unitPrice = toNumber(item?.unitPrice, 0);
  assertNonNegative({ unitPrice });

  const amount = round2(unitPrice * revenueBillingQuantity(shared));
  return {
    rowIndex: index,
    schoolTeacherId: normalizeTeacherId(item?.schoolTeacherId),
    content: standalone ? normalizeContent(item?.content) : null,
    totalPeriods: shared.totalPeriods,
    studentCount: shared.studentCount,
    monthsCount: shared.monthsCount,
    unitPrice,
    amount,
    pitRate: 0,
    pitAmount: 0,
    netAmount: amount,
    ...buildSchoolTeacherPaymentData(item),
  };
}

/**
 * Thuế TNCN của mọi dòng Giáo viên trường trong một bảng thu chi: cộng Thành
 * tiền theo giáo viên (dòng chưa chọn giáo viên xét riêng từng dòng); từ ngưỡng
 * thì mỗi dòng khấu trừ 10% (làm tròn đồng), dưới ngưỡng thì 0.
 */
export function allocateSchoolTeacherTax<K>(
  rows: { key: K; schoolTeacherId: number | null; amount: number }[],
): Map<K, { pitRate: number; pitAmount: number; netAmount: number }> {
  const groupOf = (row: { key: K; schoolTeacherId: number | null }) =>
    row.schoolTeacherId ? `teacher:${row.schoolTeacherId}` : row;
  const gross = new Map<unknown, number>();
  for (const row of rows) {
    const group = groupOf(row);
    gross.set(group, (gross.get(group) ?? 0) + (Number(row.amount) || 0));
  }
  const result = new Map<K, { pitRate: number; pitAmount: number; netAmount: number }>();
  for (const row of rows) {
    const amount = Number(row.amount) || 0;
    const pitRate =
      (gross.get(groupOf(row)) ?? 0) >= SCHOOL_TEACHER_PIT_THRESHOLD
        ? SCHOOL_TEACHER_PIT_RATE
        : 0;
    const pitAmount = Math.round((amount * pitRate) / 100);
    result.set(row.key, { pitRate, pitAmount, netAmount: round2(amount - pitAmount) });
  }
  return result;
}

/** Ngày chi, Nguồn chi, Ghi chú — phần vẫn sửa được khi kỳ đã kết thúc (trừ Ghi chú). */
export function buildSchoolTeacherPaymentData(item: any) {
  return {
    expenseDate: normalizeDate(item?.expenseDate),
    cashAccount: normalizeCashAccount(item?.cashAccount, 'cashAccount'),
    note: normalizeNote(item?.note),
  };
}

/**
 * Phần số tiền của bảng (theo thứ tự dòng, gồm giáo viên nhận): đổi phần này thì
 * dấu "Duyệt lương" cũ không còn đúng. Ngày chi / Nguồn chi / Ghi chú / Nội
 * dung không tính.
 */
export function schoolTeacherMoneySignature(
  rows: {
    rowIndex: number;
    schoolTeacherId?: number | null;
    totalPeriods: unknown;
    studentCount: unknown;
    monthsCount: unknown;
    unitPrice: unknown;
    amount: unknown;
    pitRate: unknown;
    pitAmount: unknown;
  }[],
): string {
  return JSON.stringify(
    [...rows]
      .sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex))
      .map((row) =>
        [
          row.rowIndex,
          row.schoolTeacherId ?? 0,
          row.totalPeriods,
          row.studentCount,
          row.monthsCount,
          row.unitPrice,
          row.amount,
          row.pitRate,
          row.pitAmount,
        ].map((value) => round2(toNumber(value, 0))),
      ),
  );
}

/** Đủ Ngày chi + Nguồn chi = đã trả cho giáo viên. */
export const schoolTeacherPaid = (row: {
  expenseDate: unknown;
  cashAccount: unknown;
}) => !!row.expenseDate && !!row.cashAccount;
