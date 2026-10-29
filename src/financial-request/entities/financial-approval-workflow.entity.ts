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
  UpdateDateColumn,
} from 'typeorm';

import {
  FinancialRequestType,
  SelfApprovalMode,
} from '../financial-request.constants';
import { FinancialCompany } from './financial-company.entity';
import { FinancialWorkflowStep } from './financial-workflow-step.entity';

/**
 * Định nghĩa quy trình duyệt. Phạm vi: công ty (NULL = mọi công ty) × loại
 * chứng từ (NULL = mọi loại); khi gửi duyệt chọn quy trình cụ thể nhất.
 * Mỗi phạm vi chỉ một quy trình đang hoạt động (index riêng trong migration).
 */
@Entity('financial_approval_workflows')
@Index('UQ_financial_approval_workflows_active_scope', { synchronize: false })
@Check(
  'CHK_financial_approval_workflows_type',
  `"request_type" IS NULL OR "request_type" IN ('ADVANCE','SALARY_ADVANCE','SETTLEMENT','EXPENSE_PAYMENT')`,
)
@Check(
  'CHK_financial_approval_workflows_self',
  `"self_approval_mode" IN ('BLOCK','SKIP_STEP','ALLOW')`,
)
export class FinancialApprovalWorkflow {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_approval_workflows',
  })
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'company_id', type: 'int', nullable: true })
  companyId!: number | null;

  @ManyToOne(() => FinancialCompany, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'company_id',
    foreignKeyConstraintName: 'FK_financial_approval_workflows_company',
  })
  company?: FinancialCompany | null;

  @Column({ name: 'request_type', type: 'varchar', length: 30, nullable: true })
  requestType!: FinancialRequestType | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /** Tuần tự: chỉ cấp đầu tiên chưa xử lý được duyệt. */
  @Column({ name: 'is_sequential', type: 'boolean', default: true })
  isSequential!: boolean;

  @Column({
    name: 'self_approval_mode',
    type: 'varchar',
    length: 20,
    default: SelfApprovalMode.BLOCK,
  })
  selfApprovalMode!: SelfApprovalMode;

  /** Người đề nghị được thu hồi khi phiếu chưa duyệt xong. */
  @Column({ name: 'allow_withdraw', type: 'boolean', default: true })
  allowWithdraw!: boolean;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'created_by_id', type: 'int', nullable: true })
  createdById!: number | null;

  @Column({ name: 'updated_by_id', type: 'int', nullable: true })
  updatedById!: number | null;

  @OneToMany(() => FinancialWorkflowStep, (step) => step.workflow)
  steps?: FinancialWorkflowStep[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
