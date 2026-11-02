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
import { RecruitmentJob } from './recruitment-job.entity';

/**
 * Khung giờ phỏng vấn do HR mở. AI chỉ được đề xuất lịch nằm trong các slot
 * này — không tự bịa giờ ngoài lịch HR.
 *
 * `jobId` trống = slot dùng chung cho mọi vị trí.
 */
@Entity('recruitment_interview_slots')
@Index('IDX_recruitment_interview_slots_start', ['startAt'])
@Index('IDX_recruitment_interview_slots_job', ['jobId'])
@Check('CHK_recruitment_interview_slots_time', '"end_at" > "start_at"')
@Check(
  'CHK_recruitment_interview_slots_capacity',
  '"capacity" >= 1 AND "booked_count" >= 0 AND "booked_count" <= "capacity"',
)
export class RecruitmentInterviewSlot {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_interview_slots',
  })
  id!: number;

  @Column({ name: 'job_id', type: 'int', nullable: true })
  jobId!: number | null;

  @ManyToOne(() => RecruitmentJob, {
    nullable: true,
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'job_id',
    foreignKeyConstraintName: 'FK_recruitment_interview_slots_job',
  })
  job?: RecruitmentJob | null;

  @Column({ name: 'interviewer_id', type: 'int', nullable: true })
  interviewerId!: number | null;

  @ManyToOne(() => Employee, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'interviewer_id',
    foreignKeyConstraintName: 'FK_recruitment_interview_slots_interviewer',
  })
  interviewer?: Employee | null;

  @Column({ name: 'start_at', type: 'timestamptz' })
  startAt!: Date;

  @Column({ name: 'end_at', type: 'timestamptz' })
  endAt!: Date;

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

  @Column({ type: 'int', default: 1 })
  capacity!: number;

  /** Số lịch PROPOSED/CONFIRMED đang giữ slot. Tăng/giảm nguyên tử bằng UPDATE có điều kiện. */
  @Column({ name: 'booked_count', type: 'int', default: 0 })
  bookedCount!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @ManyToOne(() => Employee, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'created_by',
    foreignKeyConstraintName: 'FK_recruitment_interview_slots_created_by',
  })
  creator?: Employee | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
