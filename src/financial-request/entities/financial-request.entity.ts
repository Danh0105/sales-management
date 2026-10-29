import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Department } from '../../department/department.entity';
import { Employee } from '../../employee/employee.entity';
import {
  ApprovalStatus,
  DeductionStatus,
  FinancialRequestType,
  PaymentMethod,
  PaymentStatus,
  RecoveryStatus,
  SettlementStatus,
} from '../financial-request.constants';
import { bigintTransformer } from '../financial-money';
import { FinancialApprovalStep } from './financial-approval-step.entity';
import { FinancialCompany } from './financial-company.entity';
import { FinancialRequestItem } from './financial-request-item.entity';

const money = (name: string) =>
  ({
    name,
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  }) as const;

/**
 * Chứng từ đề nghị tài chính — một bảng chung cho cả 4 loại (tạm ứng, tạm ứng
 * lương, hoàn ứng, thanh toán chi phí), phân biệt bằng `type`. Thông tin người
 * đề nghị/phòng ban được chụp lại lúc lập để phiếu cũ không đổi theo hồ sơ.
 *
 * Mọi số tiền là số nguyên VND và do backend tính — không nhận từ client.
 */
@Entity('financial_requests')
@Unique('UQ_financial_requests_code', ['code'])
@Index('IDX_financial_requests_company_date', ['companyId', 'requestDate'])
@Index('IDX_financial_requests_requester', ['requesterId'])
@Index('IDX_financial_requests_approval_status', ['approvalStatus'])
@Index('IDX_financial_requests_type', ['type'])
@Check(
  'CHK_financial_requests_type',
  `"type" IN ('ADVANCE','SALARY_ADVANCE','SETTLEMENT','EXPENSE_PAYMENT')`,
)
@Check(
  'CHK_financial_requests_approval_status',
  `"approval_status" IN ('DRAFT','PENDING','RETURNED','APPROVED','REJECTED','CANCELLED')`,
)
@Check(
  'CHK_financial_requests_payment_status',
  `"payment_status" IN ('NONE','UNPAID','PARTIALLY_PAID','PAID')`,
)
@Check(
  'CHK_financial_requests_recovery_status',
  `"recovery_status" IN ('NONE','PENDING','PARTIAL','RECOVERED')`,
)
@Check(
  'CHK_financial_requests_settlement_status',
  `"settlement_status" IN ('NONE','NOT_SETTLED','PARTIALLY_SETTLED','SETTLED','PENDING_PAYMENT','PENDING_REFUND','COMPLETED')`,
)
@Check(
  'CHK_financial_requests_deduction_status',
  `"deduction_status" IN ('NONE','NOT_DEDUCTED','DEDUCTING','DEDUCTED')`,
)
@Check(
  'CHK_financial_requests_payment_method',
  `"payment_method" IS NULL OR "payment_method" IN ('BANK_TRANSFER','CASH')`,
)
@Check(
  'CHK_financial_requests_amounts',
  `"total_amount" >= 0 AND "offset_amount" >= 0 AND "paid_amount" >= 0 AND "recovered_amount" >= 0 AND "settled_amount" >= 0 AND "deducted_amount" >= 0 AND ("approved_amount" IS NULL OR "approved_amount" >= 0)`,
)
@Check(
  'CHK_financial_requests_salary_month',
  `("salary_month" IS NULL OR "salary_month" BETWEEN 1 AND 12) AND ("deduction_start_month" IS NULL OR "deduction_start_month" BETWEEN 1 AND 12)`,
)
export class FinancialRequest {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_financial_requests' })
  id!: number;

  @Column({ type: 'varchar', length: 30 })
  code!: string;

  @Column({ type: 'varchar', length: 30 })
  type!: FinancialRequestType;

  @Column({ name: 'company_id', type: 'int' })
  companyId!: number;

