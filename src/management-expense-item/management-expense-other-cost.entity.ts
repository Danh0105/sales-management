import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

import { ManagementExpenseItem } from './management-expense-item.entity';

/**
 * Chi tiết từng khoản "Chi khác" của một dòng chi ngoài
 * (management_expense_items) → 1 dòng có N khoản chi khác.
 *
 * amount = unitPrice * studentCount * monthsCount (BE tự tính, không tin FE).
 */
@Entity('management_expense_other_costs')
@Index(['managementExpenseItemId'])
@Index(['policyOtherCostId'])
// Không cho trùng cùng 1 khoản chính sách trong 1 dòng (chỉ khi có policyOtherCostId).
@Index('uq_mgmt_other_cost_item_policy', ['managementExpenseItemId', 'policyOtherCostId'], {
    unique: true,
    where: '"policyOtherCostId" IS NOT NULL',
})
export class ManagementExpenseOtherCost {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => ManagementExpenseItem, (item) => item.otherCosts, {
        nullable: false,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'management_expense_item_id' })
    managementExpenseItem!: ManagementExpenseItem;

    @Column({ name: 'management_expense_item_id' })
    managementExpenseItemId!: number;

    /** ID khoản chi trong chính sách (nếu là khoản định nghĩa sẵn), nullable. */
    @Column({ type: 'int', nullable: true })
    policyOtherCostId?: number | null;

    /** Tên khoản chi khác (VD "KT", "TQ"). */
    @Column({ type: 'varchar', length: 255, nullable: true })
    name?: string | null;

    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    unitPrice!: number;

    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    amount!: number;

    /** Đơn giá thuế (tuyệt đối). taxAmount = tax × studentCount × monthsCount. */
    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    tax!: number;

    /** Thuế của khoản này — KHÔNG cộng vào totalOutside, chỉ để báo cáo. */
    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    taxAmount!: number;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
