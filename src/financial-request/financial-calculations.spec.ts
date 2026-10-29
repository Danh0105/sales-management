import {
  advanceAvailable,
  computeAdvanceSettlementStatus,
  computeDeductionStatus,
  computePaymentStatus,
  computeSettlement,
  daysUntil,
  nextPeriod,
} from './financial-calculations';
import {
  DeductionStatus,
  PaymentStatus,
  RecoveryStatus,
  SettlementStatus,
} from './financial-request.constants';

describe('computeSettlement — quyết toán hoàn ứng', () => {
  it('TH1: chi phí duyệt > tạm ứng → công ty trả thêm, chỉ hoàn tất khi chi đủ', () => {
    const pending = computeSettlement({
      approvedTotal: 7_000_000,
      offsetTotal: 5_000_000,
      paidTotal: 0,
      recoveredTotal: 0,
    });
    expect(pending).toMatchObject({
      difference: 2_000_000,
      payableRemaining: 2_000_000,
      receivableRemaining: 0,
      paymentStatus: PaymentStatus.UNPAID,
      recoveryStatus: RecoveryStatus.NONE,
      settlementStatus: SettlementStatus.PENDING_PAYMENT,
    });
    const partial = computeSettlement({
      approvedTotal: 7_000_000,
      offsetTotal: 5_000_000,
      paidTotal: 500_000,
      recoveredTotal: 0,
    });
    expect(partial.paymentStatus).toBe(PaymentStatus.PARTIALLY_PAID);
    expect(partial.settlementStatus).toBe(SettlementStatus.PENDING_PAYMENT);
    const done = computeSettlement({
      approvedTotal: 7_000_000,
      offsetTotal: 5_000_000,
      paidTotal: 2_000_000,
      recoveredTotal: 0,
    });
    expect(done.paymentStatus).toBe(PaymentStatus.PAID);
    expect(done.settlementStatus).toBe(SettlementStatus.COMPLETED);
  });

  it('TH2: chi phí duyệt = tạm ứng → tất toán ngay', () => {
    expect(
      computeSettlement({
        approvedTotal: 5_000_000,
        offsetTotal: 5_000_000,
        paidTotal: 0,
        recoveredTotal: 0,
      }),
    ).toMatchObject({
      difference: 0,
      paymentStatus: PaymentStatus.NONE,
      recoveryStatus: RecoveryStatus.NONE,
      settlementStatus: SettlementStatus.COMPLETED,
    });
  });

  it('TH3: chi phí duyệt < tạm ứng → nhân viên hoàn trả, thu nhiều lần', () => {
    const pending = computeSettlement({
      approvedTotal: 3_200_000,
      offsetTotal: 5_000_000,
      paidTotal: 0,
      recoveredTotal: 0,
    });
    expect(pending).toMatchObject({
      difference: -1_800_000,
      receivableRemaining: 1_800_000,
      paymentStatus: PaymentStatus.NONE,
      recoveryStatus: RecoveryStatus.PENDING,
      settlementStatus: SettlementStatus.PENDING_REFUND,
    });
    const partial = computeSettlement({
      approvedTotal: 3_200_000,
      offsetTotal: 5_000_000,
      paidTotal: 0,
      recoveredTotal: 800_000,
    });
    expect(partial.recoveryStatus).toBe(RecoveryStatus.PARTIAL);
    expect(partial.receivableRemaining).toBe(1_000_000);
    const done = computeSettlement({
      approvedTotal: 3_200_000,
      offsetTotal: 5_000_000,
      paidTotal: 0,
      recoveredTotal: 1_800_000,
    });
    expect(done.recoveryStatus).toBe(RecoveryStatus.RECOVERED);
    expect(done.settlementStatus).toBe(SettlementStatus.COMPLETED);
  });
});

describe('computeAdvanceSettlementStatus — tạm ứng', () => {
  it('chưa chi thì không có trạng thái quyết toán', () => {
    expect(
      computeAdvanceSettlementStatus({
        paid: 0,
        applied: 0,
        hasPendingRefund: false,
      }),
    ).toBe(SettlementStatus.NONE);
  });
  it('chi rồi, chưa hoàn ứng', () => {
    expect(
      computeAdvanceSettlementStatus({
        paid: 5,
        applied: 0,
        hasPendingRefund: false,
      }),
    ).toBe(SettlementStatus.NOT_SETTLED);
  });
  it('hoàn ứng một phần', () => {
    expect(
      computeAdvanceSettlementStatus({
        paid: 5,
        applied: 2,
        hasPendingRefund: false,
      }),
    ).toBe(SettlementStatus.PARTIALLY_SETTLED);
  });
  it('đối trừ đủ nhưng còn tiền thừa chưa thu → chưa tất toán', () => {
    expect(
      computeAdvanceSettlementStatus({
        paid: 5,
        applied: 5,
        hasPendingRefund: true,
      }),
    ).toBe(SettlementStatus.PARTIALLY_SETTLED);
  });
  it('đối trừ đủ và không còn khoản treo → tất toán', () => {
    expect(
      computeAdvanceSettlementStatus({
        paid: 5,
        applied: 5,
        hasPendingRefund: false,
      }),
    ).toBe(SettlementStatus.SETTLED);
  });
  it('số dư còn đối trừ được không âm', () => {
    expect(advanceAvailable(5_000_000, 2_000_000)).toBe(3_000_000);
    expect(advanceAvailable(5_000_000, 6_000_000)).toBe(0);
  });
});

describe('trạng thái chi tiền & khấu trừ', () => {
  it('computePaymentStatus', () => {
    expect(computePaymentStatus(0, 0)).toBe(PaymentStatus.NONE);
    expect(computePaymentStatus(100, 0)).toBe(PaymentStatus.UNPAID);
    expect(computePaymentStatus(100, 40)).toBe(PaymentStatus.PARTIALLY_PAID);
    expect(computePaymentStatus(100, 100)).toBe(PaymentStatus.PAID);
  });
  it('computeDeductionStatus', () => {
    expect(computeDeductionStatus(0, 0)).toBe(DeductionStatus.NONE);
    expect(computeDeductionStatus(3, 0)).toBe(DeductionStatus.NOT_DEDUCTED);
    expect(computeDeductionStatus(3, 1)).toBe(DeductionStatus.DEDUCTING);
    expect(computeDeductionStatus(3, 3)).toBe(DeductionStatus.DEDUCTED);
  });
  it('kỳ lương kế tiếp và đếm ngày', () => {
    expect(nextPeriod(2026, 12)).toEqual({ year: 2027, month: 1 });
    expect(nextPeriod(2026, 5)).toEqual({ year: 2026, month: 6 });
    expect(daysUntil('2026-11-05', '2026-11-01')).toBe(4);
    expect(daysUntil('2026-10-30', '2026-11-01')).toBe(-2);
  });
});
