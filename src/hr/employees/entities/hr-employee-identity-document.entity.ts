import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { HrSensitiveRecord } from './sensitive-columns';

export enum HrIdentityDocumentType {
  CCCD = 'CCCD',
  CMND = 'CMND',
  PASSPORT = 'PASSPORT',
  WORK_PERMIT = 'WORK_PERMIT',
}

@Entity({
  schema: 'hr',
  name: 'employee_identity_documents',
  synchronize: false,
})
export class HrEmployeeIdentityDocument extends HrSensitiveRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'document_type', type: 'varchar', length: 16 })
  documentType: HrIdentityDocumentType;

  @Column({ name: 'number_encrypted', type: 'text' })
  numberEncrypted: string;

  @Column({ name: 'number_last4', type: 'varchar', length: 4 })
  numberLast4: string;

  @Column({ name: 'number_hash', type: 'varchar', length: 96 })
  numberHash: string;

  @Column({ name: 'issued_on', type: 'date', nullable: true })
  issuedOn: string | null;

  @Column({ name: 'expires_on', type: 'date', nullable: true })
  expiresOn: string | null;

  @Column({
    name: 'issued_place',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  issuedPlace: string | null;
}
