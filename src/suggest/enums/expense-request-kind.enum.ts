/**
 * Đề xuất chi được chia làm hai loại, đi hai nhánh xử lý khác nhau **sau khi
 * được duyệt** (bước tạo và bước duyệt là chung):
 *
 * - `CASH`      → kế toán công nợ lên lệnh chi, thủ quỹ xuất tiền.
 * - `EQUIPMENT` → phòng kỹ thuật lên lệnh xuất kho, giao thiết bị.
 */
export enum ExpenseRequestKind {
    /** Đề xuất tiền */
    CASH = 'CASH',

    /** Đề xuất thiết bị */
    EQUIPMENT = 'EQUIPMENT',
}
