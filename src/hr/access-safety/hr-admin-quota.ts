/**
 * Luật số quản trị HR — phần thuần (không DB) để test độc lập.
 *
 * "Protected HR administrator" của công ty (hệ thống hiện chỉ có MỘT công ty:
 * không entity nào có company_id/tenant) là tài khoản có ít nhất một HR role
 * assignment thoả ĐỒNG THỜI:
 *   - `public.employee."isActive" = true`
 *   - assignment chưa thu hồi, `effective_from <= hôm nay`
 *   - `effective_to IS NULL`  ← quản trị lâu dài; admin tạm thời (có hạn) không tính
 *   - role đang bật (`hr.roles.is_active`)
 *   - role có quyền `ACCESS_ADMIN`
 *   - scope bao phủ công ty: COMPANY hoặc ALL
 *
 * KHÔNG tính: quyền lẻ `account_permission_grants`, ánh xạ role cũ
 * `hr.role_permissions` (seed không có ACCESS_ADMIN), SUPER_ADMIN (không tồn tại
 * trong hệ thống). Tính theo quyền ACCESS_ADMIN, không theo tên `HR_ADMIN`.
 */
export const MIN_PROTECTED_HR_ADMINS = 2;

/** Scope bao phủ toàn công ty. */
export const COMPANY_COVERING_SCOPES = ['COMPANY', 'ALL'] as const;

/**
 * Khoá tư vấn cấp transaction dùng chung cho MỌI thao tác có thể làm giảm số
 * protected admin: thu hồi / đổi assignment (API HR), khoá / xoá tài khoản
 * (module employee), bootstrap.
 */
export const HR_ADMIN_QUOTA_LOCK = 791_700_301;

/**
 * Chỉ chặn khi số protected admin GIẢM và rơi xuống dưới mức tối thiểu:
 * - lúc mới bootstrap (1 admin) vẫn thêm được người thứ hai;
 * - thao tác không đụng protected admin (before === after) luôn được phép.
 */
export function breaksAdminQuota(before: number, after: number): boolean {
  return after < before && after < MIN_PROTECTED_HR_ADMINS;
}

export type QuotaOperation = 'revoke' | 'change' | 'deactivate' | 'delete';

const MESSAGES: Record<QuotaOperation, string> = {
  revoke:
    'Cannot revoke this assignment because it would leave the company with fewer than the required HR administrators. Assign another HR administrator first.',
  change:
    'Cannot change this assignment because it would leave the company with fewer than the required HR administrators. Assign another HR administrator first.',
  deactivate:
    'Cannot deactivate this account because it would leave the company with fewer than the required HR administrators. Assign another HR administrator first.',
  delete:
    'Cannot delete this account because it would leave the company with fewer than the required HR administrators. Assign another HR administrator first.',
};

const MESSAGES_VI: Record<QuotaOperation, string> = {
  revoke: 'Không thể thu hồi',
  change: 'Không thể thay đổi assignment',
  deactivate: 'Không thể khoá tài khoản',
  delete: 'Không thể xoá tài khoản',
};

export function quotaErrorBody(
  operation: QuotaOperation,
  before: number,
  after: number,
) {
  return {
    statusCode: 409,
    code: 'HR_ADMIN_MINIMUM',
    message: MESSAGES[operation],
    messageVi:
      `${MESSAGES_VI[operation]}: công ty sẽ chỉ còn ${after} quản trị HR lâu dài ` +
      `(tối thiểu ${MIN_PROTECTED_HR_ADMINS}). Hãy cấp quyền quản trị cho người khác trước.`,
    protectedAdminCount: before,
    protectedAdminCountAfter: after,
    minimum: MIN_PROTECTED_HR_ADMINS,
  };
}
