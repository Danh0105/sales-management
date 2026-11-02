import { BadRequestException, ForbiddenException } from '@nestjs/common';

import {
  normalizeRevenueInvoiceStatus,
  normalizeRevenueInvoiceType,
  RevenueInvoiceType,
} from '../revenue-item/revenue-invoice-status.enum';

export function toNumber(value: unknown, defaultValue = 0): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Parse số "nghiêm ngặt": KHÔNG dùng `Number(x) || 0` để che dữ liệu sai.
 * Chấp nhận number hoặc string số; ném BadRequest nếu NaN/Infinity.
 */
export function toStrictNumber(value: unknown, fieldName = 'value'): number {
  const parsed =
    typeof value === 'string' ? Number(value.trim()) : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(`${fieldName} không hợp lệ (NaN/Infinity)`);
  }

  return parsed;
}

export interface NormalizedOtherCost {
  policyOtherCostId: number | null;
  name: string | null;
  unitPrice: number;
  amount: number;
  tax: number;
  taxAmount: number;
}

const POSTGRES_INTEGER_MAX = 2_147_483_647;

/**
 * Chuẩn hóa + validate + tính amount cho mảng "Chi khác" của 1 dòng.
 * - amount = unitPrice * studentCount * monthsCount (BE tự tính).
 * - Chấp nhận alias `id` → policyOtherCostId với ID số nguyên hợp lệ.
 * - Bỏ qua `id` tạm dạng timestamp của FE (không phải ID chính sách).
 * - Cấm: unitPrice âm, amount âm, NaN/Infinity, tên trống khi không có policyOtherCostId,
 *   trùng policyOtherCostId trong cùng 1 dòng.
 */
export function computeOtherCostRows(
  rawList: any[],
  shared: { studentCount: number; monthsCount: number },
): {
  rows: NormalizedOtherCost[];
  totalOtherCostAmount: number;
  totalOtherTaxAmount: number;
} {
  const rows: NormalizedOtherCost[] = [];
  const seenPolicyIds = new Set<number>();

  for (const raw of rawList ?? []) {
    const hasExplicitPolicyId =
      raw?.policyOtherCostId !== null &&
      raw?.policyOtherCostId !== undefined &&
      raw?.policyOtherCostId !== '';
    let rawPolicyId = hasExplicitPolicyId ? raw.policyOtherCostId : raw?.id;

    // FE dùng Date.now() làm khóa tạm cho khoản chi tự nhập. Giá trị này
    // không phải policyOtherCostId và cũng vượt giới hạn INTEGER của PostgreSQL.
    if (
      !hasExplicitPolicyId &&
      rawPolicyId !== null &&
      rawPolicyId !== undefined
    ) {
      const aliasId = Number(rawPolicyId);
      if (Number.isInteger(aliasId) && aliasId > POSTGRES_INTEGER_MAX) {
        rawPolicyId = null;
      }
    }

    let policyOtherCostId: number | null = null;
    if (
      rawPolicyId !== null &&
      rawPolicyId !== undefined &&
      rawPolicyId !== ''
    ) {
      policyOtherCostId = toStrictNumber(rawPolicyId, 'policyOtherCostId');
      if (!Number.isInteger(policyOtherCostId)) {
        throw new BadRequestException('policyOtherCostId phải là số nguyên');
      }
      if (policyOtherCostId < 1 || policyOtherCostId > POSTGRES_INTEGER_MAX) {
        throw new BadRequestException(
          'policyOtherCostId vượt ngoài phạm vi cho phép',
        );
      }
      if (seenPolicyIds.has(policyOtherCostId)) {
        throw new BadRequestException(
          `Trùng policyOtherCostId (${policyOtherCostId}) trong cùng một dòng`,
        );
      }
      seenPolicyIds.add(policyOtherCostId);
    }

    const name =
      raw?.name === undefined || raw?.name === null
        ? null
        : String(raw.name).trim();

    if (policyOtherCostId === null && !name) {
      throw new BadRequestException(
        'Tên khoản chi khác là bắt buộc khi không có policyOtherCostId',
      );
    }

    const unitPrice = toStrictNumber(raw?.unitPrice, 'otherCosts.unitPrice');
    if (unitPrice < 0) {
      throw new BadRequestException('otherCosts.unitPrice không được âm');
    }

    // Thuế optional (mặc định 0); là đơn giá thuế tuyệt đối.
    const tax =
      raw?.tax === undefined || raw?.tax === null || raw?.tax === ''
        ? 0
        : toStrictNumber(raw.tax, 'otherCosts.tax');
    if (tax < 0) {
      throw new BadRequestException('otherCosts.tax không được âm');
    }

    const amount = unitPrice * shared.studentCount * shared.monthsCount;
    const taxAmount = tax * shared.studentCount * shared.monthsCount;
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('otherCosts.amount không hợp lệ');
    }

    rows.push({
      policyOtherCostId,
      name: name || null,
      unitPrice,
      amount,
      tax,
      taxAmount,
    });
  }

  const totalOtherCostAmount = rows.reduce((sum, r) => sum + r.amount, 0);
  const totalOtherTaxAmount = rows.reduce((sum, r) => sum + r.taxAmount, 0);

  return { rows, totalOtherCostAmount, totalOtherTaxAmount };
}

