import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { HrSensitiveRecord } from './sensitive-columns';

@Entity({ schema: 'hr', name: 'employee_tax_profiles', synchronize: false })
export class HrEmployeeTaxProfile extends HrSensitiveRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'tax_number_encrypted', type: 'text' })
  taxNumberEncrypted: string;

  @Column({ name: 'tax_number_last4', type: 'varchar', length: 4 })
  taxNumberLast4: string;

  @Column({ name: 'tax_number_hash', type: 'varchar', length: 96 })
  taxNumberHash: string;
}
