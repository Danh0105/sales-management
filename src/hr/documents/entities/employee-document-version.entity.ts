import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Một phiên bản tài liệu = một file của 0.4C (`hr.files`). */
@Entity({
  schema: 'hr',
  name: 'employee_document_versions',
  synchronize: false,
})
export class EmployeeDocumentVersion {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'document_id', type: 'int' })
  documentId: number;

  @Column({ name: 'version_no', type: 'int' })
  versionNo: number;

  @Column({ name: 'file_id', type: 'int' })
  fileId: number;

  @Column({ name: 'change_note', type: 'varchar', length: 500, nullable: true })
  changeNote: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', insert: false })
  createdAt: Date;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;
}
