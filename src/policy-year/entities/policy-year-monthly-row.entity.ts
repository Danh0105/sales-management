import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
} from 'typeorm';

import { PolicyYear } from './policy-year.entity';
import { numericTransformer } from '../../utils/numeric-transformer';

/** Dòng thông tin nhập theo tháng của một chính sách năm. */
@Entity('policy_year_monthly_rows')
export class PolicyYearMonthlyRow {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => PolicyYear, (p) => p.monthlyRows, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'policy_year_id' })
    policyYear!: PolicyYear;

    @Column({ name: 'policy_year_id' })
    policyYearId!: number;

    @Column({ name: 'row_index', type: 'int', default: 0 })
    rowIndex!: number;

    /** Liên kết tới `subjects[].id` (giá trị logic, không phải PK bảng subjects). */
    @Column({ name: 'subject_id' })
    subjectId!: number;

    @Column({ length: 7 })
    month!: string;

    @Column({ name: 'student_count', type: 'numeric', default: 0, transformer: numericTransformer })
    studentCount!: number;

    @Column({ name: 'unit_price', type: 'numeric', default: 0, transformer: numericTransformer })
    unitPrice!: number;

    @Column({ name: 'months_count', type: 'numeric', default: 0, transformer: numericTransformer })
    monthsCount!: number;

    @Column({ name: 'principal_policy_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    principalPolicyAmount!: number;

    @Column({ name: 'cash_policy_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    cashPolicyAmount!: number;

    @Column({ name: 'equipment_policy_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    equipmentPolicyAmount!: number;

    @Column({ name: 'paid_cash_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    paidCashAmount!: number;

    @Column({ name: 'paid_equipment_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    paidEquipmentAmount!: number;

    @Column({ name: 'calculated_policy_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    calculatedPolicyAmount!: number;

    @Column({ name: 'policy_after_tax_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    policyAfterTaxAmount!: number;

    @Column({ type: 'text', nullable: true })
    note?: string;
}
