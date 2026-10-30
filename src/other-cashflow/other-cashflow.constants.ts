/**
 * Thu Chi ngoài — hợp đồng thu/chi khác ngoài chính sách trường:
 * NV kinh doanh lập → Giám đốc duyệt → Thủ quỹ ghi nhận thu/chi (nhiều lần
 * tới khi đủ số tiền hợp đồng). Mỗi lần ghi nhận là một bút toán trong báo
 * cáo Tổng hợp thu chi theo tài khoản thủ quỹ chọn.
 *
 * Thu khác hình thức Thương mại (đơn đặt hàng / hợp đồng bán hàng): có dòng
 * hàng (mã, SL, đơn giá) và các khoản chi phí; sau khi duyệt đi luồng công nợ
 * như Đề xuất chi — kế toán công nợ lập phiếu thu (tiền hàng) / lệnh chi
 * (từng khoản chi phí), thủ quỹ thực thu / thực chi theo phiếu.
 */

export enum CashflowDirection {
  /** Thu: công ty nhận tiền. */
  IN = 'IN',
  /** Chi: công ty trả tiền. */
  OUT = 'OUT',
}

export enum OtherCashflowStatus {
  /** Chờ giám đốc duyệt. */
  PENDING = 'PENDING',
  /** Giám đốc từ chối — người lập sửa rồi gửi lại được. */
  REJECTED = 'REJECTED',
  /** Đã duyệt, thủ quỹ chưa ghi nhận đồng nào. */
  APPROVED = 'APPROVED',
  /** Đã ghi nhận một phần. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Đã ghi nhận đủ số tiền hợp đồng. */
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum OtherCashflowForm {
  /** Thu/chi thông thường — thủ quỹ ghi nhận trực tiếp. */
  STANDARD = 'STANDARD',
  /** Thương mại (chỉ Thu): đơn đặt hàng/hợp đồng có dòng hàng + chi phí, qua kế toán công nợ. */
  COMMERCIAL = 'COMMERCIAL',
}

export enum OrderKind {
  /** Phiếu thu tiền hàng. */
  RECEIPT = 'RECEIPT',
  /** Lệnh chi một khoản chi phí. */
  PAYMENT = 'PAYMENT',
}

export enum OrderStatus {
  /** Chờ thủ quỹ thu/chi. */
  PENDING = 'PENDING',
  EXECUTED = 'EXECUTED',
  CANCELLED = 'CANCELLED',
}

export enum EntryStatus {
  RECORDED = 'RECORDED',
  /** Ghi sai — huỷ kèm lý do, không xoá. */
  VOIDED = 'VOIDED',
}

export enum OtherCashflowAttachmentKind {
  /** Hợp đồng, phụ lục — người lập tải lên. */
  CONTRACT = 'CONTRACT',
  /** Chứng từ thu/chi của một lần ghi nhận — thủ quỹ tải lên. */
  EVIDENCE = 'EVIDENCE',
}

export const DIRECTION_LABELS: Record<CashflowDirection, string> = {
  [CashflowDirection.IN]: 'Thu',
  [CashflowDirection.OUT]: 'Chi',
};

export const FORM_LABELS: Record<OtherCashflowForm, string> = {
  [OtherCashflowForm.STANDARD]: 'Thông thường',
  [OtherCashflowForm.COMMERCIAL]: 'Thương mại',
};

export const STATUS_LABELS: Record<OtherCashflowStatus, string> = {
  [OtherCashflowStatus.PENDING]: 'Chờ giám đốc duyệt',
  [OtherCashflowStatus.REJECTED]: 'Bị từ chối',
  [OtherCashflowStatus.APPROVED]: 'Đã duyệt — chờ ghi nhận',
  [OtherCashflowStatus.IN_PROGRESS]: 'Đang thu/chi',
  [OtherCashflowStatus.COMPLETED]: 'Hoàn tất',
  [OtherCashflowStatus.CANCELLED]: 'Đã huỷ',
};

/** Người lập còn sửa / gửi lại / huỷ được. */
export const EDITABLE_STATUSES = [
  OtherCashflowStatus.PENDING,
  OtherCashflowStatus.REJECTED,
];

/** Thủ quỹ còn ghi nhận được. */
export const RECORDABLE_STATUSES = [
  OtherCashflowStatus.APPROVED,
  OtherCashflowStatus.IN_PROGRESS,
];

/** NV kinh doanh — chỉ thấy hợp đồng mình lập. */
export const OTHER_CASHFLOW_CREATE_ROLES = ['sales', 'employee', 'employee_la'];

export const OTHER_CASHFLOW_APPROVE_ROLES = ['director', 'director_la'];

/**
 * Kế toán trưởng có toàn quyền của kế toán công nợ và thủ quỹ — cùng quy ước
 * với luồng Đề xuất chi (suggest/constants/expense-roles.ts).
 */
export const OTHER_CASHFLOW_RECORD_ROLES = ['thuquy', 'ketoan_truong'];

/** Lập phiếu thu / lệnh chi cho đơn Thương mại. */
export const OTHER_CASHFLOW_DEBT_ROLES = ['ketoan_congno', 'ketoan_truong'];

/** Xem mọi hợp đồng (chỉ xem, trừ thao tác của đúng vai trò ở trên). */
export const OTHER_CASHFLOW_VIEW_ALL_ROLES = [
  ...OTHER_CASHFLOW_APPROVE_ROLES,
  ...OTHER_CASHFLOW_RECORD_ROLES,
  ...OTHER_CASHFLOW_DEBT_ROLES,
  'troly_gd',
  'accountant',
  'saleadmin',
  'salesadmin',
  'salesadmin_la',
];

/** Giống MAX_MONEY của đề nghị tài chính — luôn < Number.MAX_SAFE_INTEGER. */
export const MAX_AMOUNT = 999_999_999_999_999;

/** Số dòng tối đa của một đơn Thương mại. */
export const MAX_ITEMS = 200;
export const MAX_COSTS = 50;

export const ATTACHMENT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
export const ATTACHMENT_MAX_FILES_PER_UPLOAD = 10;
/** Tổng số tệp còn hiệu lực của một hợp đồng (cả hợp đồng lẫn chứng từ). */
export const ATTACHMENT_MAX_FILES_PER_CONTRACT = 30;

/** Thư mục con trong kho tệp riêng (financial-storage), không công khai. */
export const STORAGE_FOLDER = 'other-cashflow';

/** `meta.kind` của thông báo — FE dựa vào đây để mở đúng hợp đồng. */
export const NOTIFICATION_KIND = 'other_cashflow';

export function contractCode(id: number): string {
  return `TCN-${String(id).padStart(5, '0')}`;
}