  @ManyToOne(() => FinancialCompany, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'company_id',
    foreignKeyConstraintName: 'FK_financial_requests_company',
  })
  company?: FinancialCompany;

  // ---- Người đề nghị (ảnh chụp lúc lập) ----
  @Column({ name: 'requester_id', type: 'int' })
  requesterId!: number;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'requester_id',
    foreignKeyConstraintName: 'FK_financial_requests_requester',
  })
  requester?: Employee;

  @Column({ name: 'requester_name', type: 'varchar', length: 255 })
  requesterName!: string;

  @Column({
    name: 'requester_code',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  requesterCode!: string | null;

  @Column({
    name: 'requester_position',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  requesterPosition!: string | null;

  @Column({ name: 'department_id', type: 'int', nullable: true })
  departmentId!: number | null;

  @ManyToOne(() => Department, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'department_id',
    foreignKeyConstraintName: 'FK_financial_requests_department',
  })
  department?: Department | null;

  @Column({
    name: 'department_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  departmentName!: string | null;

  @Column({ name: 'direct_manager_id', type: 'int', nullable: true })
  directManagerId!: number | null;

  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'direct_manager_id',
    foreignKeyConstraintName: 'FK_financial_requests_manager',
  })
  directManager?: Employee | null;

  @Column({
    name: 'direct_manager_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  directManagerName!: string | null;

  // ---- Nội dung ----
  @Column({ name: 'request_date', type: 'date' })
  requestDate!: string;

  /** Nội dung đề nghị. */
  @Column({ type: 'varchar', length: 500 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  purpose!: string | null;

  @Column({
    name: 'project_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  projectName!: string | null;

  @Column({ name: 'expected_use_date', type: 'date', nullable: true })
  expectedUseDate!: string | null;

  /** Hạn hoàn ứng (phiếu tạm ứng). */
  @Column({ name: 'settlement_due_date', type: 'date', nullable: true })
  settlementDueDate!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  location!: string | null;

  @Column({ name: 'trip_start_date', type: 'date', nullable: true })
  tripStartDate!: string | null;

  @Column({ name: 'trip_end_date', type: 'date', nullable: true })
  tripEndDate!: string | null;

  // ---- Tạm ứng lương ----
  @Column({ name: 'salary_year', type: 'smallint', nullable: true })
  salaryYear!: number | null;

  @Column({ name: 'salary_month', type: 'smallint', nullable: true })
  salaryMonth!: number | null;

  @Column({
    name: 'expected_salary',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  expectedSalary!: number | null;

  @Column({ name: 'deduction_start_year', type: 'smallint', nullable: true })
  deductionStartYear!: number | null;

  @Column({ name: 'deduction_start_month', type: 'smallint', nullable: true })
  deductionStartMonth!: number | null;

  @Column({ name: 'deduction_periods', type: 'smallint', nullable: true })
  deductionPeriods!: number | null;

  // ---- Nhận tiền ----
  @Column({ name: 'payee_name', type: 'varchar', length: 255, nullable: true })
  payeeName!: string | null;

  @Column({
    name: 'bank_account_holder',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  bankAccountHolder!: string | null;

  @Column({ name: 'bank_name', type: 'varchar', length: 255, nullable: true })
  bankName!: string | null;

  @Column({
    name: 'bank_account_number',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  bankAccountNumber!: string | null;

  @Column({
    name: 'payment_method',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  paymentMethod!: PaymentMethod | null;

  @Column({ name: 'payment_note', type: 'text', nullable: true })
  paymentNote!: string | null;

  // ---- Số tiền (backend tính) ----
  @Column({ type: 'varchar', length: 3, default: 'VND' })
  currency!: string;

  @Column(money('total_amount'))
  totalAmount!: number;

  @Column({
    name: 'approved_amount',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  approvedAmount!: number | null;

  /** Hoàn ứng: tổng tiền tạm ứng đem đối trừ. */
  @Column(money('offset_amount'))
  offsetAmount!: number;

  /** Tổng đã chi cho nhân viên (phiếu chi chưa huỷ). */
  @Column(money('paid_amount'))
  paidAmount!: number;

  /** Tổng đã thu lại từ nhân viên (phiếu thu chưa huỷ). */
  @Column(money('recovered_amount'))
  recoveredAmount!: number;

  /** Tạm ứng: phần đã được phiếu hoàn ứng đã duyệt đối trừ. */
  @Column(money('settled_amount'))
  settledAmount!: number;

  /** Tạm ứng lương: phần đã khấu trừ vào lương. */
  @Column(money('deducted_amount'))
  deductedAmount!: number;

  // ---- Trạng thái (độc lập) ----
  @Column({
    name: 'approval_status',
    type: 'varchar',
    length: 20,
    default: ApprovalStatus.DRAFT,
  })
  approvalStatus!: ApprovalStatus;

  @Column({
    name: 'payment_status',
    type: 'varchar',
    length: 20,
    default: PaymentStatus.NONE,
  })
  paymentStatus!: PaymentStatus;

  @Column({
    name: 'recovery_status',
    type: 'varchar',
    length: 20,
    default: RecoveryStatus.NONE,
  })
  recoveryStatus!: RecoveryStatus;

  @Column({
    name: 'settlement_status',
    type: 'varchar',
    length: 20,
    default: SettlementStatus.NONE,
  })
  settlementStatus!: SettlementStatus;

  @Column({
    name: 'deduction_status',
    type: 'varchar',
    length: 20,
    default: DeductionStatus.NONE,
  })
  deductionStatus!: DeductionStatus;

  // ---- Quy trình ----
  @Column({ name: 'workflow_id', type: 'int', nullable: true })
  workflowId!: number | null;

  @Column({
    name: 'workflow_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  workflowName!: string | null;

  @Column({ name: 'is_sequential', type: 'boolean', default: true })
  isSequential!: boolean;

  @Column({ name: 'current_round', type: 'smallint', default: 0 })
  currentRound!: number;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ name: 'rejected_at', type: 'timestamptz', nullable: true })
  rejectedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason!: string | null;

  @Column({ name: 'copied_from_id', type: 'int', nullable: true })
  copiedFromId!: number | null;

  /** Khoá lạc quan cho sửa bản nháp. */
  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ name: 'created_by_id', type: 'int' })
  createdById!: number;

  @Column({
    name: 'created_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  createdByName!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @OneToMany(() => FinancialRequestItem, (item) => item.request)
  items?: FinancialRequestItem[];

  @OneToMany(() => FinancialApprovalStep, (step) => step.request)
  steps?: FinancialApprovalStep[];
}
