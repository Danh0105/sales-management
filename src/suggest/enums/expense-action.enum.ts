export enum ExpenseAction {
    CREATE = 'CREATE',
    /** Chủ đề xuất sửa nội dung sau khi đã gửi duyệt. */
    UPDATE = 'UPDATE',
    SALE_ADMIN_REVIEW = 'SALE_ADMIN_REVIEW',
    SALE_ADMIN_REJECT = 'SALE_ADMIN_REJECT',
    APPROVE = 'APPROVE',
    REJECT = 'REJECT',
    /** Chủ đề xuất tự rút đơn khi chưa được duyệt. */
    WITHDRAW = 'WITHDRAW',
    CREATE_PAYMENT_ORDER = 'CREATE_PAYMENT_ORDER',
    /** Kế toán công nợ sửa lệnh chi đã lập — các bước sau phải làm lại. */
    EDIT_PAYMENT_ORDER = 'EDIT_PAYMENT_ORDER',
    CONFIRM_CASH_RELEASED = 'CONFIRM_CASH_RELEASED',
    CONFIRM_CASH_RECEIVED = 'CONFIRM_CASH_RECEIVED',
    CONFIRM_SPENT = 'CONFIRM_SPENT',
    CONFIRM_NOT_SPENT = 'CONFIRM_NOT_SPENT',
    CONFIRM_FUND_RETURNED = 'CONFIRM_FUND_RETURNED',

    // ===== nhánh ĐỀ XUẤT THIẾT BỊ =====
    /** Phòng kỹ thuật lên lệnh xuất kho */
    CREATE_STOCK_ISSUE_ORDER = 'CREATE_STOCK_ISSUE_ORDER',
    /** Kinh doanh xác nhận đã nhận thiết bị */
    CONFIRM_EQUIPMENT_RECEIVED = 'CONFIRM_EQUIPMENT_RECEIVED',
    /** Phòng kỹ thuật xác nhận đã nhận lại thiết bị chưa dùng */
    CONFIRM_EQUIPMENT_RETURNED = 'CONFIRM_EQUIPMENT_RETURNED',

    // ===== nhánh ĐỀ XUẤT SỬA CHỮA =====
    /** Phòng kỹ thuật xác nhận nhận việc sửa chữa */
    ACCEPT_REPAIR = 'ACCEPT_REPAIR',
    /** Phòng kỹ thuật từ chối việc sửa chữa và nêu lý do */
    REJECT_REPAIR = 'REJECT_REPAIR',
    /** Giám đốc/Sales Admin chỉ định người khác sau khi bị từ chối nhận việc */
    REASSIGN_REPAIR = 'REASSIGN_REPAIR',

    // ===== nhánh ĐỀ XUẤT THIẾT BỊ MỚI =====
    /** Người xử lý (do Giám đốc chỉ định) lập phiếu nhập kho thật */
    CREATE_STOCK_IN_RECEIPT = 'CREATE_STOCK_IN_RECEIPT',
    /** Người nghiệm thu (do Giám đốc chỉ định) xác nhận hoàn thành */
    CONFIRM_STOCK_IN_ACCEPTED = 'CONFIRM_STOCK_IN_ACCEPTED',

    // ===== giao việc (không đổi trạng thái đề xuất) =====
    /** Người bàn giao / người hỗ trợ từ chối việc được giao, kèm lý do */
    DECLINE_ASSIGNMENT = 'DECLINE_ASSIGNMENT',
    /** Giám đốc chọn người thay thế cho người đã từ chối */
    REPLACE_ASSIGNMENT = 'REPLACE_ASSIGNMENT',
}
