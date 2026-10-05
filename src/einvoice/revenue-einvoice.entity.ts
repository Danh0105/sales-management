import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { Subject } from '../subject/subject.entity';
import type { InvoiceItem } from './revenue-einvoice.calculator';

export enum RevenueEInvoiceStatus {
  /** Viettel đã nhận hóa đơn nháp — kế toán duyệt/ký trên portal Viettel. */
  DraftCreated = 'DRAFT_CREATED',
  Failed = 'FAILED',
}

/**
 * Hóa đơn điện tử (nháp Viettel) gộp các dòng doanh thu "Xuất HĐ Cty" của 1
 * môn trong kỳ thu chi — mỗi dòng doanh thu là 1 dòng hàng (`lines`).
 *
 * Dòng gắn theo rowIndex chứ không theo revenue_items.id vì "save-all" xóa rồi
 * tạo lại toàn bộ dòng doanh thu mỗi lần lưu.
 * transactionUuid cố định cho mỗi hóa đơn: Viettel từ chối uuid đã lập hóa đơn
 * (TRANSACTION_UUID_INVALID), nên gửi lại không bao giờ sinh nháp trùng.
 */
@Entity('revenue_einvoices')
@Index('IDX_revenue_einvoices_subject', ['schoolExpenseId', 'subjectId'])
export class RevenueEInvoice {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => SchoolExpense, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'school_expense_id',
    foreignKeyConstraintName: 'FK_revenue_einvoices_school_expense',
  })
  schoolExpense?: SchoolExpense;

  @Column({ name: 'school_expense_id', type: 'int' })
  schoolExpenseId!: number;

  @ManyToOne(() => Subject, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'subject_id',
    foreignKeyConstraintName: 'FK_revenue_einvoices_subject',
  })
  subject?: Subject;

  @Column({ name: 'subject_id', type: 'int' })
  subjectId!: number;

  /**
   * Chỉ có ở hóa đơn tạo theo cách cũ (mỗi dòng 1 hóa đơn, `lines` rỗng) —
   * dòng doanh thu của hóa đơn đó. Hóa đơn gộp để null.
   */
  @Column({ name: 'row_index', type: 'int', nullable: true })
  legacyRowIndex!: number | null;

  /**
   * MST tài khoản Viettel (bên bán) chứa hóa đơn nháp. Đổi tài khoản (vd: test
   * → chính thức) thì nháp cũ không thuộc tài khoản mới nữa.
   */
  @Column({
    name: 'supplier_tax_code',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  supplierTaxCode!: string | null;

  @Index('UQ_revenue_einvoices_transaction_uuid', { unique: true })
  @Column({ name: 'transaction_uuid', type: 'uuid' })
  transactionUuid!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: RevenueEInvoiceStatus;

  /** Dòng hàng đã gửi Viettel, theo thứ tự rowIndex. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  lines!: InvoiceItem[];

  /** Tổng tiền hóa đơn (không chịu thuế GTGT). */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  amount!: string;

  @Column({ name: 'buyer_name', type: 'varchar', length: 500 })
  buyerName!: string;

  @Column({ name: 'buyer_tax_code', type: 'varchar', length: 20 })
  buyerTaxCode!: string;

  /** sha256 nội dung hóa đơn (trừ transactionUuid) — để biết dữ liệu các dòng đã đổi kể từ lần gửi trước. */
  @Column({ name: 'payload_hash', type: 'varchar', length: 64, nullable: true })
  payloadHash!: string | null;

  @Column({
    name: 'viettel_transaction_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  viettelTransactionId!: string | null;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'raw_request', type: 'jsonb', nullable: true })
  rawRequest!: Record<string, unknown> | null;

  @Column({ name: 'raw_response', type: 'jsonb', nullable: true })
  rawResponse!: Record<string, unknown> | null;

  /** Lần gần nhất Viettel nhận nháp thành công (giữ lại cả khi lần cập nhật sau bị lỗi). */
  @Column({ name: 'drafted_at', type: 'timestamptz', nullable: true })
  draftedAt!: Date | null;

  @Column({ name: 'exported_by', type: 'int', nullable: true })
  exportedBy!: number | null;

  @Column({
    name: 'exported_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  exportedByName!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
