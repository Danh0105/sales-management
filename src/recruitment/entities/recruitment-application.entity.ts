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

import { Employee } from '../../employee/employee.entity';
import {
  AiMatchLevel,
  ApplicationStatus,
  CandidateSource,
} from '../recruitment.enums';
import type { ScreeningBreakdown } from '../screening/screening.types';
import { RecruitmentCandidate } from './recruitment-candidate.entity';
import { RecruitmentJob } from './recruitment-job.entity';

/** Hồ sơ ứng tuyển: một ứng viên cho một vị trí. */
@Entity('recruitment_applications')
@Index('IDX_recruitment_applications_candidate', ['candidateId'])
@Index('IDX_recruitment_applications_job', ['jobId'])
@Index('IDX_recruitment_applications_status', ['status'])
@Index('UQ_recruitment_applications_active', ['candidateId', 'jobId'], {
  unique: true,
  where: `"status" NOT IN ('REJECTED', 'WITHDRAWN')`,
})
@Check(
  'CHK_recruitment_applications_score',
  '"ai_match_score" IS NULL OR ("ai_match_score" >= 0 AND "ai_match_score" <= 100)',
)
export class RecruitmentApplication {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_applications',
  })
  id!: number;

  @Column({ name: 'candidate_id', type: 'int' })
  candidateId!: number;

  @ManyToOne(() => RecruitmentCandidate, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'candidate_id',
    foreignKeyConstraintName: 'FK_recruitment_applications_candidate',
  })
  candidate?: RecruitmentCandidate;

  @Column({ name: 'job_id', type: 'int' })
  jobId!: number;

  @ManyToOne(() => RecruitmentJob, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'job_id',
    foreignKeyConstraintName: 'FK_recruitment_applications_job',
  })
  job?: RecruitmentJob;

  @Column({
    type: 'enum',
    enum: ApplicationStatus,
    default: ApplicationStatus.NEW,
  })
  status!: ApplicationStatus;

  @Column({
    type: 'enum',
    enum: CandidateSource,
    default: CandidateSource.MANUAL,
  })
  source!: CandidateSource;

  @Column({ name: 'ai_match_score', type: 'smallint', nullable: true })
  aiMatchScore!: number | null;

  @Column({
    name: 'ai_match_level',
    type: 'enum',
    enum: AiMatchLevel,
    nullable: true,
  })
  aiMatchLevel!: AiMatchLevel | null;

  /** Tóm tắt do AI viết — chỉ để HR đọc, không ảnh hưởng điểm. */
  @Column({ name: 'ai_summary', type: 'text', nullable: true })
  aiSummary!: string | null;

  @Column({ name: 'ai_strengths', type: 'jsonb', default: [] })
  aiStrengths!: string[];

  @Column({ name: 'ai_concerns', type: 'jsonb', default: [] })
  aiConcerns!: string[];

  @Column({ name: 'ai_missing_information', type: 'jsonb', default: [] })
  aiMissingInformation!: string[];

  /** Điểm từng tiêu chí của lần sàng lọc gần nhất — để giải thích được điểm. */
  @Column({ name: 'ai_score_breakdown', type: 'jsonb', nullable: true })
  aiScoreBreakdown!: ScreeningBreakdown | null;

  @Column({
    name: 'screening_completed_at',
    type: 'timestamptz',
    nullable: true,
  })
  screeningCompletedAt!: Date | null;

  /**
   * Đã chuyển cho HR: AI chỉ còn lưu tin nhắn và đọc context, không được ra
   * quyết định gì cho tới khi HR trả lại (`POST /applications/:id/resume-ai`).
   */
  @Column({ name: 'ai_paused', type: 'boolean', default: false })
  aiPaused!: boolean;

  @Column({ name: 'hr_reviewed_at', type: 'timestamptz', nullable: true })
  hrReviewedAt!: Date | null;

  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedBy!: number | null;

  @ManyToOne(() => Employee, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'reviewed_by',
    foreignKeyConstraintName: 'FK_recruitment_applications_reviewed_by',
  })
  reviewer?: Employee | null;

  @Column({ name: 'rejected_reason', type: 'text', nullable: true })
  rejectedReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
