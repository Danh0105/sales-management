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

import { AttachmentKind } from '../financial-request.constants';
import { FinancialPayment } from './financial-payment.entity';
import { FinancialRefund } from './financial-refund.entity';
import { FinancialRequestItem } from './financial-request-item.entity';
import { FinancialRequest } from './financial-request.entity';

/**
 * Tệp đính kèm (hoá đơn, chứng từ, biên nhận chuyển tiền...). Lưu ở kho riêng
 * ngoài `/uploads` công khai — chỉ tải được qua API có kiểm tra quyền.
 */
@Entity('financial_request_attachments')
@Index('IDX_financial_request_attachments_request', ['requestId'])
@Check(
  'CHK_financial_request_attachments_kind',
  `"kind" IN ('DOCUMENT','INVOICE','PAYMENT_PROOF','REFUND_PROOF','ADJUSTMENT_EVIDENCE','CONTROL_EVIDENCE')`,
)
export class FinancialRequestAttachment {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_request_attachments',
  })
  id!: number;

  @Column({ name: 'request_id', type: 'int' })
  requestId!: number;

  @ManyToOne(() => FinancialRequest, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'request_id',
    foreignKeyConstraintName: 'FK_financial_request_attachments_request',
  })
  request?: FinancialRequest;

  @Column({ name: 'item_id', type: 'int', nullable: true })
  itemId!: number | null;

  @ManyToOne(() => FinancialRequestItem, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'item_id',
    foreignKeyConstraintName: 'FK_financial_request_attachments_item',
  })
  item?: FinancialRequestItem | null;

  @Column({ name: 'payment_id', type: 'int', nullable: true })
  paymentId!: number | null;

  @ManyToOne(() => FinancialPayment, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'payment_id',
    foreignKeyConstraintName: 'FK_financial_request_attachments_payment',
  })
  payment?: FinancialPayment | null;

  @Column({ name: 'refund_id', type: 'int', nullable: true })
  refundId!: number | null;

  @ManyToOne(() => FinancialRefund, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'refund_id',
    foreignKeyConstraintName: 'FK_financial_request_attachments_refund',
  })
  refund?: FinancialRefund | null;

  @Column({ type: 'varchar', length: 30, default: AttachmentKind.DOCUMENT })
  kind!: AttachmentKind;

  @Column({ name: 'storage_path', type: 'varchar', length: 500 })
  storagePath!: string;

  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes!: number;

  @Column({ type: 'varchar', length: 64 })
  sha256!: string;

  @Column({ name: 'uploaded_by_id', type: 'int' })
  uploadedById!: number;

  @Column({
    name: 'uploaded_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  uploadedByName!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ name: 'deleted_by_id', type: 'int', nullable: true })
  deletedById!: number | null;
}
