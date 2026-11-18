/**
 * Trưởng/phó phòng — chức danh kiêm thêm, gán cùng role nghiệp vụ của người đó.
 * Tự nó không mở thêm quyền nghiệp vụ nào; hiện chỉ dùng để chọn làm quản lý
 * trực tiếp trên đề nghị tài chính.
 */
export const DEPARTMENT_HEAD_POSITIONS = [
  { value: 'truongphong_chuyenmon', label: 'Trưởng/phó phòng chuyên môn' },
  { value: 'truongphong_sanxuat', label: 'Trưởng/phó phòng sản xuất' },
  { value: 'truongphong_ketoan', label: 'Trưởng/phó phòng kế toán' },
  { value: 'truongphong_giaovu', label: 'Trưởng/phó phòng giáo vụ' },
  { value: 'truongphong_nhansu', label: 'Trưởng/phó phòng nhân sự' },
  { value: 'truongphong_kythuat', label: 'Trưởng/phó phòng kỹ thuật' },
  { value: 'truongphong_congnghe', label: 'Trưởng/phó phòng công nghệ' },
  { value: 'truongphong_saleadmin', label: 'Trưởng/phó phòng sale admin' },
] as const;

export const DEPARTMENT_HEAD_ROLES: string[] = DEPARTMENT_HEAD_POSITIONS.map(
  (position) => position.value,
);

/** Chức danh đang dùng trong màn Nhân viên. Không gồm dev hay các nhãn thử việc/khu vực. */
export const EMPLOYEE_POSITIONS = [
  { value: 'sales', label: 'Nhân viên KD' },
  { value: 'saleadmin', label: 'Sale Admin' },
  { value: 'salesadmin_la', label: 'Sale Admin LA' },
  { value: 'director', label: 'Giám đốc' },
  { value: 'director_la', label: 'Giám đốc LA' },
  ...DEPARTMENT_HEAD_POSITIONS,
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
