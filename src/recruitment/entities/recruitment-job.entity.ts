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
import {
  EmploymentType,
  RecruitmentEducationLevel,
  RecruitmentExperienceLevel,
  RecruitmentJobStatus,
  RecruitmentSalaryStructure,
  RecruitmentSeniority,
} from '../recruitment.enums';
import type { ScreeningCriteria } from '../screening/screening.types';

export interface RecruitmentWorkLocation {
  provinceId: number;
  provinceName: string;
  wardId: number;
  wardName: string;
  address: string;
}

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
  /** Chức danh/quyền tài khoản khi HR tuyển thành công; null cho vị trí cũ chưa map. */
  @Column({
    name: 'position_role',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  positionRole!: string | null;

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

  @Column({ name: 'industry_ids', type: 'int', array: true, default: '{}' })
  industryIds!: number[];

  @Column({ type: 'varchar', length: 30, nullable: true })
  seniority!: RecruitmentSeniority | null;

  @Column({
    name: 'experience_level',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  experienceLevel!: RecruitmentExperienceLevel | null;

  @Column({ name: 'application_deadline', type: 'date', nullable: true })
  applicationDeadline!: string | null;

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

  @Column({ name: 'salary_negotiable', type: 'boolean', default: false })
  salaryNegotiable!: boolean;

  @Column({
    name: 'salary_structure',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  salaryStructure!: RecruitmentSalaryStructure | null;

  @Column({ type: 'varchar', length: 3, default: 'VND' })
  currency!: string;

  @Column({ type: 'text', nullable: true })
  requirements!: string | null;

  @Column({ type: 'text', nullable: true })
  responsibilities!: string | null;

  @Column({ type: 'text', nullable: true })
  benefits!: string | null;

  @Column({
    name: 'education_level',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  educationLevel!: RecruitmentEducationLevel | null;

  @Column({
    name: 'probation_period',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  probationPeriod!: string | null;

  @Column({ name: 'work_locations', type: 'jsonb', default: [] })
  workLocations!: RecruitmentWorkLocation[];

  /** Luồng hiện tại vốn không bắt buộc CV, nên mặc định true để tương thích. */
  @Column({
    name: 'allow_applications_without_cv',
    type: 'boolean',
    default: true,
  })
  allowApplicationsWithoutCv!: boolean;

  @Column({
    name: 'contact_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  contactName!: string | null;

  @Column({
    name: 'contact_email',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  contactEmail!: string | null;

  @Column({
    name: 'contact_phone',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  contactPhone!: string | null;

  @Column({
    name: 'additional_phones',
    type: 'text',
    array: true,
    default: '{}',
  })
  additionalPhones!: string[];

  /** Bản ghi cũ giữ v1; form mới tạo v2 để áp dụng validation khi publish. */
  @Column({ name: 'form_version', type: 'smallint', default: 2 })
  formVersion!: number;

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
