/** Roles được phép thay đổi dữ liệu trong màn Quản lý thu chi. */
export const CASHFLOW_WRITE_ROLES = [
  'accountant',
  'ketoan_congno',
  'ketoan_truong',
  'troly_gd',
  'director',
  // Thủ quỹ tạo / nhập / sửa thu chi như Kế toán (không có quyền riêng của KTT).
  'thuquy',
] as const;

/**
 * Sales Admin được xem toàn bộ nhưng chỉ được xác nhận đúng BBCS và tạo bảng
 * chi phí rỗng khi trường chưa có bảng trong kỳ.
 */
export const CASHFLOW_SALES_ADMIN_ROLES = [
  'saleadmin',
  'salesadmin',
  'salesadmin_la',
] as const;

export const CASHFLOW_READ_ROLES = [
  ...CASHFLOW_WRITE_ROLES,
  ...CASHFLOW_SALES_ADMIN_ROLES,
] as const;

/** `create` chỉ lấy schoolId + periodId, tổng tiền luôn 0 nên không ghi được số liệu. */
export const CASHFLOW_CREATE_ROLES = [
  ...CASHFLOW_WRITE_ROLES,
  ...CASHFLOW_SALES_ADMIN_ROLES,
] as const;
