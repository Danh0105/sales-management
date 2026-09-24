import { calculatePayrollTotals } from './payroll-calculation';

describe('calculatePayrollTotals', () => {
  it('tính đúng phiếu lương theo mẫu tháng 8', () => {
    expect(
      calculatePayrollTotals({
        officialWorkSalary: 14_000_000,
        overtimeAllowance: 1_620_000,
        otherSupport: 120_000,
        socialInsurance: 596_400,
        adjustmentAmount: 1_620_000,
      }),
    ).toEqual({
      totalIncome: 15_740_000,
      totalDeduction: 2_216_400,
      netSalary: 13_523_600,
    });
  });

  it('coi field không gửi là 0 và làm tròn đến 2 chữ số', () => {
    expect(
      calculatePayrollTotals({
        officialWorkSalary: 10.115,
        bonus: 0.116,
        advancePayment: 1.005,
      }),
    ).toEqual({ totalIncome: 10.23, totalDeduction: 1.01, netSalary: 9.22 });
  });

  it('không cộng mức lương hợp đồng vào tổng thu nhập', () => {
    expect(
      calculatePayrollTotals({ officialWorkSalary: 14_000_000 }).totalIncome,
    ).toBe(14_000_000);
  });

  it('truy lãnh âm làm giảm khấu trừ và tăng lương thực nhận', () => {
    expect(
      calculatePayrollTotals({
        officialWorkSalary: 10_000_000,
        socialInsurance: 500_000,
        adjustmentAmount: -200_000,
      }),
    ).toEqual({
      totalIncome: 10_000_000,
      totalDeduction: 300_000,
      netSalary: 9_700_000,
    });
  });
});
