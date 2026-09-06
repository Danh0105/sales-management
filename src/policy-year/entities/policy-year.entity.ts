import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    OneToMany,
    Index,
} from 'typeorm';

import { PolicyYearStatus } from '../policy-year.enum';
import { PolicyYearSubject } from './policy-year-subject.entity';
import { PolicyYearMonthlyRow } from './policy-year-monthly-row.entity';
import { numericTransformer } from '../../utils/numeric-transformer';

/** Chính sách năm theo trường + năm học (tab "Chính sách năm" ở màn thu chi). */
@Entity('policy_years')
@Index('idx_policy_year_school_year', ['schoolId', 'schoolYear'], { unique: true })
export class PolicyYear {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'school_id' })
    schoolId!: number;

    @Column({ name: 'school_name', nullable: true })
    schoolName?: string;

    @Column({ name: 'school_year', length: 20 })
    schoolYear!: string;

    @Column({
        type: 'enum',
        enum: PolicyYearStatus,
        default: PolicyYearStatus.DRAFT,
    })
    status!: PolicyYearStatus;

    // ===== Summary (FE tính sẵn, BE lưu raw để đối chiếu/báo cáo) =====

    @Column({ name: 'total_students', type: 'numeric', default: 0, transformer: numericTransformer })
    totalStudents!: number;

    @Column({ name: 'total_revenue', type: 'numeric', default: 0, transformer: numericTransformer })
    totalRevenue!: number;

    @Column({ name: 'total_tkd', type: 'numeric', default: 0, transformer: numericTransformer })
    totalTkd!: number;

    @Column({ name: 'total_school_retain', type: 'numeric', default: 0, transformer: numericTransformer })
    totalSchoolRetain!: number;

    @Column({ name: 'total_company_payment', type: 'numeric', default: 0, transformer: numericTransformer })
    totalCompanyPayment!: number;

    @Column({ name: 'total_initial_policy', type: 'numeric', default: 0, transformer: numericTransformer })
    totalInitialPolicy!: number;

    @Column({ name: 'total_policy_after_tax', type: 'numeric', default: 0, transformer: numericTransformer })
    totalPolicyAfterTax!: number;

    @Column({ name: 'total_paid', type: 'numeric', default: 0, transformer: numericTransformer })
    totalPaid!: number;

    @Column({ name: 'total_remaining', type: 'numeric', default: 0, transformer: numericTransformer })
    totalRemaining!: number;

    @OneToMany(() => PolicyYearSubject, (s) => s.policyYear, {
        cascade: true,
    })
    subjects!: PolicyYearSubject[];

    @OneToMany(() => PolicyYearMonthlyRow, (r) => r.policyYear, {
        cascade: true,
    })
    monthlyRows!: PolicyYearMonthlyRow[];

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}
