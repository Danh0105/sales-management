import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import {
  ApproverType,
  FinanceRole,
  SignatureSlot,
} from '../financial-request.constants';
import { bigintTransformer } from '../financial-money';
import { FinancialApprovalWorkflow } from './financial-approval-workflow.entity';

/** Một cấp duyệt trong định nghĩa quy trình. */
@Entity('financial_workflow_steps')
@Unique('UQ_financial_workflow_steps_order', ['workflowId', 'stepOrder'])
@Check(
  'CHK_financial_workflow_steps_approver',
  `"approver_type" IN ('DIRECT_MANAGER','ROLE','EMPLOYEE')`,
)
@Check(
  'CHK_financial_workflow_steps_role',
  `"approver_role" IS NULL OR "approver_role" IN ('MANAGER','CONTROLLER','ACCOUNTANT','CASHIER','DIRECTOR','ADMIN','VIEWER')`,
)
@Check(
  'CHK_financial_workflow_steps_slot',
  `"signature_slot" IS NULL OR "signature_slot" IN ('MANAGER','CONTROLLER','ACCOUNTANT','DIRECTOR')`,
)
export class FinancialWorkflowStep {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_workflow_steps',
  })
  id!: number;

  @Column({ name: 'workflow_id', type: 'int' })
  workflowId!: number;

  @ManyToOne(() => FinancialApprovalWorkflow, (workflow) => workflow.steps, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'workflow_id',
    foreignKeyConstraintName: 'FK_financial_workflow_steps_workflow',
  })
  workflow?: FinancialApprovalWorkflow;

  @Column({ name: 'step_order', type: 'int' })
  stepOrder!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /** Ô ký tương ứng trên mẫu in; NULL = không in vào 5 ô cố định. */
  @Column({
    name: 'signature_slot',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  signatureSlot!: SignatureSlot | null;

  @Column({ name: 'approver_type', type: 'varchar', length: 20 })
  approverType!: ApproverType;

  @Column({
    name: 'approver_role',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  approverRole!: FinanceRole | null;

  @Column({ name: 'approver_employee_id', type: 'int', nullable: true })
  approverEmployeeId!: number | null;

  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'approver_employee_id',
    foreignKeyConstraintName: 'FK_financial_workflow_steps_employee',
  })
  approverEmployee?: Employee | null;

  /** Chỉ áp dụng khi tổng tiền ≥ ngưỡng này (hạn mức); NULL = luôn áp dụng. */
  @Column({
    name: 'min_amount',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  minAmount!: number | null;

  /** Người duyệt ở cấp này được ghi nhận số tiền chấp nhận cho từng dòng. */
  @Column({ name: 'can_adjust_amounts', type: 'boolean', default: false })
  canAdjustAmounts!: boolean;

  /** Quản trị được bỏ qua cấp này (phải ghi lý do). */
  @Column({ type: 'boolean', default: false })
  skippable!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
