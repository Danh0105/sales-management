/** Người được lập, sửa và xoá phiếu lương. */
export const PAYROLL_MANAGE_ROLES = ['nhansu', 'ketoan_truong'];

/** Người được xem toàn bộ phiếu lương; nhân viên khác chỉ xem phiếu của mình. */
export const PAYROLL_VIEW_ALL_ROLES = [
  ...PAYROLL_MANAGE_ROLES,
  'director',
  // Trợ lý GĐ: xem toàn bộ, không lập/sửa/xoá (không có trong PAYROLL_MANAGE_ROLES).
  'troly_gd',
];

export function canViewAllPayrolls(roles?: string[]): boolean {
  return (roles ?? []).some((role) => PAYROLL_VIEW_ALL_ROLES.includes(role));
}
