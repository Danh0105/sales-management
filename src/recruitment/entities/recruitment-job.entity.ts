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
import { numericTransformer } from '../../utils/numeric-transformer';
import { EmploymentType, RecruitmentJobStatus } from '../recruitment.enums';
import type { ScreeningCriteria } from '../screening/screening.types';

/** Vị trí tuyển dụng. */
@Entity('recruitment_jobs')
@Index('UQ_recruitment_jobs_code', ['code'], { unique: true })
@Index('IDX_recruitment_jobs_status', ['status'])
@Check('CHK_recruitment_jobs_positions', '"number_of_positions" > 0')
@Check(
  'CHK_recruitment_jobs_salary',
  '("salary_min" IS NULL OR "salary_min" >= 0) AND ("salary_max" IS NULL OR "salary_max" >= 0) AND ("salary_min" IS NULL OR "salary_max" IS NULL OR "salary_min" <= "salary_max")',
)
export class RecruitmentJob {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_recruitment_jobs' })
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'department_id', type: 'int', nullable: true })
  departmentId!: number | null;

  @ManyToOne(() => Department, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'department_id',
    foreignKeyConstraintName: 'FK_recruitment_jobs_department',
  })
  department?: Department | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  location!: string | null;

  @Column({
    name: 'employment_type',
    type: 'enum',
    enum: EmploymentType,
    default: EmploymentType.FULL_TIME,
  })
  employmentType!: EmploymentType;

  @Column({ name: 'number_of_positions', type: 'int', default: 1 })
  numberOfPositions!: number;

  @Column({
    name: 'salary_min',
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  salaryMin!: number | null;

  @Column({
    name: 'salary_max',
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  salaryMax!: number | null;

  @Column({ type: 'varchar', length: 3, default: 'VND' })
  currency!: string;

  @Column({ type: 'text', nullable: true })
  requirements!: string | null;

  @Column({ type: 'text', nullable: true })
  responsibilities!: string | null;

  /**
   * Tiêu chí sàng lọc có cấu trúc — schema cố định ở `ScreeningCriteriaDto`,
   * không nhận khoá lạ để không ai khai được tiêu chí nhạy cảm.
   */
  @Column({ name: 'screening_criteria', type: 'jsonb', default: {} })
  screeningCriteria!: ScreeningCriteria;

  @Column({
    type: 'enum',
    enum: RecruitmentJobStatus,
    default: RecruitmentJobStatus.DRAFT,
  })
  status!: RecruitmentJobStatus;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @ManyToOne(() => Employee, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'created_by',
    foreignKeyConstraintName: 'FK_recruitment_jobs_created_by',
  })
  creator?: Employee | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
