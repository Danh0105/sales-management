import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { HrSensitiveRecord } from './sensitive-columns';

@Entity({ schema: 'hr', name: 'employee_bank_accounts', synchronize: false })
export class HrEmployeeBankAccount extends HrSensitiveRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'bank_code', type: 'varchar', length: 20 })
  bankCode: string;

  @Column({ name: 'bank_name', type: 'varchar', length: 200 })
  bankName: string;

  @Column({ name: 'branch_name', type: 'varchar', length: 200, nullable: true })
  branchName: string | null;

  @Column({ name: 'account_holder_name', type: 'varchar', length: 200 })
  accountHolderName: string;

  @Column({ name: 'account_number_encrypted', type: 'text' })
  accountNumberEncrypted: string;

  @Column({ name: 'account_number_last4', type: 'varchar', length: 4 })
  accountNumberLast4: string;

  @Column({ name: 'account_number_hash', type: 'varchar', length: 96 })
  accountNumberHash: string;
}
