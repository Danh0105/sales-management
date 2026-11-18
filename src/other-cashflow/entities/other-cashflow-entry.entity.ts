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

import { bigintTransformer } from '../../financial-request/financial-money';
import { CashflowDirection, EntryStatus } from '../other-cashflow.constants';
import { OtherCashflowContract } from './other-cashflow-contract.entity';
import { OtherCashflowCost } from './other-cashflow-cost.entity';
import { OtherCashflowOrder } from './other-cashflow-order.entity';

/**
 * Một lần thủ quỹ thu/chi thực tế cho hợp đồng. Không sửa/xoá — sai thì huỷ
 * (VOIDED, kèm lý do) rồi ghi lại. `idempotencyKey` chống ghi trùng khi bấm lặp.
 * `flow` là chiều tiền của chính lần này: hợp đồng thường cùng chiều hợp đồng;
 * đơn Thương mại có cả thu (theo phiếu thu) lẫn chi (theo lệnh chi chi phí).
 */
@Entity('other_cashflow_entries')
@Unique('UQ_other_cashflow_entries_idempotency', ['idempotencyKey'])
@Index('IDX_other_cashflow_entries_contract', ['contractId'])
@Check('CHK_other_cashflow_entries_amount', `"amount" > 0`)
@Check(
  'CHK_other_cashflow_entries_status',
  `"status" IN ('RECORDED','VOIDED')`,
)
@Check('CHK_other_cashflow_entries_flow', `"flow" IN ('IN','OUT')`)
export class OtherCashflowEntry {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_other_cashflow_entries' })
  id!: number;

  @Column({ name: 'contract_id', type: 'int' })
  contractId!: number;

  @ManyToOne(() => OtherCashflowContract, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'contract_id',
    foreignKeyConstraintName: 'FK_other_cashflow_entries_contract',
  })
  contract?: OtherCashflowContract;

  @Column({ type: 'varchar', length: 10 })
  flow!: CashflowDirection;

  /** Phiếu thu / lệnh chi của kế toán công nợ (đơn Thương mại). */
  @Column({ name: 'order_id', type: 'int', nullable: true })
  orderId!: number | null;

  @ManyToOne(() => OtherCashflowOrder, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'order_id',
    foreignKeyConstraintName: 'FK_other_cashflow_entries_order',
  })
  order?: OtherCashflowOrder | null;

  /** Khoản chi phí được chi (lần chi của đơn Thương mại). */
  @Column({ name: 'cost_id', type: 'int', nullable: true })
  costId!: number | null;

  @ManyToOne(() => OtherCashflowCost, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'cost_id',
    foreignKeyConstraintName: 'FK_other_cashflow_entries_cost',
  })
  cost?: OtherCashflowCost | null;

  @Column({ name: 'entry_date', type: 'date' })
  entryDate!: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  /** Mã tài khoản tiền (bảng cash_accounts). */
  @Column({ name: 'cash_account_code', type: 'varchar', length: 20 })
  cashAccountCode!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 100 })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 20, default: EntryStatus.RECORDED })
  status!: EntryStatus;

  @Column({ name: 'recorded_by_id', type: 'int' })
  recordedById!: number;

  @Column({
    name: 'recorded_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  recordedByName!: string | null;

  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  @Column({ name: 'voided_by_id', type: 'int', nullable: true })
  voidedById!: number | null;

  @Column({
    name: 'voided_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  voidedByName!: string | null;

  @Column({ name: 'void_reason', type: 'text', nullable: true })
  voidReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
