/**
 * Danh mục quyền HR. Đây là nguồn chuẩn trong code; bảng `hr.permissions` được
 * seed bằng migration với đúng danh sách này (`hr-permission.spec.ts` đối chiếu).
 *
 * Thêm quyền mới = thêm vào đây + một migration INSERT mới. Không đổi tên mã
 * quyền đã có — `hr.role_permissions` và `hr.account_permission_grants` tham
 * chiếu tới nó.
 */
export enum HrPermission {
  EMPLOYEE_VIEW = 'EMPLOYEE_VIEW',
  EMPLOYEE_EDIT = 'EMPLOYEE_EDIT',
  IDENTITY_REVEAL = 'IDENTITY_REVEAL',
  BANK_REVEAL = 'BANK_REVEAL',
  SALARY_VIEW = 'SALARY_VIEW',
  FILE_VIEW = 'FILE_VIEW',
  AUDIT_VIEW = 'AUDIT_VIEW',
  PARAMETER_MANAGE = 'PARAMETER_MANAGE',
  HOLIDAY_MANAGE = 'HOLIDAY_MANAGE',
  ACCESS_VIEW = 'ACCESS_VIEW',
  ACCESS_ADMIN = 'ACCESS_ADMIN',
  /** Phase 1.1 — quản lý cơ cấu tổ chức (luôn kèm scope). */
  ORG_MANAGE = 'ORG_MANAGE',
}

export const HR_PERMISSION_CODES = Object.values(HrPermission) as string[];

export function isHrPermission(value: unknown): value is HrPermission {
  return typeof value === 'string' && HR_PERMISSION_CODES.includes(value);
}

/**
 * Phạm vi dữ liệu của một quyền. Thứ tự chỉ để hiển thị — KHÔNG phải quan hệ
 * bao hàm: TEAM (theo cây quản lý) và ORG_UNIT (theo phòng ban) là hai trục
 * khác nhau, nên mỗi grant được đánh giá độc lập.
 */
export enum HrScope {
  SELF = 'SELF',
  TEAM = 'TEAM',
  ORG_UNIT = 'ORG_UNIT',
  BRANCH = 'BRANCH',
  COMPANY = 'COMPANY',
  ALL = 'ALL',
}

export const HR_SCOPES = Object.values(HrScope) as string[];

/** Hệ thống hiện chỉ có một công ty — COMPANY và ALL đều không giới hạn đối tượng. */
export const UNRESTRICTED_SCOPES: readonly HrScope[] = [
  HrScope.COMPANY,
  HrScope.ALL,
];
