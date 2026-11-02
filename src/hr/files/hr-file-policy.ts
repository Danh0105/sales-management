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
  /** Tài liệu nội bộ thông thường (không chứa định danh) — hiển thị là OTHER từ Phase 1.3. */
  GENERAL = 'GENERAL',
  /** Phase 1.3 — các loại do module Documents quản lý. */
  RESUME = 'RESUME',
  DEGREE = 'DEGREE',
  CERTIFICATE = 'CERTIFICATE',
  HEALTH_CERTIFICATE = 'HEALTH_CERTIFICATE',
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
   * Quyền để xem NỘI DUNG file (kèm scope theo nhân viên sở hữu) — có MỘT
   * trong các quyền là đủ. Rỗng = chưa có quyền tương đương → fail closed:
   * không upload, không truy cập.
   */
  accessPermissions: readonly HrPermission[];
  /** File phải gắn một giấy tờ tuỳ thân của chính nhân viên. */
  identityRelation: boolean;
  /**
   * Phase 1.3 — loại do module Documents quản lý (file = một phiên bản của
   * `hr.employee_documents`). Endpoint upload của 0.4C không nhận loại này.
   */
  managedByDocuments: boolean;
}

const RESTRICTED_DISABLED: DocumentTypePolicy = {
  classification: HrFileClassification.RESTRICTED,
  accessPermissions: [],
  identityRelation: false,
  managedByDocuments: false,
};

export const HR_FILE_DOCUMENT_POLICY: Record<
  HrFileDocumentType,
  DocumentTypePolicy
> = {
  IDENTITY_FRONT: {
    classification: HrFileClassification.RESTRICTED,
    accessPermissions: [HrPermission.IDENTITY_REVEAL],
    identityRelation: true,
    managedByDocuments: false,
  },
  IDENTITY_BACK: {
    classification: HrFileClassification.RESTRICTED,
    accessPermissions: [HrPermission.IDENTITY_REVEAL],
    identityRelation: true,
    managedByDocuments: false,
  },
  BANK_PROOF: {
    classification: HrFileClassification.RESTRICTED,
    accessPermissions: [HrPermission.BANK_REVEAL],
    identityRelation: false,
    managedByDocuments: false,
  },
  // Chưa có quyền xem hợp đồng / thuế / BHXH tương đương — cần permission mới.
  CONTRACT: RESTRICTED_DISABLED,
  TAX: RESTRICTED_DISABLED,
  INSURANCE: RESTRICTED_DISABLED,
  /**
   * Tài liệu nội bộ thông thường. Phase 1.3: hiển thị là `OTHER` ("Tài liệu
   * khác") của Documents — không đổi tên dữ liệu. Xem được bằng FILE_VIEW (như
   * 0.4C) hoặc DOCUMENT_VIEW.
   */
  GENERAL: {
    classification: HrFileClassification.INTERNAL,
    accessPermissions: [HrPermission.FILE_VIEW, HrPermission.DOCUMENT_VIEW],
    identityRelation: false,
    managedByDocuments: false,
  },
  RESUME: {
    classification: HrFileClassification.CONFIDENTIAL,
    accessPermissions: [HrPermission.DOCUMENT_VIEW],
    identityRelation: false,
    managedByDocuments: true,
  },
  DEGREE: {
    classification: HrFileClassification.CONFIDENTIAL,
    accessPermissions: [HrPermission.DOCUMENT_VIEW],
    identityRelation: false,
    managedByDocuments: true,
  },
  CERTIFICATE: {
    classification: HrFileClassification.CONFIDENTIAL,
    accessPermissions: [HrPermission.DOCUMENT_VIEW],
    identityRelation: false,
    managedByDocuments: true,
  },
  /** Dữ liệu sức khoẻ — quyền nhạy cảm riêng, không gán mặc định. */
  HEALTH_CERTIFICATE: {
    classification: HrFileClassification.RESTRICTED,
    accessPermissions: [HrPermission.HEALTH_DOCUMENT_VIEW],
    identityRelation: false,
    managedByDocuments: true,
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
