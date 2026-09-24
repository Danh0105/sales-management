/**
 * Nguồn thiết bị của đề xuất thiết bị (`requestKind = EQUIPMENT`), do Giám
 * đốc chọn khi duyệt:
 *
 * - `STOCK`    → có sẵn trong kho công ty: phòng kỹ thuật lên lệnh xuất kho.
 * - `SUPPLIER` → mua từ nhà cung cấp: Giám đốc lập phiếu nhập kho dự kiến +
 *                chỉ định người xử lý và người nghiệm thu; người xử lý lập
 *                phiếu nhập kho thật, người nghiệm thu xác nhận hoàn thành
 *                (→ SPENT, chạy về Quản lý thu chi).
 *
 * Đề xuất thiết bị cũ (trước khi có trường này) để trống = `STOCK`.
 */
export enum EquipmentSource {
    STOCK = 'STOCK',
    SUPPLIER = 'SUPPLIER',
}
