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
} from 'typeorm';

import {
  ApproverType,
  FinanceRole,
  SignatureSlot,
  StepStatus,
} from '../financial-request.constants';
import { bigintTransformer } from '../financial-money';
import { FinancialRequest } from './financial-request.entity';

/**
 * Bước duyệt của RIÊNG một phiếu — chụp từ định nghĩa quy trình lúc gửi duyệt,
 * nên sửa quy trình sau đó không làm đổi phiếu đang chạy. Mỗi lần gửi lại sau
 * "yêu cầu bổ sung" là một vòng (`round`) mới; vòng cũ giữ nguyên làm lịch sử.
 *
 * `candidateApproverIds`: danh sách người được duyệt bước này (đã loại người
 * đề nghị theo chính sách tự duyệt) — tính lúc bước được kích hoạt, cập nhật
 * lại khi quản trị đổi phân quyền.
 */
@Entity('financial_approval_steps')
@Unique('UQ_financial_approval_steps_order', [
  'requestId',
  'round',
  'stepOrder',
])
@Index('IDX_financial_approval_steps_status', ['status'])
@Check(
  'CHK_financial_approval_steps_status',
  `"status" IN ('WAITING','PENDING','APPROVED','REJECTED','RETURNED','SKIPPED','CANCELLED')`,
)
export class FinancialApprovalStep {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_approval_steps',
  })
  id!: number;

  @Column({ name: 'request_id', type: 'int' })
  requestId!: number;

  @ManyToOne(() => FinancialRequest, (request) => request.steps, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'request_id',
    foreignKeyConstraintName: 'FK_financial_approval_steps_request',
  })
  request?: FinancialRequest;

  @Column({ type: 'smallint' })
  round!: number;

  @Column({ name: 'step_order', type: 'smallint' })
  stepOrder!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

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

  @Column({
    name: 'min_amount',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  minAmount!: number | null;

  @Column({ name: 'can_adjust_amounts', type: 'boolean', default: false })
  canAdjustAmounts!: boolean;

  @Column({ type: 'boolean', default: false })
  skippable!: boolean;

  @Column({
    name: 'candidate_approver_ids',
    type: 'int',
    array: true,
    default: () => "'{}'",
  })
  candidateApproverIds!: number[];

  @Column({ type: 'varchar', length: 20 })
  status!: StepStatus;

  @Column({ name: 'acted_by_id', type: 'int', nullable: true })
  actedById!: number | null;

  @Column({
    name: 'acted_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  actedByName!: string | null;

  /** Người được uỷ quyền duyệt thay ai. */
  @Column({ name: 'on_behalf_of_id', type: 'int', nullable: true })
  onBehalfOfId!: number | null;

  @Column({
    name: 'on_behalf_of_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  onBehalfOfName!: string | null;

  @Column({ name: 'acted_at', type: 'timestamptz', nullable: true })
  actedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
