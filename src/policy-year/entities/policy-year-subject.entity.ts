import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
} from 'typeorm';

import { PolicyYear } from './policy-year.entity';
import { numericTransformer } from '../../utils/numeric-transformer';

/** Cấu hình môn học của một chính sách năm. */
@Entity('policy_year_subjects')
export class PolicyYearSubject {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => PolicyYear, (p) => p.subjects, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'policy_year_id' })
    policyYear!: PolicyYear;

    @Column({ name: 'policy_year_id' })
    policyYearId!: number;

    /** Định danh môn (chính là `subjects[].id` FE gửi, monthlyRows liên kết qua giá trị này). */
    @Column({ name: 'subject_id' })
    subjectId!: number;

    @Column({ nullable: true })
    code?: string;

    @Column({ nullable: true })
    name?: string;

    @Column({ name: 'tuition_price', type: 'numeric', default: 0, transformer: numericTransformer })
    tuitionPrice!: number;

    @Column({ name: 'school_retain_unit', type: 'numeric', default: 0, transformer: numericTransformer })
    schoolRetainUnit!: number;

    @Column({ name: 'policy_total_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    policyTotalAmount!: number;

    @Column({ name: 'policy_student_base', type: 'numeric', default: 0, transformer: numericTransformer })
    policyStudentBase!: number;

    @Column({ name: 'policy_month_base', type: 'numeric', default: 0, transformer: numericTransformer })
    policyMonthBase!: number;

    @Column({ name: 'tax_percent', type: 'numeric', default: 0, transformer: numericTransformer })
    taxPercent!: number;

    @Column({ name: 'company_profit_per_hs', type: 'numeric', default: 0, transformer: numericTransformer })
    companyProfitPerHS!: number;

    @Column({ name: 'cash_support_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    cashSupportAmount!: number;

    @Column({ name: 'equipment_support_amount', type: 'numeric', default: 0, transformer: numericTransformer })
    equipmentSupportAmount!: number;
}
