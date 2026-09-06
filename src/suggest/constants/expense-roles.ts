// Role slugs theo hệ thống hiện tại (employee.roles: text[])
export const ExpenseRole = {
    /** Kinh doanh — tạo đề xuất, xác nhận nhận tiền, xác nhận đã chi / chưa chi */
    SALES: 'sales',

    /** Giám đốc — duyệt hoặc từ chối đề xuất */
    DIRECTOR: 'director',

    /** Kế toán công nợ — lên lệnh chi */
    DEBT_ACCOUNTANT: 'ketoan_congno',

    /** Thủ quỹ — xác nhận xuất tiền, xác nhận nhận lại quỹ */
    TREASURER: 'thuquy',

    /**
     * Sales Admin — kiểm duyệt chính sách, đồng thời **duyệt/từ chối đề xuất
     * ngang quyền Giám đốc** (cùng một chốt quyết định, ai xử lý trước cũng
     * được), và nhận thông báo theo dõi.
     */
    SALES_ADMIN: 'saleadmin',
} as const;
