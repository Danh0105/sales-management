import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';

import { numericTransformer } from '../../utils/numeric-transformer';
import { Suggest } from './suggest.entity';

export const POLICY_SUPPORT_TYPES = ['CASH', 'EQUIPMENT'] as const;
export type PolicySupportType = (typeof POLICY_SUPPORT_TYPES)[number];

/**
 * Một dòng hỗ trợ tiền mặt (`httienmat`) / thiết bị (`htthietbi`) trong chính
 * sách đã duyệt mà kinh doanh tích ở Đề xuất chi Năm cho trường, kèm số tiền
 * đề xuất. Dòng chính sách không có id riêng nên định danh bằng chính sách +
 * loại + vị trí trong mảng; nhãn và số tiền chính sách được chụp lại lúc đề
 * xuất. Đề xuất hoàn thành thì `spent_amount` = `amount` (Đã chi của dòng).
 */
@Entity('suggest_policy_support_items')
@Index('IDX_suggest_policy_support_items_suggest', ['suggestId'])
@Index('IDX_suggest_policy_support_items_policy', ['policyId'])
export class SuggestPolicySupportItem {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'int', name: 'suggest_id' })
    suggestId!: number;

    @ManyToOne(() => Suggest, (s) => s.policySupportItems, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'suggest_id' })
    suggest?: Suggest;

    @Column({ type: 'int', name: 'policy_id' })
    policyId!: number;

    @Column({ type: 'int', name: 'subject_id' })
    subjectId!: number;

    @Column({ type: 'varchar', length: 255, name: 'subject_name', nullable: true })
    subjectName!: string | null;

    @Column({ type: 'varchar', length: 20, name: 'support_type' })
    supportType!: PolicySupportType;

    /** Vị trí dòng trong `httienmat` / `htthietbi` của chính sách. */
    @Column({ type: 'int', name: 'item_index' })
    itemIndex!: number;

    @Column({ type: 'varchar', length: 500, nullable: true })
    label!: string | null;

    /** Số tiền của dòng chính sách lúc đề xuất (tiền mặt: Thành tiền thực tế). */
    @Column({
        type: 'numeric',
        name: 'policy_amount',
        precision: 18,
        scale: 2,
        transformer: numericTransformer,
    })
    policyAmount!: number;

    @Column({ type: 'numeric', precision: 18, scale: 2, transformer: numericTransformer })
    amount!: number;

    /** Đã chi ghi khi đề xuất hoàn thành; trống = chưa chi. */
    @Column({
        type: 'numeric',
        name: 'spent_amount',
        precision: 18,
        scale: 2,
        nullable: true,
        transformer: numericTransformer,
    })
    spentAmount!: number | null;

    @Column({ type: 'timestamptz', name: 'spent_at', nullable: true })
    spentAt!: Date | null;

    @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
    createdAt!: Date;
}
