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
import { Suggest } from './suggest.entity';

/** Một dòng thiết bị trong lệnh xuất kho */
export interface StockIssueItem {
    name: string;
    quantity: number;
    unit?: string | null;
    note?: string | null;
    /** Nếu xuất từ thiết bị có sẵn trong kho — trỏ tới `WarehouseItem.id`. */
    warehouseItemId?: number | null;
}

/**
 * Lệnh xuất kho gắn với 1 đề xuất **thiết bị** (Suggest type = EXPENSE_REQUEST,
 * requestKind = EQUIPMENT). Tương ứng `SuggestPaymentOrder` ở nhánh tiền.
 */
@Entity('suggest_stock_issue_order')
export class SuggestStockIssueOrder {
    @PrimaryGeneratedColumn()
    id!: number;

    /** Số lệnh xuất kho tự sinh: XK-YYYYMM-xxxx */
    @Column({ unique: true })
    code!: string;

    @Column({ unique: true })
    suggestId!: number;

    @OneToOne(() => Suggest, (s) => s.stockIssueOrder, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'suggestId' })
    suggest?: Suggest;

    /** Danh sách thiết bị xuất kho */
    @Column({ type: 'jsonb' })
    items!: StockIssueItem[];

    /** Kho xuất hàng (để trống nếu công ty chỉ có một kho) */
    @Column({ type: 'varchar', length: 255, nullable: true })
    warehouse?: string | null;

    /** Ngày dự kiến giao thiết bị */
    @Column({ type: 'date', name: 'expected_delivery_date', nullable: true })
    expectedDeliveryDate?: string | null;

    @Column({ type: 'text', nullable: true })
    note?: string | null;

    /** Phòng kỹ thuật lập lệnh */
    @Column()
    createdBy!: number;

    @ManyToOne(() => Employee)
    @JoinColumn({ name: 'createdBy' })
    creator?: Employee;

    @CreateDateColumn()
    createdAt!: Date;
}
