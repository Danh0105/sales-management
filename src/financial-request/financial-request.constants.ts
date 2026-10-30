/**
 * Phân hệ ĐỀ NGHỊ TÀI CHÍNH NỘI BỘ — hằng số dùng chung.
 *
 * Trạng thái lưu dạng varchar + CHECK (không dùng enum Postgres) để bổ sung
 * giá trị sau này chỉ cần đổi CHECK, không phải `ALTER TYPE`.
 *
 * Ba trục trạng thái độc lập: phê duyệt (`approvalStatus`), chi tiền
 * (`paymentStatus`) và quyết toán/thu hồi/khấu trừ. Duyệt xong KHÔNG có nghĩa
 * là đã chi, và chi xong KHÔNG có nghĩa là đã quyết toán.
 */

import { DEPARTMENT_HEAD_ROLES } from '../employee/employee-positions';

export enum FinancialRequestType {
  /** Giấy đề nghị tạm ứng. */
  ADVANCE = 'ADVANCE',
  /** Giấy đề nghị tạm ứng lương. */
  SALARY_ADVANCE = 'SALARY_ADVANCE',
  /** Giấy đề nghị hoàn ứng (quyết toán tạm ứng). */
  SETTLEMENT = 'SETTLEMENT',
  /** Giấy đề nghị thanh toán chi phí / công tác phí. */
  EXPENSE_PAYMENT = 'EXPENSE_PAYMENT',
}

export const REQUEST_TYPE_VALUES = Object.values(FinancialRequestType);

export const REQUEST_TYPE_LABELS: Record<FinancialRequestType, string> = {
  [FinancialRequestType.ADVANCE]: 'Tạm ứng',
  [FinancialRequestType.SALARY_ADVANCE]: 'Tạm ứng lương',
  [FinancialRequestType.SETTLEMENT]: 'Hoàn ứng',
  [FinancialRequestType.EXPENSE_PAYMENT]: 'Thanh toán chi phí',
};

/** Tiêu đề in trên phiếu. */
export const REQUEST_TYPE_TITLES: Record<FinancialRequestType, string> = {
  [FinancialRequestType.ADVANCE]: 'GIẤY ĐỀ NGHỊ TẠM ỨNG',
  [FinancialRequestType.SALARY_ADVANCE]: 'GIẤY ĐỀ NGHỊ TẠM ỨNG LƯƠNG',
  [FinancialRequestType.SETTLEMENT]: 'GIẤY ĐỀ NGHỊ HOÀN ỨNG',
  [FinancialRequestType.EXPENSE_PAYMENT]:
    'GIẤY ĐỀ NGHỊ THANH TOÁN CHI PHÍ / CÔNG TÁC PHÍ',
};

/** Tiền tố mã chứng từ: TU-2026-00001. */
export const REQUEST_CODE_PREFIX: Record<FinancialRequestType, string> = {
  [FinancialRequestType.ADVANCE]: 'TU',
  [FinancialRequestType.SALARY_ADVANCE]: 'UL',
  [FinancialRequestType.SETTLEMENT]: 'HU',
  [FinancialRequestType.EXPENSE_PAYMENT]: 'TT',
};

export enum ApprovalStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  /** Người duyệt yêu cầu bổ sung — người đề nghị sửa rồi gửi lại. */
  RETURNED = 'RETURNED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  /** Huỷ sau duyệt (có lý do) hoặc xoá bản nháp. */
  CANCELLED = 'CANCELLED',
}

export enum PaymentStatus {
  /** Chưa phát sinh nghĩa vụ chi (chưa duyệt, hoặc hoàn ứng không phải trả thêm). */
  NONE = 'NONE',
  UNPAID = 'UNPAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
}

/** Chỉ dùng cho phiếu hoàn ứng có chi phí được duyệt nhỏ hơn tiền tạm ứng. */
export enum RecoveryStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  PARTIAL = 'PARTIAL',
  RECOVERED = 'RECOVERED',
}

/**
 * Một cột cho hai loại phiếu:
 * - Tạm ứng: NOT_SETTLED / PARTIALLY_SETTLED / SETTLED (theo phân bổ hoàn ứng).
 * - Hoàn ứng: PENDING_PAYMENT / PENDING_REFUND / COMPLETED (theo chênh lệch).
 */
