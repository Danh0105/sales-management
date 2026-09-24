/**
 * Đề xuất chi được chia làm các loại, đi các nhánh xử lý khác nhau **sau khi
 * được duyệt** (bước tạo và bước duyệt là chung). Giám đốc/Sales Admin có thể
 * chốt lại loại này ngay khi duyệt (xem `ApproveExpenseDto`):
 *
 * - `CASH`      → kế toán công nợ lên lệnh chi, thủ quỹ xuất tiền.
 * - `EQUIPMENT` → phòng kỹ thuật lên lệnh xuất kho, giao thiết bị.
 * - `REPAIR`    → phòng kỹ thuật cử người sửa chữa, không xuất kho.
 *
 * Đề xuất thiết bị còn chia theo nguồn (kho / nhà cung cấp) — xem
 * `EquipmentSource`.
 */
export enum ExpenseRequestKind {
    /** Đề xuất tiền */
    CASH = 'CASH',

    /** Đề xuất thiết bị */
    EQUIPMENT = 'EQUIPMENT',

    /** Đề xuất sửa chữa */
    REPAIR = 'REPAIR',
}
