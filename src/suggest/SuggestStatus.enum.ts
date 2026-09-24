export enum SuggestStatus {
  // ===== luồng đề xuất thường (SUGGESTION) =====
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  REVIEWED = 'REVIEWED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',

  // ===== luồng đề xuất chi (EXPENSE_REQUEST) =====
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  PAYMENT_ORDERED = 'PAYMENT_ORDERED',
  CASH_RELEASED = 'CASH_RELEASED',
  CASH_RECEIVED = 'CASH_RECEIVED',
  SPENT = 'SPENT',
  NOT_SPENT = 'NOT_SPENT',
  FUND_RETURNED = 'FUND_RETURNED',
  /** Người tạo tự rút đơn — tách khỏi REJECTED để không lẫn với việc bị giám đốc từ chối. */
  WITHDRAWN = 'WITHDRAWN',

  // ===== nhánh riêng của ĐỀ XUẤT THIẾT BỊ (kind = EQUIPMENT) =====
  // Sau APPROVED, thiết bị đi qua phòng kỹ thuật thay vì kế toán/thủ quỹ.
  // SPENT / NOT_SPENT vẫn dùng chung với nhánh tiền để mọi thống kê, danh
  // sách quá hạn và trạng thái kết thúc không phải phân nhánh theo loại.

  /** Phòng kỹ thuật đã lên lệnh xuất kho, chờ kinh doanh nhận thiết bị */
  STOCK_ISSUE_ORDERED = 'STOCK_ISSUE_ORDERED',

  /** Kinh doanh đã nhận thiết bị, chờ xác nhận đã dùng / chưa dùng */
  EQUIPMENT_RECEIVED = 'EQUIPMENT_RECEIVED',

  /** Thiết bị chưa dùng đã nhập lại kho — kỹ thuật có thể lên lệnh xuất kho lại */
  EQUIPMENT_RETURNED = 'EQUIPMENT_RETURNED',

  // ===== nhánh riêng của ĐỀ XUẤT SỬA CHỮA (kind = REPAIR) =====
  /** Phòng kỹ thuật đã xác nhận nhận việc sửa chữa */
  REPAIR_ACCEPTED = 'REPAIR_ACCEPTED',

  /** Phòng kỹ thuật từ chối nhận việc sửa chữa (bắt buộc có lý do) */
  REPAIR_REJECTED = 'REPAIR_REJECTED',

  // ===== ĐỀ XUẤT THIẾT BỊ mua từ NHÀ CUNG CẤP (equipmentSource = SUPPLIER) =====
  // APPROVED (Giám đốc đã lập phiếu nhập kho dự kiến) → STOCK_IN_COMPLETED
  // → SPENT khi người nghiệm thu xác nhận hoàn thành.

  /** Người xử lý đã lập phiếu nhập kho thật, chờ người nghiệm thu bàn giao */
  STOCK_IN_COMPLETED = 'STOCK_IN_COMPLETED',
}

/** Trạng thái kết thúc của luồng đề xuất chi — không nhắc/cảnh báo nữa */
export const EXPENSE_TERMINAL_STATUSES: SuggestStatus[] = [
  SuggestStatus.SPENT,
  SuggestStatus.REJECTED,
  SuggestStatus.WITHDRAWN,
  SuggestStatus.REPAIR_ACCEPTED,
  SuggestStatus.REPAIR_REJECTED,
];
