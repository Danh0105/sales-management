import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Thông tin nhận tiền mỗi người tự lưu để điền sẵn cho các đề nghị sau (một
 * dòng/người). Tách khỏi tài khoản ngân hàng trong hồ sơ nhân viên — tài khoản
 * đó dùng cho bảng lương, phân hệ tài chính không sửa.
 */
@Entity('financial_payee_profiles')
export class FinancialPayeeProfile {
  @PrimaryColumn({
    name: 'employee_id',
    type: 'int',
    primaryKeyConstraintName: 'PK_financial_payee_profiles',
  })
  employeeId!: number;

  @Column({ name: 'payee_name', type: 'varchar', length: 255, nullable: true })
  payeeName!: string | null;

  @Column({
    name: 'bank_account_holder',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  bankAccountHolder!: string | null;

  @Column({ name: 'bank_name', type: 'varchar', length: 255, nullable: true })
  bankName!: string | null;

  @Column({
    name: 'bank_account_number',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  bankAccountNumber!: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
