import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { bigintTransformer } from '../../financial-request/financial-money';
import { School } from '../../school/schools.entity';
import {
  CashflowDirection,
  OtherCashflowForm,
  OtherCashflowStatus,
} from '../other-cashflow.constants';

/**
 * Hợp đồng thu chi ngoài — gồm nhiều khoản thu và nhiều khoản chi.
 * `amount` = tổng phải thu GỒM thuế (Σ khoản thu), `costAmount` = tổng phải chi
 * gồm thuế (Σ khoản chi); `recordedAmount` = đã thu, `paidCostAmount` = đã chi
 * — cập nhật trong cùng transaction (khoá dòng) với lần thu/chi hoặc huỷ.
 * Lợi nhuận = (amount − incomeVatAmount) − (costAmount − costVatAmount).
 */
@Entity('other_cashflow_contracts')
@Index('IDX_other_cashflow_contracts_status', ['status'])
@Index('IDX_other_cashflow_contracts_created_by', ['createdById'])
@Check('CHK_other_cashflow_contracts_direction', `"direction" IN ('IN','OUT')`)
@Check(
  'CHK_other_cashflow_contracts_status',
  `"status" IN ('PENDING','REJECTED','APPROVED','IN_PROGRESS','COMPLETED','CANCELLED')`,
)
@Check(
  'CHK_other_cashflow_contracts_amount',
  `"amount" >= 0 AND "amount" + "cost_amount" > 0`,
)
@Check('CHK_other_cashflow_contracts_form', `"form" IN ('STANDARD','COMMERCIAL')`)
@Check(
  'CHK_other_cashflow_contracts_vat',
  `"income_vat_amount" >= 0 AND "income_vat_amount" <= "amount" AND "cost_vat_amount" >= 0 AND "cost_vat_amount" <= "cost_amount"`,
)
@Check(
  'CHK_other_cashflow_contracts_costs',
  `"cost_amount" >= 0 AND "paid_cost_amount" >= 0 AND "paid_cost_amount" <= "cost_amount"`,
)
@Check(
  'CHK_other_cashflow_contracts_recorded',
  `"recorded_amount" >= 0 AND "recorded_amount" <= "amount"`,
)
export class OtherCashflowContract {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_other_cashflow_contracts',
  })
  id!: number;

  /**
   * Chỉ hợp đồng lập trước khi gộp thu chi (Thu hoặc Chi); hợp đồng mới và
   * hợp đồng cũ đã sửa lại để trống.
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  direction!: CashflowDirection | null;

  @Column({ type: 'varchar', length: 20, default: OtherCashflowForm.STANDARD })
  form!: OtherCashflowForm;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  /** Số đơn đặt hàng / hợp đồng (đơn Thương mại). */
  @Column({ name: 'document_no', type: 'varchar', length: 100, nullable: true })
  documentNo!: string | null;

  @Column({ name: 'partner_name', type: 'varchar', length: 255 })
  partnerName!: string;

  @Column({ name: 'school_id', type: 'int', nullable: true })
  schoolId!: number | null;

  @ManyToOne(() => School, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'school_id',
    foreignKeyConstraintName: 'FK_other_cashflow_contracts_school',
  })
  school?: School | null;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  @Column({ name: 'signed_date', type: 'date', nullable: true })
  signedDate!: string | null;

  @Column({ name: 'expected_date', type: 'date', nullable: true })
  expectedDate!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 20, default: OtherCashflowStatus.PENDING })
  status!: OtherCashflowStatus;

  @Column({
    name: 'recorded_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  recordedAmount!: number;

  /** Tiền thuế VAT trong `amount` (thuế đầu ra). */
  @Column({
    name: 'income_vat_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  incomeVatAmount!: number;

  /** Tổng các khoản chi, gồm thuế. */
  @Column({
    name: 'cost_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  costAmount!: number;

  @Column({
    name: 'paid_cost_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  paidCostAmount!: number;

  /** Tiền thuế VAT trong `costAmount` (thuế đầu vào). */
  @Column({
    name: 'cost_vat_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  costVatAmount!: number;

  @Column({ name: 'created_by_id', type: 'int' })
  createdById!: number;

  @Column({
    name: 'created_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  createdByName!: string | null;

  @Column({ name: 'submitted_at', type: 'timestamptz' })
  submittedAt!: Date;

  @Column({ name: 'reviewed_by_id', type: 'int', nullable: true })
  reviewedById!: number | null;

  @Column({
    name: 'reviewed_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  reviewedByName!: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: 'review_note', type: 'text', nullable: true })
  reviewNote!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
