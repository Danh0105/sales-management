import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { HrSensitiveRecord } from './sensitive-columns';

/**
 * Mã số BHXH (10 số). Thẻ BHYT hiện dùng chính mã số BHXH làm định danh nên
 * không lưu cột riêng.
 */
@Entity({
  schema: 'hr',
  name: 'employee_insurance_profiles',
  synchronize: false,
})
export class HrEmployeeInsuranceProfile extends HrSensitiveRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'social_insurance_number_encrypted', type: 'text' })
  socialInsuranceNumberEncrypted: string;

  @Column({ name: 'social_insurance_number_last4', type: 'varchar', length: 4 })
  socialInsuranceNumberLast4: string;

  @Column({ name: 'social_insurance_number_hash', type: 'varchar', length: 96 })
  socialInsuranceNumberHash: string;
}