export enum SettlementStatus {
  NONE = 'NONE',
  NOT_SETTLED = 'NOT_SETTLED',
  PARTIALLY_SETTLED = 'PARTIALLY_SETTLED',
  SETTLED = 'SETTLED',
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PENDING_REFUND = 'PENDING_REFUND',
  COMPLETED = 'COMPLETED',
}

export enum DeductionStatus {
  NONE = 'NONE',
  NOT_DEDUCTED = 'NOT_DEDUCTED',
  DEDUCTING = 'DEDUCTING',
  DEDUCTED = 'DEDUCTED',
}

export enum StepStatus {
  /** Chưa tới lượt (quy trình tuần tự). */
  WAITING = 'WAITING',
  /** Đang chờ người duyệt xử lý. */
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  SKIPPED = 'SKIPPED',
  /** Vòng duyệt bị thu hồi / thay bằng vòng mới. */
  CANCELLED = 'CANCELLED',
}

export enum ApproverType {
  /** Quản lý trực tiếp ghi trên phiếu. */
  DIRECT_MANAGER = 'DIRECT_MANAGER',
  /** Bất kỳ ai giữ vai trò tài chính tương ứng trong phạm vi công ty/phòng ban. */
  ROLE = 'ROLE',
  /** Một nhân viên cụ thể. */
  EMPLOYEE = 'EMPLOYEE',
}

/** Vai trò trong phân hệ tài chính — gán theo phạm vi công ty/phòng ban. */
export enum FinanceRole {
  MANAGER = 'MANAGER',
  CONTROLLER = 'CONTROLLER',
  ACCOUNTANT = 'ACCOUNTANT',
  CASHIER = 'CASHIER',
  DIRECTOR = 'DIRECTOR',
  ADMIN = 'ADMIN',
  VIEWER = 'VIEWER',
}

export const FINANCE_ROLE_VALUES = Object.values(FinanceRole);

export const FINANCE_ROLE_LABELS: Record<FinanceRole, string> = {
  [FinanceRole.MANAGER]: 'Quản lý trực tiếp',
  [FinanceRole.CONTROLLER]: 'Bộ phận kiểm soát',
  [FinanceRole.ACCOUNTANT]: 'Kế toán',
  [FinanceRole.CASHIER]: 'Thủ quỹ',
  [FinanceRole.DIRECTOR]: 'Giám đốc duyệt',
  [FinanceRole.ADMIN]: 'Quản trị phân hệ',
  [FinanceRole.VIEWER]: 'Xem báo cáo',
};

/**
 * Vai trò tài chính mặc định suy từ role hệ thống, phạm vi mọi công ty.
 * Giữ hẹp: chỉ những vị trí vốn đã nắm toàn bộ số liệu tài chính. Mọi vai trò
 * khác (quản lý trực tiếp, kiểm soát, kế toán viên...) phải gán ở màn Cấu hình.
 */
export const IMPLICIT_FINANCE_ROLES: Record<string, FinanceRole[]> = {
  director: [FinanceRole.ADMIN, FinanceRole.DIRECTOR],
  ketoan_truong: [FinanceRole.ACCOUNTANT],
  thuquy: [FinanceRole.CASHIER],
};

/**
 * Role hệ thống được chọn làm quản lý trực tiếp ở mọi công ty/phòng ban, ngoài
 * những người được gán vai trò MANAGER ở màn Cấu hình. Không suy ra vai trò
 * MANAGER: họ chỉ thấy và duyệt phiếu ghi họ là quản lý trực tiếp.
 */
export const DIRECT_MANAGER_SYSTEM_ROLES = [
  'director',
  'director_la',
  ...DEPARTMENT_HEAD_ROLES,
];

/** Người lập phiếu lương — được ghi nhận khấu trừ tạm ứng lương. */
export const PAYROLL_DEDUCTION_SYSTEM_ROLES = ['nhansu', 'ketoan_truong'];

/** Vị trí ký trên mẫu giấy (5 ô). Ô đầu luôn là người đề nghị. */
export enum SignatureSlot {
  MANAGER = 'MANAGER',
  CONTROLLER = 'CONTROLLER',
  ACCOUNTANT = 'ACCOUNTANT',
  DIRECTOR = 'DIRECTOR',
}

export const SIGNATURE_SLOT_LABELS: Record<SignatureSlot, string> = {
  [SignatureSlot.MANAGER]: 'Quản lý trực tiếp',
  [SignatureSlot.CONTROLLER]: 'Bộ phận kiểm soát',
  [SignatureSlot.ACCOUNTANT]: 'Kế toán',
  [SignatureSlot.DIRECTOR]: 'Giám đốc duyệt',
};

