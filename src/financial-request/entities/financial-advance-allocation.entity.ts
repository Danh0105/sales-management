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

import { bigintTransformer } from '../financial-money';
import { FinancialRequest } from './financial-request.entity';

/**
 * Phiếu hoàn ứng đem đối trừ bao nhiêu từ một phiếu tạm ứng. Một tạm ứng có
 * thể được hoàn ứng nhiều lần; một hoàn ứng có thể đối trừ nhiều tạm ứng.
 *
 * Phân bổ chỉ "giữ chỗ" số dư khi phiếu hoàn ứng đang chờ duyệt/đã duyệt; được
 * ghi nhận vào tạm ứng (`appliedAt`) khi phiếu hoàn ứng duyệt xong.
 */
@Entity('financial_advance_allocations')
@Unique('UQ_financial_advance_allocations_pair', ['settlementId', 'advanceId'])
@Index('IDX_financial_advance_allocations_advance', ['advanceId'])
@Check('CHK_financial_advance_allocations_amount', `"amount" > 0`)
@Check(
  'CHK_financial_advance_allocations_distinct',
  `"settlement_id" <> "advance_id"`,
)
export class FinancialAdvanceAllocation {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_advance_allocations',
  })
  id!: number;

  @Column({ name: 'settlement_id', type: 'int' })
  settlementId!: number;

  @ManyToOne(() => FinancialRequest, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'settlement_id',
    foreignKeyConstraintName: 'FK_financial_advance_allocations_settlement',
  })
  settlement?: FinancialRequest;

  @Column({ name: 'advance_id', type: 'int' })
  advanceId!: number;

  @ManyToOne(() => FinancialRequest, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'advance_id',
    foreignKeyConstraintName: 'FK_financial_advance_allocations_advance',
  })
  advance?: FinancialRequest;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true })
  appliedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
