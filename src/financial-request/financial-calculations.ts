import {
  DeductionStatus,
  PaymentStatus,
  RecoveryStatus,
  SettlementStatus,
} from './financial-request.constants';

/**
 * Các phép tính trạng thái thuần (không đụng DB) — để kiểm thử độc lập và để
 * service luôn suy trạng thái từ số liệu thật thay vì gán tay.
 */

/** Trạng thái chi tiền theo số phải chi và số đã chi. */
export function computePaymentStatus(due: number, paid: number): PaymentStatus {
  if (due <= 0) return PaymentStatus.NONE;
  if (paid <= 0) return PaymentStatus.UNPAID;
  if (paid < due) return PaymentStatus.PARTIALLY_PAID;
  return PaymentStatus.PAID;
}

export interface SettlementInput {
  /** Tổng chi phí được duyệt. */
  approvedTotal: number;
  /** Tổng tiền tạm ứng đem đối trừ. */
  offsetTotal: number;
  /** Đã chi thêm cho nhân viên (phiếu chi). */
  paidTotal: number;
  /** Đã thu lại từ nhân viên (phiếu thu). */
  recoveredTotal: number;
}

export interface SettlementResult {
  /** Chênh lệch quyết toán = được duyệt − tạm ứng đối trừ. */
  difference: number;
  /** Công ty còn phải trả thêm cho nhân viên. */
  payableRemaining: number;
  /** Nhân viên còn phải hoàn trả cho công ty. */
  receivableRemaining: number;
  paymentStatus: PaymentStatus;
  recoveryStatus: RecoveryStatus;
  settlementStatus: SettlementStatus;
}

/**
 * Quyết toán một phiếu hoàn ứng ĐÃ DUYỆT.
 *
 * - Chênh lệch > 0: công ty trả thêm → chỉ hoàn tất khi đã chi đủ.
 * - Chênh lệch = 0: tất toán ngay phần tạm ứng đã phân bổ.
 * - Chênh lệch < 0: nhân viên hoàn trả → chỉ hoàn tất khi đã thu đủ.
 */
export function computeSettlement(input: SettlementInput): SettlementResult {
  const difference = input.approvedTotal - input.offsetTotal;
  const payableDue = Math.max(difference, 0);
  const receivableDue = Math.max(-difference, 0);
  const payableRemaining = Math.max(payableDue - input.paidTotal, 0);
  const receivableRemaining = Math.max(receivableDue - input.recoveredTotal, 0);

  const paymentStatus = computePaymentStatus(payableDue, input.paidTotal);

  let recoveryStatus = RecoveryStatus.NONE;
  if (receivableDue > 0) {
    recoveryStatus =
      input.recoveredTotal <= 0
        ? RecoveryStatus.PENDING
        : input.recoveredTotal < receivableDue
          ? RecoveryStatus.PARTIAL
          : RecoveryStatus.RECOVERED;
  }

  let settlementStatus = SettlementStatus.COMPLETED;
  if (payableRemaining > 0) settlementStatus = SettlementStatus.PENDING_PAYMENT;
  else if (receivableRemaining > 0)
    settlementStatus = SettlementStatus.PENDING_REFUND;

  return {
    difference,
    payableRemaining,
    receivableRemaining,
    paymentStatus,
    recoveryStatus,
    settlementStatus,
  };
}

export interface AdvanceSettlementInput {
  /** Số tiền tạm ứng đã thực chi. */
  paid: number;
  /** Đã được phiếu hoàn ứng (đã duyệt) đối trừ. */
  applied: number;
  /** Còn phiếu hoàn ứng liên quan đang chờ nhân viên trả tiền thừa. */
  hasPendingRefund: boolean;
}

/**
 * Tình trạng quyết toán của một phiếu tạm ứng. Chỉ "SETTLED" khi toàn bộ số
 * đã chi đã được đối trừ VÀ không còn khoản hoàn trả nào đang treo — duyệt
 * phiếu hoàn ứng thôi chưa đủ.
 */
export function computeAdvanceSettlementStatus(
  input: AdvanceSettlementInput,
): SettlementStatus {
  if (input.paid <= 0) return SettlementStatus.NONE;
  if (input.applied <= 0) return SettlementStatus.NOT_SETTLED;
  if (input.applied < input.paid || input.hasPendingRefund) {
    return SettlementStatus.PARTIALLY_SETTLED;
  }
  return SettlementStatus.SETTLED;
}

/** Số dư tạm ứng còn được đem đối trừ. */
export function advanceAvailable(paid: number, reserved: number): number {
  return Math.max(paid - reserved, 0);
}

export function computeDeductionStatus(
  paid: number,
  deducted: number,
): DeductionStatus {
  if (paid <= 0) return DeductionStatus.NONE;
  if (deducted <= 0) return DeductionStatus.NOT_DEDUCTED;
  if (deducted < paid) return DeductionStatus.DEDUCTING;
  return DeductionStatus.DEDUCTED;
}

/** Kỳ lương kế tiếp. */
export function nextPeriod(year: number, month: number) {
  return month === 12
    ? { year: year + 1, month: 1 }
    : { year, month: month + 1 };
}

export function periodKey(year: number, month: number): number {
  return year * 100 + month;
}

/** Số ngày từ hôm nay (theo giờ VN) tới ngày `date` (YYYY-MM-DD); âm = đã quá hạn. */
export function daysUntil(date: string, today = vnToday()): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Ngày hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD. */
export function vnToday(now = new Date()): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}
