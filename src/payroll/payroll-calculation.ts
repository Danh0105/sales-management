export interface PayrollAmounts {
  officialWorkSalary?: number;
  probationWorkSalary?: number;
  fuelAllowance?: number;
  overtimeAllowance?: number;
  excessPeriodAllowance?: number;
  otherSupport?: number;
  bonus?: number;
  socialInsurance?: number;
  personalIncomeTax?: number;
  adjustmentAmount?: number;
  advancePayment?: number;
}

const amount = (value?: number | null) => Number(value ?? 0);
const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Mức lương hợp đồng (`baseSalary`) không cộng vào đây: đúng theo biểu mẫu,
 * đó là căn cứ tham chiếu; tổng thu nhập là các dòng 2 → 8.
 */
export function calculatePayrollTotals(input: PayrollAmounts) {
  const totalIncome = roundMoney(
    amount(input.officialWorkSalary) +
      amount(input.probationWorkSalary) +
      amount(input.fuelAllowance) +
      amount(input.overtimeAllowance) +
      amount(input.excessPeriodAllowance) +
      amount(input.otherSupport) +
      amount(input.bonus),
  );

  const totalDeduction = roundMoney(
    amount(input.socialInsurance) +
      amount(input.personalIncomeTax) +
      amount(input.adjustmentAmount) +
      amount(input.advancePayment),
  );

  return {
    totalIncome,
    totalDeduction,
    netSalary: roundMoney(totalIncome - totalDeduction),
  };
}
