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

import { OtherCashflowAttachmentKind } from '../other-cashflow.constants';
import { OtherCashflowContract } from './other-cashflow-contract.entity';
import { OtherCashflowEntry } from './other-cashflow-entry.entity';

/**
 * Tệp hợp đồng / chứng từ. Nội dung nằm trong kho tệp riêng (không công
 * khai), chỉ tải qua API có kiểm tra quyền. Xoá mềm (`deletedAt`).
 */
@Entity('other_cashflow_attachments')
@Index('IDX_other_cashflow_attachments_contract', ['contractId'])
@Check(
  'CHK_other_cashflow_attachments_kind',
  `"kind" IN ('CONTRACT','EVIDENCE')`,
)
export class OtherCashflowAttachment {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_other_cashflow_attachments',
  })
  id!: number;

  @Column({ name: 'contract_id', type: 'int' })
  contractId!: number;

  @ManyToOne(() => OtherCashflowContract, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'contract_id',
    foreignKeyConstraintName: 'FK_other_cashflow_attachments_contract',
  })
  contract?: OtherCashflowContract;

  /** Chứng từ gắn với một lần ghi nhận; tệp hợp đồng để NULL. */
  @Column({ name: 'entry_id', type: 'int', nullable: true })
  entryId!: number | null;

  @ManyToOne(() => OtherCashflowEntry, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'entry_id',
    foreignKeyConstraintName: 'FK_other_cashflow_attachments_entry',
  })
  entry?: OtherCashflowEntry | null;

  @Column({ type: 'varchar', length: 20 })
  kind!: OtherCashflowAttachmentKind;

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

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
