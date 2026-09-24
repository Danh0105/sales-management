import {
  Column,
  Check,
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
import { numericTransformer } from '../../utils/numeric-transformer';
import { PayrollStatus } from '../payroll-status.enum';

const moneyColumn = {
  type: 'numeric' as const,
  precision: 15,
  scale: 2,
  default: 0,
  transformer: numericTransformer,
};

const dayColumn = {
  type: 'numeric' as const,
  precision: 7,
  scale: 2,
  default: 0,
  transformer: numericTransformer,
};

/** Phiếu lương tháng của một nhân viên. */
@Entity('payrolls')
@Unique('UQ_payroll_employee_period', ['employeeId', 'year', 'month'])
@Index('IDX_payroll_period', ['year', 'month'])
@Check('CHK_payroll_month', '"month" BETWEEN 1 AND 12')
@Check('CHK_payroll_year', '"year" BETWEEN 2000 AND 2100')
export class Payroll {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'employee_id', type: 'int' })
  employeeId!: number;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'employee_id' })
  employee!: Employee;

  /** Snapshot để phiếu cũ không đổi khi nhân viên đổi tên/chức vụ. */
  @Column({ name: 'employee_name', type: 'varchar', length: 255 })
  employeeName!: string;

  @Column({ name: 'job_title', type: 'varchar', length: 255, nullable: true })
  jobTitle!: string | null;

  @Column({ type: 'smallint' })
  month!: number;

  @Column({ type: 'smallint' })
  year!: number;

  @Column({ name: 'standard_working_days', ...dayColumn })
  standardWorkingDays!: number;

  @Column({ name: 'probation_working_days', ...dayColumn })
  probationWorkingDays!: number;

  @Column({ name: 'official_working_days', ...dayColumn })
  officialWorkingDays!: number;

  @Column({ name: 'annual_leave_days', ...dayColumn })
  annualLeaveDays!: number;

  @Column({ name: 'holiday_days', ...dayColumn })
  holidayDays!: number;

  @Column({ name: 'unpaid_leave_days', ...dayColumn })
  unpaidLeaveDays!: number;

  @Column({ name: 'leave_note', type: 'text', nullable: true })
  leaveNote!: string | null;

  @Column({ name: 'excess_periods', ...dayColumn })
  excessPeriods!: number;

  @Column({ name: 'remaining_leave_previous_year', ...dayColumn })
  remainingLeavePreviousYear!: number;

  @Column({ name: 'remaining_leave_current_year', ...dayColumn })
  remainingLeaveCurrentYear!: number;

  /** Mức lương theo hợp đồng; chỉ để tham chiếu, không cộng trực tiếp vào tổng thu nhập. */
  @Column({ name: 'base_salary', ...moneyColumn })
  baseSalary!: number;

  @Column({ name: 'official_work_salary', ...moneyColumn })
  officialWorkSalary!: number;

  @Column({ name: 'probation_work_salary', ...moneyColumn })
  probationWorkSalary!: number;

  @Column({ name: 'fuel_allowance', ...moneyColumn })
  fuelAllowance!: number;

  @Column({ name: 'overtime_allowance', ...moneyColumn })
  overtimeAllowance!: number;

  @Column({ name: 'excess_period_allowance', ...moneyColumn })
  excessPeriodAllowance!: number;

  @Column({ name: 'other_support', ...moneyColumn })
  otherSupport!: number;

  @Column({ ...moneyColumn })
  bonus!: number;

  @Column({ name: 'total_income', ...moneyColumn })
  totalIncome!: number;

  @Column({ name: 'social_insurance', ...moneyColumn })
  socialInsurance!: number;

  @Column({ name: 'personal_income_tax', ...moneyColumn })
  personalIncomeTax!: number;

  /** Tạm ứng/truy thu là số dương; truy lãnh là số âm. */
  @Column({ name: 'adjustment_amount', ...moneyColumn })
  adjustmentAmount!: number;

  @Column({ name: 'adjustment_note', type: 'text', nullable: true })
  adjustmentNote!: string | null;

  @Column({ name: 'advance_payment', ...moneyColumn })
  advancePayment!: number;

  @Column({ name: 'total_deduction', ...moneyColumn })
  totalDeduction!: number;

  @Column({ name: 'net_salary', ...moneyColumn })
  netSalary!: number;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  /**
   * Phiếu luôn tạo ở trạng thái nháp — nhân viên chỉ thấy phiếu của mình sau
   * khi người lập bấm "Gửi phiếu lương" (xem `PayrollService.send`).
   */
  @Column({
    type: 'enum',
    enum: PayrollStatus,
    default: PayrollStatus.DRAFT,
  })
  status!: PayrollStatus;

  @Column({ name: 'sent_at', type: 'timestamp', nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'sent_by_id', type: 'int', nullable: true })
  sentById!: number | null;

  @Column({
    name: 'sent_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  sentByName!: string | null;

  @Column({ name: 'created_by_id', type: 'int' })
  createdById!: number;

  @Column({
    name: 'created_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  createdByName!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
