/**
 * Phiếu Thanh toán chi phí chuyển tiền cho nhiều người nhận: các nhà cung cấp
 * (NCC) của phiếu và/hoặc chính người đề nghị. Số tiền mỗi người nhận = tổng
 * các dòng chi tiết gán cho họ (số được duyệt nếu đã điều chỉnh) — không nhập
 * tay nên luôn khớp tổng phiếu.
 */
import { MovementStatus } from './financial-request.constants';

export type SupplierLike = {
  id: number;
  lineNo: number;
  name: string;
  bankAccountHolder: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  note?: string | null;
};

export type ItemLike = {
  lineNo?: number;
  supplierId: number | null;
  amount: number;
  approvedAmount: number | null;
};

export type PaymentLike = {
  supplierId: number | null;
  amount: number;
  status: MovementStatus | string;
};

export type RecipientTotals = {
  /** NULL = người đề nghị. */
  supplierId: number | null;
  amount: number;
  paidAmount: number;
  remaining: number;
};

/** Số tiền của một dòng: số được duyệt nếu đã điều chỉnh, không thì số kê khai. */
export const effectiveAmount = (item: Pick<ItemLike, 'amount' | 'approvedAmount'>) =>
  item.approvedAmount ?? item.amount;

/**
 * Số phải chi / đã chi / còn lại của từng người nhận. Người đề nghị luôn ở
 * đầu danh sách (kể cả khi 0 đ, để nơi gọi tự quyết có hiện hay không), các
 * NCC theo thứ tự `lineNo`.
 */
export function recipientTotals(
  suppliers: Pick<SupplierLike, 'id' | 'lineNo'>[],
  items: ItemLike[],
  payments: PaymentLike[],
): RecipientTotals[] {
  const known = new Set(suppliers.map((s) => s.id));
  // Dòng trỏ tới NCC không còn tồn tại coi như của người đề nghị (FK SET NULL).
  const keyOf = (id: number | null) => (id !== null && known.has(id) ? id : null);
  const amount = new Map<number | null, number>();
  const paid = new Map<number | null, number>();
  for (const item of items) {
    const key = keyOf(item.supplierId);
    amount.set(key, (amount.get(key) ?? 0) + effectiveAmount(item));
  }
  for (const payment of payments) {
    if (payment.status !== MovementStatus.RECORDED) continue;
    const key = keyOf(payment.supplierId);
    paid.set(key, (paid.get(key) ?? 0) + payment.amount);
  }
  const ordered = [...suppliers].sort((a, b) => a.lineNo - b.lineNo);
  return [null, ...ordered.map((s) => s.id)].map((supplierId) => {
    const due = amount.get(supplierId) ?? 0;
    const done = paid.get(supplierId) ?? 0;
    return {
      supplierId,
      amount: due,
      paidAmount: done,
      remaining: Math.max(due - done, 0),
    };
  });
}

/** Lỗi chặn gửi duyệt của danh sách NCC (phiếu Thanh toán chi phí). */
export function supplierSubmitErrors(
  suppliers: SupplierLike[],
  items: ItemLike[],
): string[] {
  const errors: string[] = [];
  for (const supplier of [...suppliers].sort((a, b) => a.lineNo - b.lineNo)) {
    const label = `NCC ${supplier.lineNo} (${supplier.name})`;
    const missing = [
      !supplier.bankName?.trim() && 'ngân hàng',
      !supplier.bankAccountNumber?.trim() && 'số tài khoản',
    ].filter(Boolean);
    if (missing.length) {
      errors.push(`${label}: thiếu ${missing.join(', ')}`);
    }
    if (!items.some((item) => item.supplierId === supplier.id)) {
      errors.push(`${label}: chưa gán dòng chi tiết nào`);
    }
  }
  return errors;
}

/** So số tài khoản bỏ qua khoảng trắng / gạch nối. */
export const sameAccount = (a?: string | null, b?: string | null) => {
  const norm = (v?: string | null) => (v ?? '').replace(/[\s-]+/g, '');
  return !!norm(a) && norm(a) === norm(b);
};
