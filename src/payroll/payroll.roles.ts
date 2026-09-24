/** Người được lập, sửa và xoá phiếu lương. */
export const PAYROLL_MANAGE_ROLES = ['nhansu', 'ketoan_truong'];

/** Người được xem toàn bộ phiếu lương; nhân viên khác chỉ xem phiếu của mình. */
export const PAYROLL_VIEW_ALL_ROLES = [
  ...PAYROLL_MANAGE_ROLES,
  'director',
  'director_la',
];

export function canViewAllPayrolls(roles?: string[]): boolean {
  return (roles ?? []).some((role) => PAYROLL_VIEW_ALL_ROLES.includes(role));
}
