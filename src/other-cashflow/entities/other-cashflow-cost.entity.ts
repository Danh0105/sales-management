import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { bigintTransformer } from '../../financial-request/financial-money';
import { OtherCashflowContract } from './other-cashflow-contract.entity';

/**
 * Khoản chi phí của đơn Thương mại (vận chuyển, hoa hồng…) — công ty phải chi
 * qua quỹ theo lệnh chi của kế toán công nợ. `paidAmount` = tổng các lần chi
 * còn hiệu lực, cập nhật cùng transaction với lần chi/huỷ.
 */
@Entity('other_cashflow_costs')
@Index('IDX_other_cashflow_costs_contract', ['contractId'])
@Check(
  'CHK_other_cashflow_costs_amounts',
  `"amount" > 0 AND "paid_amount" >= 0 AND "paid_amount" <= "amount"`,
)
export class OtherCashflowCost {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_other_cashflow_costs' })
  id!: number;

  @Column({ name: 'contract_id', type: 'int' })
  contractId!: number;

  @ManyToOne(() => OtherCashflowContract, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'contract_id',
    foreignKeyConstraintName: 'FK_other_cashflow_costs_contract',
  })
  contract?: OtherCashflowContract;

  @Column({ name: 'line_no', type: 'int' })
  lineNo!: number;

  @Column({ type: 'varchar', length: 255 })
  description!: string;

  /** Người / đơn vị nhận tiền (không bắt buộc). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  payee!: string | null;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  @Column({
    name: 'paid_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  paidAmount!: number;
}
