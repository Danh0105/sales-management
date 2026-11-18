import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import { FinancialRequestType } from '../financial-request.constants';

/** Uỷ quyền duyệt có thời hạn, giới hạn theo công ty / loại chứng từ nếu cần. */
@Entity('financial_approval_delegations')
@Index('IDX_financial_approval_delegations_delegate', ['delegateId'])
@Check('CHK_financial_approval_delegations_period', `"ends_at" > "starts_at"`)
@Check(
  'CHK_financial_approval_delegations_people',
  `"delegator_id" <> "delegate_id"`,
)
export class FinancialApprovalDelegation {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_approval_delegations',
  })
  id!: number;

  @Column({ name: 'delegator_id', type: 'int' })
  delegatorId!: number;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'delegator_id',
    foreignKeyConstraintName: 'FK_financial_approval_delegations_delegator',
  })
  delegator?: Employee;

  @Column({ name: 'delegate_id', type: 'int' })
  delegateId!: number;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'delegate_id',
    foreignKeyConstraintName: 'FK_financial_approval_delegations_delegate',
  })
  delegate?: Employee;

  @Column({ name: 'company_id', type: 'int', nullable: true })
  companyId!: number | null;

  @Column({ name: 'request_type', type: 'varchar', length: 30, nullable: true })
  requestType!: FinancialRequestType | null;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt!: Date;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt!: Date;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'revoked_by_id', type: 'int', nullable: true })
  revokedById!: number | null;

  @Column({ name: 'created_by_id', type: 'int' })
  createdById!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
