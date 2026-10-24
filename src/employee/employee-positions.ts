/** Chức danh đang dùng trong màn Nhân viên. Không gồm dev hay các nhãn thử việc/khu vực. */
export const EMPLOYEE_POSITIONS = [
  { value: 'sales', label: 'Nhân viên KD' },
  { value: 'saleadmin', label: 'Sale Admin' },
  { value: 'salesadmin_la', label: 'Sale Admin LA' },
  { value: 'director', label: 'Giám đốc' },
  { value: 'director_la', label: 'Giám đốc LA' },
  { value: 'accountant', label: 'Kế toán' },
  { value: 'ketoan_congno', label: 'KT công nợ' },
  { value: 'ketoan_truong', label: 'Kế toán trưởng' },
  { value: 'troly_gd', label: 'Trợ lý GĐ' },
  { value: 'thuquy', label: 'Thủ quỹ' },
  { value: 'ky_thuat', label: 'Phòng kỹ thuật' },
  { value: 'nhansu', label: 'Nhân sự' },
  { value: 'giaovu', label: 'Giáo vụ' },
  { value: 'giaovien_congty', label: 'Giáo viên công ty' },
  { value: 'giaovien_ctv', label: 'Giáo viên CTV' },
  { value: 'employee', label: 'Nhân viên' },
] as const;

export function employeePosition(role: string | null | undefined) {
  return EMPLOYEE_POSITIONS.find((position) => position.value === role);
}
