import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Hồ sơ công ty in trên chứng từ (tên, MST, địa chỉ, logo, mã biểu mẫu).
 * Hệ thống chưa có bảng công ty nên phân hệ tài chính tự quản lý; không có dữ
 * liệu mặc định — quản trị nhập ở màn Cấu hình.
 */
@Entity('financial_companies')
@Unique('UQ_financial_companies_code', ['code'])
export class FinancialCompany {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_companies',
  })
  id!: number;

  @Column({ type: 'varchar', length: 30 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'short_name', type: 'varchar', length: 100, nullable: true })
  shortName!: string | null;

  @Column({ name: 'tax_code', type: 'varchar', length: 30, nullable: true })
  taxCode!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  /** Đường dẫn tương đối trong kho file riêng của phân hệ (không public). */
  @Column({ name: 'logo_path', type: 'varchar', length: 500, nullable: true })
  logoPath!: string | null;

  /** Mã biểu mẫu theo loại chứng từ, vd. `{ "ADVANCE": "BM-TC01" }`. */
  @Column({ name: 'form_codes', type: 'jsonb', default: () => "'{}'" })
  formCodes!: Record<string, string>;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
