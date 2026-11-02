/**
 * Các hành động được audit của Phase 0. Cột `action` là varchar (không enum
 * Postgres) nên thêm hành động ở phase sau không cần migration — chỉ cần thêm
 * vào đây. Không đổi tên hành động đã dùng: dữ liệu cũ vẫn mang tên cũ.
 */
export enum HrAuditAction {
  ACCESS_GRANT = 'ACCESS_GRANT',
  ACCESS_REVOKE = 'ACCESS_REVOKE',
  /** Phase 1.3 — dọn một HR role (chỉ qua CLI chuyên dụng, role chưa từng được gán). */
  HR_ROLE_REMOVE = 'HR_ROLE_REMOVE',
  /** Tài khoản đang quản trị HR bị khoá/xoá qua module employee cũ. */
  ACCOUNT_DEACTIVATE = 'ACCOUNT_DEACTIVATE',
  IDENTITY_REVEAL = 'IDENTITY_REVEAL',
  BANK_REVEAL = 'BANK_REVEAL',
  /** Task 0.4B — hồ sơ nhân sự và dữ liệu định danh (audit chỉ lưu dạng che). */
  EMPLOYEE_CREATE = 'EMPLOYEE_CREATE',
  /** Phase 1.2.3 — sửa hồ sơ cơ bản (SĐT/email che; ngày sinh chỉ lưu cờ đã đổi). */
  EMPLOYEE_UPDATE = 'EMPLOYEE_UPDATE',
  /** Phase 1.2.4 — một batch import từ decision file (chỉ số đếm + checksum). */
  EMPLOYEE_IMPORT = 'EMPLOYEE_IMPORT',
  IDENTITY_CREATE = 'IDENTITY_CREATE',
  IDENTITY_UPDATE = 'IDENTITY_UPDATE',
  BANK_ACCOUNT_CREATE = 'BANK_ACCOUNT_CREATE',
  BANK_ACCOUNT_UPDATE = 'BANK_ACCOUNT_UPDATE',
  TAX_PROFILE_CREATE = 'TAX_PROFILE_CREATE',
  TAX_PROFILE_UPDATE = 'TAX_PROFILE_UPDATE',
  INSURANCE_PROFILE_CREATE = 'INSURANCE_PROFILE_CREATE',
  INSURANCE_PROFILE_UPDATE = 'INSURANCE_PROFILE_UPDATE',
  /** Phase 1.1 — cơ cấu tổ chức. */
  ORG_UNIT_CREATE = 'ORG_UNIT_CREATE',
  ORG_UNIT_REVISE = 'ORG_UNIT_REVISE',
  ORG_LEADER_ASSIGN = 'ORG_LEADER_ASSIGN',
  ORG_LEADER_END = 'ORG_LEADER_END',
  POSITION_CREATE = 'POSITION_CREATE',
  POSITION_UPDATE = 'POSITION_UPDATE',
  POSITION_DEACTIVATE = 'POSITION_DEACTIVATE',
  LEGACY_ORG_MAPPING_CREATE = 'LEGACY_ORG_MAPPING_CREATE',
  LEGACY_ORG_MAPPING_DEACTIVATE = 'LEGACY_ORG_MAPPING_DEACTIVATE',
  /** Phase 1.3 — hồ sơ tài liệu (nội dung file vẫn qua FILE_*). */
  DOCUMENT_CREATE = 'DOCUMENT_CREATE',
  DOCUMENT_UPDATE = 'DOCUMENT_UPDATE',
  DOCUMENT_VERSION_ADD = 'DOCUMENT_VERSION_ADD',
  DOCUMENT_ARCHIVE = 'DOCUMENT_ARCHIVE',
  FILE_UPLOAD = 'FILE_UPLOAD',
  FILE_DOWNLOAD = 'FILE_DOWNLOAD',
  /** Task 0.4C — cấp URL/token truy cập nội dung (TTL ngắn). */
  FILE_ACCESS = 'FILE_ACCESS',
  /** Task 0.4C — lưu trữ (soft) file; nội dung vẫn giữ trong kho. */
  FILE_ARCHIVE = 'FILE_ARCHIVE',
  FILE_DELETE = 'FILE_DELETE',
  PARAMETER_CREATE = 'PARAMETER_CREATE',
  PARAMETER_CLOSE = 'PARAMETER_CLOSE',
  HOLIDAY_CREATE = 'HOLIDAY_CREATE',
  HOLIDAY_UPDATE = 'HOLIDAY_UPDATE',
  HOLIDAY_DELETE = 'HOLIDAY_DELETE',
}

export const HR_AUDIT_ACTIONS = Object.values(HrAuditAction) as string[];

export function isHrAuditAction(value: unknown): value is HrAuditAction {
  return typeof value === 'string' && HR_AUDIT_ACTIONS.includes(value);
}

/** Không có lý do thì không được làm — xem dữ liệu nhạy cảm, đổi quyền. */
export const REASON_REQUIRED_ACTIONS: readonly HrAuditAction[] = [
  HrAuditAction.ACCESS_GRANT,
  HrAuditAction.ACCESS_REVOKE,
  HrAuditAction.IDENTITY_REVEAL,
  HrAuditAction.BANK_REVEAL,
];

/**
 * Hành động CHỈ ĐỌC — không có thay đổi dữ liệu nào để chung transaction, nên
 * được ghi độc lập (`recordStandalone`). Mọi hành động khác bắt buộc ghi trong
 * transaction của chính thao tác (`record`).
 */
export const READ_ONLY_ACTIONS: readonly HrAuditAction[] = [
  HrAuditAction.IDENTITY_REVEAL,
  HrAuditAction.BANK_REVEAL,
  HrAuditAction.FILE_DOWNLOAD,
];
