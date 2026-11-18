import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Department } from '../../department/department.entity';
import { Employee } from '../../employee/employee.entity';
import { FinanceRole } from '../financial-request.constants';
import { bigintTransformer } from '../financial-money';
import { FinancialCompany } from './financial-company.entity';

/**
 * Gán vai trò tài chính cho nhân viên theo phạm vi dữ liệu: công ty (NULL =
 * mọi công ty) × phòng ban (NULL = mọi phòng ban). Là nguồn quyết định ai
 * được xem/duyệt/chi tiền — không dựa vào việc ẩn nút ở giao diện.
 */
@Entity('financial_role_assignments')
@Index('IDX_financial_role_assignments_employee', ['employeeId'])
@Index('IDX_financial_role_assignments_role', ['role'])
@Check(
  'CHK_financial_role_assignments_role',
  `"role" IN ('MANAGER','CONTROLLER','ACCOUNTANT','CASHIER','DIRECTOR','ADMIN','VIEWER')`,
)
export class FinancialRoleAssignment {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_role_assignments',
  })
  id!: number;

  @Column({ name: 'employee_id', type: 'int' })
  employeeId!: number;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'employee_id',
    foreignKeyConstraintName: 'FK_financial_role_assignments_employee',
  })
  employee?: Employee;

  @Column({ type: 'varchar', length: 20 })
  role!: FinanceRole;

  @Column({ name: 'company_id', type: 'int', nullable: true })
  companyId!: number | null;

  @ManyToOne(() => FinancialCompany, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'company_id',
    foreignKeyConstraintName: 'FK_financial_role_assignments_company',
  })
  company?: FinancialCompany | null;

  @Column({ name: 'department_id', type: 'int', nullable: true })
  departmentId!: number | null;

  @ManyToOne(() => Department, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'department_id',
    foreignKeyConstraintName: 'FK_financial_role_assignments_department',
  })
  department?: Department | null;

  /** Hạn mức duyệt tối đa (tổng tiền phiếu); NULL = không giới hạn. */
  @Column({
    name: 'approval_limit',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  approvalLimit!: number | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @Column({ name: 'created_by_id', type: 'int', nullable: true })
  createdById!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
