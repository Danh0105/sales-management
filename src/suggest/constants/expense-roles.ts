// Role slugs theo hệ thống hiện tại (employee.roles: text[])
export const ExpenseRole = {
    /** Kinh doanh — tạo đề xuất, xác nhận nhận tiền, xác nhận đã chi / chưa chi */
    SALES: 'sales',

    /** Giáo viên công ty — được tạo và xử lý đề nghị của chính mình. */
    STAFF_TEACHER: 'giaovien_congty',

    /** Giám đốc — duyệt hoặc từ chối đề xuất */
    DIRECTOR: 'director',

    /** Kế toán công nợ — lên lệnh chi */
    DEBT_ACCOUNTANT: 'ketoan_congno',

    /** Thủ quỹ — xác nhận xuất tiền, xác nhận nhận lại quỹ */
    TREASURER: 'thuquy',

    /**
     * Kế toán trưởng — có toàn quyền của kế toán công nợ, kế toán và thủ quỹ
     * trong luồng đề xuất chi. Đi kèm mọi `@Roles`/danh sách nhận thông báo có
     * DEBT_ACCOUNTANT hoặc TREASURER, chứ không thay thế hai role đó.
     */
    CHIEF_ACCOUNTANT: 'ketoan_truong',

    /** Kế toán — xem/ghi các khoản chi trường (school-expenses) cùng kế toán công nợ. */
    ACCOUNTANT: 'accountant',

    /**
     * Sales Admin — kiểm duyệt chính sách, đồng thời **duyệt/từ chối đề xuất
     * ngang quyền Giám đốc** (cùng một chốt quyết định, ai xử lý trước cũng
     * được), và nhận thông báo theo dõi.
     */
    SALES_ADMIN: 'saleadmin',

    /**
     * Phòng kỹ thuật — xử lý đề xuất thiết bị và phản hồi đề xuất sửa chữa.
     */
    TECHNICAL: 'ky_thuat',
} as const;

/** Vai trò chủ đơn, không bao gồm quyền duyệt/kế toán/thủ quỹ. */
export const EXPENSE_REQUESTER_ROLES: string[] = [
    ExpenseRole.SALES,
    ExpenseRole.STAFF_TEACHER,
];
