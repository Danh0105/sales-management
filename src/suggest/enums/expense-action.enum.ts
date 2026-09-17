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
}
