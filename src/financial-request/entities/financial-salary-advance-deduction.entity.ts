import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import { Payroll } from '../../payroll/entities/payroll.entity';
import { DeductionRowStatus } from '../financial-request.constants';
import { bigintTransformer } from '../financial-money';
import { FinancialRequest } from './financial-request.entity';

/**
 * Kế hoạch / kết quả khấu trừ tạm ứng lương theo từng kỳ lương. Chỉ sinh ra
 * sau khi khoản ứng đã thực chi. Duy nhất theo (phiếu, kỳ) nên một kỳ không
 * thể bị trừ hai lần cho cùng một khoản ứng.
 */
@Entity('financial_salary_advance_deductions')
@Unique('UQ_financial_salary_advance_deductions_period', [
  'requestId',
  'periodYear',
  'periodMonth',
])
@Unique('UQ_financial_salary_advance_deductions_idempotency', [
  'idempotencyKey',
])
@Index('IDX_financial_salary_advance_deductions_employee_period', [
  'employeeId',
  'periodYear',
  'periodMonth',
])
@Check(
  'CHK_financial_salary_advance_deductions_status',
  `"status" IN ('PLANNED','DEDUCTED','CANCELLED')`,
)
@Check(
  'CHK_financial_salary_advance_deductions_amounts',
  `"planned_amount" >= 0 AND ("deducted_amount" IS NULL OR "deducted_amount" >= 0) AND "period_month" BETWEEN 1 AND 12`,
)
export class FinancialSalaryAdvanceDeduction {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_salary_advance_deductions',
  })
  id!: number;

  @Column({ name: 'request_id', type: 'int' })
  requestId!: number;

  @ManyToOne(() => FinancialRequest, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'request_id',
    foreignKeyConstraintName: 'FK_financial_salary_advance_deductions_request',
  })
  request?: FinancialRequest;

  @Column({ name: 'employee_id', type: 'int' })
  employeeId!: number;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'employee_id',
    foreignKeyConstraintName: 'FK_financial_salary_advance_deductions_employee',
  })
  employee?: Employee;

  @Column({ name: 'period_year', type: 'smallint' })
  periodYear!: number;

  @Column({ name: 'period_month', type: 'smallint' })
  periodMonth!: number;

  @Column({
    name: 'planned_amount',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  plannedAmount!: number;

  @Column({
    name: 'deducted_amount',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  deductedAmount!: number | null;

  @Column({ type: 'varchar', length: 20, default: DeductionRowStatus.PLANNED })
  status!: DeductionRowStatus;

  @Column({ name: 'payroll_id', type: 'int', nullable: true })
  payrollId!: number | null;

  @ManyToOne(() => Payroll, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'payroll_id',
    foreignKeyConstraintName: 'FK_financial_salary_advance_deductions_payroll',
  })
  payroll?: Payroll | null;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  idempotencyKey!: string | null;

  @Column({ name: 'deducted_at', type: 'timestamptz', nullable: true })
  deductedAt!: Date | null;

  @Column({ name: 'deducted_by_id', type: 'int', nullable: true })
  deductedById!: number | null;

  @Column({
    name: 'deducted_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  deductedByName!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