export function normalizePaymentMethod(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (value === 'cash' || value === 'bank_transfer') {
    return value;
  }

  throw new BadRequestException('Invalid paymentMethod');
}

/** Hình thức chi của dòng Chi trường. */
export function normalizeSchoolPaymentType(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (value === 'in_contract' || value === 'not_in_contract') {
    return value;
  }

  throw new BadRequestException('Invalid paymentType');
}

/** Kỳ thu chi đã "Kết thúc" → khoá mọi chỉnh sửa, kể cả kế toán trưởng (phải mở lại trước). */
export function assertNotFinalized(
  schoolExpense?: { finalized?: boolean } | null,
) {
  if (schoolExpense?.finalized) {
    throw new ForbiddenException(
      'Kỳ thu chi đã kết thúc — kế toán trưởng mở lại mới sửa được',
    );
  }
}

export function assertNonNegative(values: Record<string, number>) {
  for (const [key, value] of Object.entries(values)) {
    if (value < 0) {
      throw new BadRequestException(
        `${key} must be greater than or equal to 0`,
      );
    }
  }
}

export function normalizeSharedFields(item: any, index = 0) {
  const totalPeriods = toNumber(item?.totalPeriods, 0);
  const studentCount = toNumber(item?.studentCount, 0);
  const monthsCount = toNumber(item?.monthsCount, 1);
  const rowIndex = toNumber(item?.rowIndex, index);

  assertNonNegative({
    totalPeriods,
    studentCount,
    monthsCount,
  });

  return {
    rowIndex,
    totalPeriods,
    studentCount,
    monthsCount,
  };
}

/**
 * Số lượng dùng để tính doanh thu:
 * - có nhập số học sinh (> 0): số học sinh × số tháng;
 * - không nhập số học sinh nhưng có số tiết: số tiết × số tháng.
 *
 * Ưu tiên số học sinh khi cả hai cùng có giá trị để công thức luôn xác định.
 */
export function revenueBillingQuantity(shared: {
  totalPeriods: number;
  studentCount: number;
  monthsCount: number;
}): number {
  const baseQuantity =
    shared.studentCount > 0 ? shared.studentCount : shared.totalPeriods;
  return baseQuantity * shared.monthsCount;
}

export function buildRevenueItemData(item: any, index = 0, sharedItem = item) {
  const shared = normalizeSharedFields(sharedItem, index);
  const unitPrice = toNumber(item?.unitPrice, 0);
  const paidAmount = toNumber(item?.paidAmount, 0);

  assertNonNegative({
    unitPrice,
    paidAmount,
  });

  const invoiceAmount = revenueBillingQuantity(shared) * unitPrice;
  const remainingAmount = invoiceAmount - paidAmount;
  const invoiceType = normalizeRevenueInvoiceType(
    item?.invoiceType,
    item?.invoiced,
  );

  return {
    ...shared,
    content: item?.content ?? '',
    unitPrice,
    invoiceAmount,
    invoiced: normalizeRevenueInvoiceStatus(
      item?.invoiced ?? item?.invoiceType,
    ),
    invoiceType,
    invoiceOther:
      invoiceType === RevenueInvoiceType.Other
        ? item?.invoiceOther || null
        : null,
    invoiceNumber:
      invoiceType === RevenueInvoiceType.Company
        ? item?.invoiceNumber || null
        : null,
    invoiceDate: item?.invoiceDate || null,
    invoiceUnit:
      String(item?.invoiceUnit ?? '')
        .trim()
        .slice(0, 50) || null,
    invoiceLocked: item?.invoiceLocked === true,
    paidAmount,
    paymentMethod: normalizePaymentMethod(item?.paymentMethod),
    paymentDate: item?.paymentDate || null,
    remainingAmount,
  };
}

