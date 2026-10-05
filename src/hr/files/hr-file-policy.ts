import { HrPermission } from '../access/hr-permission';

/**
 * Luật tài liệu HR — nơi DUY NHẤT quyết định phân loại, quyền truy cập, giới
 * hạn kích thước và TTL. Client không bao giờ tự chọn classification.
 */

export enum HrFileClassification {
  INTERNAL = 'INTERNAL',
  CONFIDENTIAL = 'CONFIDENTIAL',
  RESTRICTED = 'RESTRICTED',
}

export enum HrFileDocumentType {
  /** Ảnh/scan mặt trước / mặt sau giấy tờ tuỳ thân — gắn `identity_document_id`. */
  IDENTITY_FRONT = 'IDENTITY_FRONT',
  IDENTITY_BACK = 'IDENTITY_BACK',
  /** Giấy xác nhận tài khoản ngân hàng. */
  BANK_PROOF = 'BANK_PROOF',
  CONTRACT = 'CONTRACT',
  TAX = 'TAX',
  INSURANCE = 'INSURANCE',
  /** Tài liệu nội bộ thông thường (không chứa định danh). */
  GENERAL = 'GENERAL',
}

export enum HrFileStatus {
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
  /** Dành cho lifecycle xoá vật lý sau này — 0.4C không đặt trạng thái này. */
  DELETED = 'DELETED',
}

export enum HrFileScanStatus {
  PENDING = 'PENDING',
  CLEAN = 'CLEAN',
  INFECTED = 'INFECTED',
  FAILED = 'FAILED',
  /** Chưa có scanner — KHÔNG được coi là CLEAN. */
  NOT_SCANNED = 'NOT_SCANNED',
}

interface DocumentTypePolicy {
  classification: HrFileClassification;
  /**
   * Quyền để xem NỘI DUNG file (kèm scope theo nhân viên sở hữu). `null` =
   * chưa có quyền tương đương → fail closed: không upload, không truy cập.
   */
  accessPermission: HrPermission | null;
  /** File phải gắn một giấy tờ tuỳ thân của chính nhân viên. */
  identityRelation: boolean;
}

export const HR_FILE_DOCUMENT_POLICY: Record<
  HrFileDocumentType,
  DocumentTypePolicy
> = {
  IDENTITY_FRONT: {
    classification: HrFileClassification.RESTRICTED,
    accessPermission: HrPermission.IDENTITY_REVEAL,
    identityRelation: true,
  },
  IDENTITY_BACK: {
    classification: HrFileClassification.RESTRICTED,
    accessPermission: HrPermission.IDENTITY_REVEAL,
    identityRelation: true,
  },
  BANK_PROOF: {
    classification: HrFileClassification.RESTRICTED,
    accessPermission: HrPermission.BANK_REVEAL,
    identityRelation: false,
  },
  // Chưa có quyền xem hợp đồng / thuế / BHXH tương đương — cần permission mới.
  CONTRACT: {
    classification: HrFileClassification.RESTRICTED,
    accessPermission: null,
    identityRelation: false,
  },
  TAX: {
    classification: HrFileClassification.RESTRICTED,
    accessPermission: null,
    identityRelation: false,
  },
  INSURANCE: {
    classification: HrFileClassification.RESTRICTED,
    accessPermission: null,
    identityRelation: false,
  },
  GENERAL: {
    classification: HrFileClassification.INTERNAL,
    accessPermission: HrPermission.FILE_VIEW,
    identityRelation: false,
  },
};

export const HR_FILE_DOCUMENT_TYPES = Object.values(
  HrFileDocumentType,
) as string[];

/** Upload / lưu trữ file: quyền sửa hồ sơ nhân viên (kèm scope). */
export const HR_FILE_UPLOAD_PERMISSION = HrPermission.EMPLOYEE_EDIT;
/** Xem danh sách metadata (không nội dung). */
export const HR_FILE_LIST_PERMISSION = HrPermission.EMPLOYEE_VIEW;

/** Kích thước tối đa mỗi file (Phase 0: hằng số, một nơi duy nhất). */
export const HR_PRIVATE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Thời hạn URL/token truy cập nội dung. */
export const HR_FILE_ACCESS_TTL_SECONDS = 300;

/** Trạng thái quét được phép tải. NOT_SCANNED được phép (chưa có scanner) nhưng hiển thị rõ. */
export const HR_FILE_DOWNLOADABLE_SCAN_STATUSES: readonly HrFileScanStatus[] = [
  HrFileScanStatus.CLEAN,
  HrFileScanStatus.NOT_SCANNED,
];

export function fileRequiresAccessReason(c: HrFileClassification): boolean {
  return c !== HrFileClassification.INTERNAL;
}
