import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { DocumentType } from '../document-policy';

export type DocumentStatus = 'ACTIVE' | 'ARCHIVED';

/** Tài liệu nghiệp vụ của nhân viên (Phase 1.3). Không lưu số hiệu giấy tờ. */
@Entity({ schema: 'hr', name: 'employee_documents', synchronize: false })
export class EmployeeDocument {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'employee_id', type: 'int' })
  employeeId: number;

  @Column({ name: 'document_type', type: 'varchar', length: 32 })
  documentType: DocumentType;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  issuer: string | null;

  @Column({ name: 'issued_on', type: 'date', nullable: true })
  issuedOn: string | null;

  @Column({ name: 'expires_on', type: 'date', nullable: true })
  expiresOn: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'varchar', length: 16 })
  status: DocumentStatus;

  @Column({ name: 'current_version_id', type: 'int', nullable: true })
  currentVersionId: number | null;

  @Column({ type: 'int' })
  version: number;

  @Column({ name: 'created_at', type: 'timestamptz', insert: false })
  createdAt: Date;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'updated_at', type: 'timestamptz', insert: false })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;

  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @Column({ name: 'archived_by', type: 'int', nullable: true })
  archivedBy: number | null;

  @Column({ name: 'archive_reason', type: 'text', nullable: true })
  archiveReason: string | null;
}
