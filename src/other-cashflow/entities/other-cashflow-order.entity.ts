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

import { bigintTransformer } from '../../financial-request/financial-money';
import { OrderKind, OrderStatus } from '../other-cashflow.constants';
import { OtherCashflowContract } from './other-cashflow-contract.entity';
import { OtherCashflowCost } from './other-cashflow-cost.entity';

/**
 * Phiếu thu (tiền hàng) / lệnh chi (một khoản chi phí) do kế toán công nợ lập
 * cho đơn Thương mại — thủ quỹ thu/chi đúng số tiền trên phiếu. Lần thu/chi bị
 * huỷ thì phiếu về lại "chờ"; phiếu chưa thực hiện huỷ được (kèm lý do).
 */
@Entity('other_cashflow_orders')
@Index('IDX_other_cashflow_orders_contract', ['contractId'])
@Check('CHK_other_cashflow_orders_amount', `"amount" > 0`)
@Check(
  'CHK_other_cashflow_orders_kind',
  `("kind" = 'RECEIPT' AND "cost_id" IS NULL) OR ("kind" = 'PAYMENT' AND "cost_id" IS NOT NULL)`,
)
@Check(
  'CHK_other_cashflow_orders_status',
  `"status" IN ('PENDING','EXECUTED','CANCELLED')`,
)
export class OtherCashflowOrder {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_other_cashflow_orders' })
  id!: number;

  @Column({ name: 'contract_id', type: 'int' })
  contractId!: number;

  @ManyToOne(() => OtherCashflowContract, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'contract_id',
    foreignKeyConstraintName: 'FK_other_cashflow_orders_contract',
  })
  contract?: OtherCashflowContract;

  @Column({ type: 'varchar', length: 20 })
  kind!: OrderKind;

  @Column({ name: 'cost_id', type: 'int', nullable: true })
  costId!: number | null;

  @ManyToOne(() => OtherCashflowCost, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'cost_id',
    foreignKeyConstraintName: 'FK_other_cashflow_orders_cost',
  })
  cost?: OtherCashflowCost | null;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 20, default: OrderStatus.PENDING })
  status!: OrderStatus;

  @Column({ name: 'created_by_id', type: 'int' })
  createdById!: number;

  @Column({
    name: 'created_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  createdByName!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({
    name: 'cancelled_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  cancelledByName!: string | null;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
