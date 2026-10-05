/**
 * Mã nhân viên hệ thống sinh: `NV` + 6 chữ số, lấy số từ sequence
 * `hr.employee_code_seq` (migration 1791700000600). Người dùng không nhập mã.
 */
export const EMPLOYEE_CODE_PREFIX = 'NV';
export const EMPLOYEE_CODE_DIGITS = 6;
export const EMPLOYEE_CODE_SEQUENCE = '"hr"."employee_code_seq"';
export const EMPLOYEE_CODE_PATTERN = /^NV\d{6}$/;

export function formatEmployeeCode(sequenceValue: number): string {
  const max = 10 ** EMPLOYEE_CODE_DIGITS - 1;
  if (
    !Number.isSafeInteger(sequenceValue) ||
    sequenceValue < 1 ||
    sequenceValue > max
  ) {
    throw new Error(`Số thứ tự mã nhân viên phải trong khoảng 1–${max}`);
  }
  return `${EMPLOYEE_CODE_PREFIX}${String(sequenceValue).padStart(EMPLOYEE_CODE_DIGITS, '0')}`;
}
