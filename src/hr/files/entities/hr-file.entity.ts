import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import {
  HrFileClassification,
  HrFileDocumentType,
  HrFileScanStatus,
  HrFileStatus,
} from '../hr-file-policy';

/**
 * Metadata tài liệu HR. Nội dung ở kho riêng theo `storageKey` — không có URL
 * công khai. `storageKey` / `sha256` không trả ra API danh sách.
 */
@Entity({ schema: 'hr', name: 'files', synchronize: false })
export class HrFile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'storage_key', type: 'varchar', length: 64 })
  storageKey: string;

  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  @Column({ type: 'char', length: 64 })
  sha256: string;

  @Column({ type: 'varchar', length: 16 })
  classification: HrFileClassification;

  @Column({ name: 'document_type', type: 'varchar', length: 32 })
  documentType: HrFileDocumentType;

  @Column({ name: 'owner_employee_id', type: 'int' })
  ownerEmployeeId: number;

  @Column({ name: 'identity_document_id', type: 'int', nullable: true })
  identityDocumentId: number | null;

  @Column({ type: 'varchar', length: 16 })
  status: HrFileStatus;

  @Column({ name: 'scan_status', type: 'varchar', length: 16 })
  scanStatus: HrFileScanStatus;

  @Column({ name: 'uploaded_by', type: 'int', nullable: true })
  uploadedBy: number | null;

  @Column({ name: 'created_at', type: 'timestamptz', insert: false })
  createdAt: Date;

  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @Column({ name: 'archived_by', type: 'int', nullable: true })
  archivedBy: number | null;

  @Column({ name: 'archive_reason', type: 'text', nullable: true })
  archiveReason: string | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @Column({ type: 'int' })
  version: number;
}
