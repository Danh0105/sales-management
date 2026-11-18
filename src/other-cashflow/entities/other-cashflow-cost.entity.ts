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
 * Khoản chi của hợp đồng (mua hàng, vận chuyển, hoa hồng…) — công ty chi qua
 * quỹ: thủ quỹ chi trực tiếp (hình thức Thông thường) hoặc theo lệnh chi của
 * kế toán công nợ (Thương mại). Cách tính tiền như khoản thu: `amount` chưa
 * thuế, `totalAmount` gồm thuế là số phải chi. `paidAmount` = tổng các lần
 * chi còn hiệu lực, cập nhật cùng transaction với lần chi/huỷ.
 */
@Entity('other_cashflow_costs')
@Index('IDX_other_cashflow_costs_contract', ['contractId'])
@Check(
  'CHK_other_cashflow_costs_amounts',
  `"amount" >= 0 AND "total_amount" > 0 AND "paid_amount" >= 0 AND "paid_amount" <= "total_amount"`,
)
@Check('CHK_other_cashflow_costs_values', `"quantity" > 0 AND "unit_price" >= 0`)
@Check(
  'CHK_other_cashflow_costs_vat',
  `("vat_rate" IS NULL OR "vat_rate" BETWEEN 0 AND 100) AND ("vat_rate" IS NOT NULL OR "vat_amount" = 0) AND "vat_amount" >= 0 AND "total_amount" = "amount" + "vat_amount"`,
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

  /** Mã hàng (không bắt buộc). */
  @Column({ name: 'item_code', type: 'varchar', length: 50, nullable: true })
  itemCode!: string | null;

  /** Nội dung khoản chi. */
  @Column({ type: 'varchar', length: 255 })
  description!: string;

  /** Người / đơn vị nhận tiền (không bắt buộc). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  payee!: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  unit!: string | null;

  @Column({ type: 'numeric', precision: 15, scale: 4 })
  quantity!: string;

  @Column({ name: 'unit_price', type: 'numeric', precision: 18, scale: 2 })
  unitPrice!: string;

  /** Thành tiền chưa thuế. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  /** Thuế suất VAT (%); trống = không thuế. */
  @Column({ name: 'vat_rate', type: 'smallint', nullable: true })
  vatRate!: number | null;

  @Column({
    name: 'vat_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  vatAmount!: number;

  /** Số phải chi, gồm thuế. */
  @Column({ name: 'total_amount', type: 'bigint', transformer: bigintTransformer })
  totalAmount!: number;

  @Column({
    name: 'paid_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  paidAmount!: number;
}
