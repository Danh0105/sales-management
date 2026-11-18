import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../utils/numeric-transformer';
import { bigintTransformer } from '../financial-money';

/**
 * Chính sách áp dụng: `scopeKey` = 'GLOBAL' hoặc 'COMPANY:<id>' (công ty ghi
 * đè mặc định). Trống = không giới hạn.
 */
@Entity('financial_policies')
@Unique('UQ_financial_policies_scope', ['scopeKey'])
@Check(
  'CHK_financial_policies_over_limit',
  `"expense_over_limit_mode" IN ('WARN','BLOCK')`,
)
export class FinancialPolicy {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_financial_policies' })
  id!: number;

  @Column({ name: 'scope_key', type: 'varchar', length: 30 })
  scopeKey!: string;

  @Column({ name: 'salary_advance_max_per_month', type: 'int', nullable: true })
  salaryAdvanceMaxPerMonth!: number | null;

  @Column({
    name: 'salary_advance_max_amount',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  salaryAdvanceMaxAmount!: number | null;

  /** % tối đa so với lương dự kiến (vd. 50.00). */
  @Column({
    name: 'salary_advance_max_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  salaryAdvanceMaxPercent!: number | null;

  /** Số kỳ lương tối đa được chia khấu trừ. */
  @Column({ name: 'max_deduction_periods', type: 'int', default: 1 })
  maxDeductionPeriods!: number;

  /** Hạn hoàn ứng mặc định = ngày dự kiến sử dụng + số ngày này. */
  @Column({ name: 'advance_due_days', type: 'int', default: 30 })
  advanceDueDays!: number;

  @Column({ name: 'reminder_days_before', type: 'int', default: 3 })
  reminderDaysBefore!: number;

  /** Dòng chi vượt định mức danh mục: cảnh báo hay chặn gửi duyệt. */
  @Column({
    name: 'expense_over_limit_mode',
    type: 'varchar',
    length: 10,
    default: 'WARN',
  })
  expenseOverLimitMode!: 'WARN' | 'BLOCK';

  @Column({ name: 'updated_by_id', type: 'int', nullable: true })
  updatedById!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