export function buildSchoolExpenseItemData(
  item: any,
  index = 0,
  sharedItem = item,
) {
  const shared = normalizeSharedFields(sharedItem, index);
  const giaovien = toNumber(item?.giaovien ?? item?.teacherUnitPrice, 0);
  const thue = toNumber(item?.thue ?? item?.taxUnitPrice, 0);
  const csvc = toNumber(item?.csvc ?? item?.csvcUnitPrice, 0);
  const paidAmount = toNumber(item?.paidAmount, 0);

  assertNonNegative({
    giaovien,
    thue,
    csvc,
    paidAmount,
  });

  const teacherAmount = shared.studentCount * shared.monthsCount * giaovien;
  const taxAmount = shared.studentCount * shared.monthsCount * thue;
  const csvcAmount = csvc * shared.monthsCount * shared.studentCount;
  const schoolExpenseAmount = teacherAmount + taxAmount + csvcAmount;

  return {
    ...shared,
    giaovien,
    thue,
    csvc,
    teacherAmount,
    taxAmount,
    csvcAmount,
    schoolExpenseAmount,
    expenseDate: item?.expenseDate || null,
    paidAmount,
    remaining: schoolExpenseAmount - paidAmount,
    paymentType: normalizeSchoolPaymentType(item?.paymentType),
    payer: item?.payer || null,
    note: item?.note || null,
  };
}

export function buildManagementExpenseItemData(
  item: any,
  index = 0,
  sharedItem = item,
  totalOtherCostAmount = 0,
  totalOtherTaxAmount = 0,
) {
  const shared = normalizeSharedFields(sharedItem, index);
  const ql1UnitPrice = toNumber(item?.ql1UnitPrice, 0);
  const ql2UnitPrice = toNumber(item?.ql2UnitPrice, 0);
  const ql1Tax = toNumber(item?.ql1Tax, 0);
  const ql2Tax = toNumber(item?.ql2Tax, 0);
  const invoiceAmount = toNumber(
    item?.invoiceAmount ?? item?.contractAmount,
    0,
  );
  const paidAmount = toNumber(item?.paidAmount, 0);

  assertNonNegative({
    ql1UnitPrice,
    ql2UnitPrice,
    ql1Tax,
    ql2Tax,
    invoiceAmount,
    paidAmount,
  });

  const ql1Amount = ql1UnitPrice * shared.studentCount * shared.monthsCount;
  const ql2Amount = ql2UnitPrice * shared.studentCount * shared.monthsCount;
  const ql1TaxAmount = ql1Tax * shared.studentCount * shared.monthsCount;
  const ql2TaxAmount = ql2Tax * shared.studentCount * shared.monthsCount;

  // totalTaxAmount = thuế QL1 + QL2 + toàn bộ thuế Chi khác.
  const totalTaxAmount = ql1TaxAmount + ql2TaxAmount + totalOtherTaxAmount;
  // totalOutside = số tiền thực chi = (QL1 - thuế) + (QL2 - thuế) + (Chi khác - thuế),
  // khớp cột "Tổng chi ngoài" của bảng Chi Ngoài bên FE.
  const totalOutside =
    Math.max(0, ql1Amount - ql1TaxAmount) +
    Math.max(0, ql2Amount - ql2TaxAmount) +
    Math.max(0, totalOtherCostAmount - totalOtherTaxAmount);

  return {
    ...shared,
    ql1UnitPrice,
    ql2UnitPrice,
    ql1Amount,
    ql2Amount,
    ql1Tax,
    ql2Tax,
    ql1TaxAmount,
    ql2TaxAmount,
    totalTaxAmount,
    totalOutside,
    collectedDate: item?.collectedDate || null,
    expenseDate: item?.expenseDate || null,
    contractAmount: invoiceAmount,
    invoiceAmount,
    paidAmount,
    remaining: totalOutside - paidAmount,
    payer: item?.payer || null,
    note: item?.note || null,
  };
}
