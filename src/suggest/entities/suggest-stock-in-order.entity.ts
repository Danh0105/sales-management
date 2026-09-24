import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    OneToOne,
    JoinColumn,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import { WarehouseReceipt } from '../../warehouse/entities/warehouse-receipt.entity';
import { Suggest } from './suggest.entity';

/** Một dòng thiết bị trong phiếu nhập kho của đề xuất thiết bị từ nhà cung cấp. */
export interface StockInItem {
    name: string;
    quantity: number;
    unit?: string | null;
    /** Đơn giá mua (không bắt buộc) — tổng tiền dùng làm số tiền đề xuất. */
    unitPrice?: number | null;
    note?: string | null;
    /** Thiết bị đã có mã trong kho; để trống = tạo thiết bị mới khi nhập kho. */
    warehouseItemId?: number | null;
}

/**
 * Phiếu nhập kho gắn với 1 đề xuất thiết bị mua **từ nhà cung cấp**
 * (requestKind = EQUIPMENT, equipmentSource = SUPPLIER).
 *
 * Giám đốc lập phiếu dự kiến (`draftItems`) ngay khi duyệt; người xử lý được
 * chỉ định lập phiếu nhập kho thật (`items` + `warehouseReceiptId`) — lúc đó
 * tồn kho mới thật sự tăng.
 */
@Entity('suggest_stock_in_order')
export class SuggestStockInOrder {
    @PrimaryGeneratedColumn()
    id!: number;

    /** Số phiếu tự sinh: NK-YYYYMM-xxxx */
    @Column({ unique: true })
    code!: string;

    @Column({ unique: true })
    suggestId!: number;

    @OneToOne(() => Suggest, (s) => s.stockInOrder, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'suggestId' })
    suggest?: Suggest;

    /** Danh sách thiết bị Giám đốc lập khi duyệt */
    @Column({ type: 'jsonb', name: 'draft_items' })
    draftItems!: StockInItem[];

    /** Ghi chú của Giám đốc cho người xử lý */
    @Column({ type: 'text', name: 'draft_note', nullable: true })
    draftNote?: string | null;

    /** Giám đốc lập phiếu dự kiến */
    @Column()
    createdBy!: number;

    @ManyToOne(() => Employee)
    @JoinColumn({ name: 'createdBy' })
    creator?: Employee;

    @CreateDateColumn()
    createdAt!: Date;

    /** Danh sách thiết bị thực nhập do người xử lý chốt */
    @Column({ type: 'jsonb', nullable: true })
    items?: StockInItem[] | null;

    @Column({ type: 'text', nullable: true })
    note?: string | null;

    /** Phiếu nhập kho thật (PNK-…) ở module kho */
    @Column({ type: 'int', name: 'warehouse_receipt_id', nullable: true })
    warehouseReceiptId?: number | null;

    @ManyToOne(() => WarehouseReceipt, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'warehouse_receipt_id' })
    warehouseReceipt?: WarehouseReceipt | null;

    @Column({ type: 'int', name: 'stocked_by', nullable: true })
    stockedBy?: number | null;

    @ManyToOne(() => Employee, { nullable: true })
    @JoinColumn({ name: 'stocked_by' })
    stocker?: Employee | null;

    @Column({ type: 'timestamptz', name: 'stocked_at', nullable: true })
    stockedAt?: Date | null;
}
