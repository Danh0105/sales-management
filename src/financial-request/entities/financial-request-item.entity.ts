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

import { InvoiceType } from '../financial-request.constants';
import { bigintTransformer } from '../financial-money';
import { FinancialExpenseCategory } from './financial-expense-category.entity';
import { FinancialRequest } from './financial-request.entity';

/**
 * Một dòng chi tiết. `quantity`/`unitPrice` là numeric chính xác (đọc ra dạng
 * chuỗi, không ép sang số thực); `amount` = SL × đơn giá làm tròn tới đồng.
 */
@Entity('financial_request_items')
@Index('IDX_financial_request_items_request', ['requestId'])
@Check(
  'CHK_financial_request_items_amounts',
  `"quantity" >= 0 AND "unit_price" >= 0 AND "amount" >= 0 AND ("approved_amount" IS NULL OR "approved_amount" >= 0)`,
)
@Check(
  'CHK_financial_request_items_invoice_type',
  `"invoice_type" IS NULL OR "invoice_type" IN ('VAT','NON_VAT','NONE')`,
)
export class FinancialRequestItem {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_request_items',
  })
  id!: number;

  @Column({ name: 'request_id', type: 'int' })
  requestId!: number;

  @ManyToOne(() => FinancialRequest, (request) => request.items, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'request_id',
    foreignKeyConstraintName: 'FK_financial_request_items_request',
  })
  request?: FinancialRequest;

  @Column({ name: 'line_no', type: 'smallint' })
  lineNo!: number;

  @Column({ type: 'varchar', length: 500 })
  description!: string;

  @Column({ name: 'category_id', type: 'int', nullable: true })
  categoryId!: number | null;

  @ManyToOne(() => FinancialExpenseCategory, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'category_id',
    foreignKeyConstraintName: 'FK_financial_request_items_category',
  })
  category?: FinancialExpenseCategory | null;

  @Column({
    name: 'category_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  categoryName!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  unit!: string | null;

  @Column({ type: 'numeric', precision: 15, scale: 4 })
  quantity!: string;

  @Column({ name: 'unit_price', type: 'numeric', precision: 18, scale: 2 })
  unitPrice!: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  /** Số tiền được chấp nhận (kế toán/kiểm soát ghi nhận); NULL = bằng số kê khai. */
  @Column({
    name: 'approved_amount',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  approvedAmount!: number | null;

  @Column({ name: 'adjustment_reason', type: 'text', nullable: true })
  adjustmentReason!: string | null;

  @Column({ name: 'adjusted_by_id', type: 'int', nullable: true })
  adjustedById!: number | null;

  @Column({
    name: 'adjusted_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  adjustedByName!: string | null;

  @Column({ name: 'adjusted_at', type: 'timestamptz', nullable: true })
  adjustedAt!: Date | null;

  @Column({ name: 'incurred_date', type: 'date', nullable: true })
  incurredDate!: string | null;

  @Column({
    name: 'invoice_number',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  invoiceNumber!: string | null;

  @Column({ name: 'invoice_type', type: 'varchar', length: 10, nullable: true })
  invoiceType!: InvoiceType | null;

  @Column({
    name: 'supplier_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  supplierName!: string | null;

  /** Ghi chú / giải trình chi phí. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  /** Vượt định mức danh mục tại thời điểm lưu. */
  @Column({ name: 'over_limit', type: 'boolean', default: false })
  overLimit!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
