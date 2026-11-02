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
import { InterviewStatus, RecruitmentActorType } from '../recruitment.enums';
import { RecruitmentApplication } from './recruitment-application.entity';
import { RecruitmentCandidate } from './recruitment-candidate.entity';
import { RecruitmentInterviewSlot } from './recruitment-interview-slot.entity';
import { RecruitmentJob } from './recruitment-job.entity';

/** Lịch phỏng vấn. Giờ được chốt lại từ slot lúc tạo — HR sửa slot sau đó không kéo lịch đã hẹn đi theo. */
@Entity('recruitment_interviews')
@Index('IDX_recruitment_interviews_application', ['applicationId'])
@Index('IDX_recruitment_interviews_scheduled_start', ['scheduledStart'])
@Index('UQ_recruitment_interviews_active', ['applicationId'], {
  unique: true,
  where: `"status" IN ('PROPOSED', 'CONFIRMED')`,
})
@Check('CHK_recruitment_interviews_time', '"scheduled_end" > "scheduled_start"')
export class RecruitmentInterview {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_interviews',
  })
  id!: number;

  @Column({ name: 'application_id', type: 'int' })
  applicationId!: number;

  @ManyToOne(() => RecruitmentApplication, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'application_id',
    foreignKeyConstraintName: 'FK_recruitment_interviews_application',
  })
  application?: RecruitmentApplication;

  @Column({ name: 'candidate_id', type: 'int' })
  candidateId!: number;

  @ManyToOne(() => RecruitmentCandidate, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'candidate_id',
    foreignKeyConstraintName: 'FK_recruitment_interviews_candidate',
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
    foreignKeyConstraintName: 'FK_recruitment_interviews_job',
  })
  job?: RecruitmentJob;

  @Column({ name: 'slot_id', type: 'int', nullable: true })
  slotId!: number | null;

  @ManyToOne(() => RecruitmentInterviewSlot, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'slot_id',
    foreignKeyConstraintName: 'FK_recruitment_interviews_slot',
  })
  slot?: RecruitmentInterviewSlot | null;

  @Column({ name: 'interviewer_id', type: 'int', nullable: true })
  interviewerId!: number | null;

  @ManyToOne(() => Employee, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'interviewer_id',
    foreignKeyConstraintName: 'FK_recruitment_interviews_interviewer',
  })
  interviewer?: Employee | null;

  @Column({ name: 'scheduled_start', type: 'timestamptz' })
  scheduledStart!: Date;

  @Column({ name: 'scheduled_end', type: 'timestamptz' })
  scheduledEnd!: Date;

  @Column({ type: 'varchar', length: 64, default: 'Asia/Ho_Chi_Minh' })
  timezone!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  location!: string | null;

  @Column({
    name: 'meeting_url',
    type: 'varchar',
    length: 1000,
    nullable: true,
  })
  meetingUrl!: string | null;

  @Column({
    type: 'enum',
    enum: InterviewStatus,
    default: InterviewStatus.PROPOSED,
  })
  status!: InterviewStatus;

  @Column({
    name: 'candidate_confirmed_at',
    type: 'timestamptz',
    nullable: true,
  })
  candidateConfirmedAt!: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancellation_reason', type: 'text', nullable: true })
  cancellationReason!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({
    name: 'created_by_type',
    type: 'enum',
    enum: RecruitmentActorType,
  })
  createdByType!: RecruitmentActorType;

  /** Nhân viên HR tạo lịch; trống khi AI đề xuất. */
  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @ManyToOne(() => Employee, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'created_by',
    foreignKeyConstraintName: 'FK_recruitment_interviews_created_by',
  })
  creator?: Employee | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