/** Người đề nghị trùng người duyệt của một bước. */
export enum SelfApprovalMode {
  /** Loại người đề nghị khỏi danh sách duyệt; bước không còn ai thì không gửi được. */
  BLOCK = 'BLOCK',
  /** Bỏ qua bước đó (ghi rõ lý do), chuyển cấp kế tiếp. */
  SKIP_STEP = 'SKIP_STEP',
  /** Cho phép tự duyệt. */
  ALLOW = 'ALLOW',
}

export enum PaymentMethod {
  BANK_TRANSFER = 'BANK_TRANSFER',
  CASH = 'CASH',
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.BANK_TRANSFER]: 'Chuyển khoản',
  [PaymentMethod.CASH]: 'Tiền mặt',
};

export enum InvoiceType {
  VAT = 'VAT',
  NON_VAT = 'NON_VAT',
  NONE = 'NONE',
}

export enum AttachmentKind {
  DOCUMENT = 'DOCUMENT',
  INVOICE = 'INVOICE',
  PAYMENT_PROOF = 'PAYMENT_PROOF',
  REFUND_PROOF = 'REFUND_PROOF',
  /** Bằng chứng cho thao tác huỷ/điều chỉnh sau duyệt. */
  ADJUSTMENT_EVIDENCE = 'ADJUSTMENT_EVIDENCE',
  /** Chứng từ Bộ phận kiểm soát đính kèm khi duyệt cấp của mình. */
  CONTROL_EVIDENCE = 'CONTROL_EVIDENCE',
}

/** Cấp duyệt của Bộ phận kiểm soát: chọn tài khoản tiền + đính kèm chứng từ. */
export const isControlStep = (step: {
  approverRole: FinanceRole | null;
  signatureSlot: SignatureSlot | null;
}) =>
  step.approverRole === FinanceRole.CONTROLLER ||
  step.signatureSlot === SignatureSlot.CONTROLLER;

export enum MovementStatus {
  RECORDED = 'RECORDED',
  VOIDED = 'VOIDED',
}

export enum DeductionRowStatus {
  PLANNED = 'PLANNED',
  DEDUCTED = 'DEDUCTED',
  CANCELLED = 'CANCELLED',
}

/** Nhãn thao tác trong nhật ký. */
export enum AuditAction {
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  DELETED = 'DELETED',
  SUBMITTED = 'SUBMITTED',
  WITHDRAWN = 'WITHDRAWN',
  APPROVED_STEP = 'APPROVED_STEP',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
  STEP_SKIPPED = 'STEP_SKIPPED',
  AMOUNTS_ADJUSTED = 'AMOUNTS_ADJUSTED',
  CANCELLED = 'CANCELLED',
  COPIED = 'COPIED',
  ATTACHMENT_ADDED = 'ATTACHMENT_ADDED',
  ATTACHMENT_REMOVED = 'ATTACHMENT_REMOVED',
  PAYMENT_RECORDED = 'PAYMENT_RECORDED',
  PAYMENT_VOIDED = 'PAYMENT_VOIDED',
  REFUND_RECORDED = 'REFUND_RECORDED',
  REFUND_VOIDED = 'REFUND_VOIDED',
  ALLOCATION_APPLIED = 'ALLOCATION_APPLIED',
  DEDUCTION_PLANNED = 'DEDUCTION_PLANNED',
  DEDUCTION_CONFIRMED = 'DEDUCTION_CONFIRMED',
  DEDUCTION_CANCELLED = 'DEDUCTION_CANCELLED',
  SETTLEMENT_COMPLETED = 'SETTLEMENT_COMPLETED',
}

/** Phiếu còn "sống" — giữ chỗ số dư tạm ứng / suất ứng lương trong kỳ. */
export const ACTIVE_APPROVAL_STATUSES = [
  ApprovalStatus.PENDING,
  ApprovalStatus.RETURNED,
  ApprovalStatus.APPROVED,
];

/** Ngưỡng an toàn của bigint khi đổi sang number (≈ 9 triệu tỷ VND). */
export const MAX_MONEY = 999_999_999_999_999;

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 10;

export const FINANCE_NOTIFICATION_ROUTE = '/finance/requests';
