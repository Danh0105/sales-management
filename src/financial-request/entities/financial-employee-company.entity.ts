import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { FinancialCompany } from './financial-company.entity';

/**
 * Nhân viên thuộc công ty nào (một công ty/người), xếp ở màn Phân quyền cùng
 * với phòng ban. Tách khỏi bảng `employee` dùng chung — phân hệ tài chính
 * không sửa hồ sơ nhân viên.
 */
@Entity('financial_employee_companies')
@Index('IDX_financial_employee_companies_company', ['companyId'])
export class FinancialEmployeeCompany {
  @PrimaryColumn({
    name: 'employee_id',
    type: 'int',
    primaryKeyConstraintName: 'PK_financial_employee_companies',
  })
  employeeId!: number;

  @Column({ name: 'company_id', type: 'int' })
  companyId!: number;

  @ManyToOne(() => FinancialCompany, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'company_id',
    foreignKeyConstraintName: 'FK_financial_employee_companies_company',
  })
  company?: FinancialCompany;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
