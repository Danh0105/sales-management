import {
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
  HandoffPriority,
  HandoffReason,
  HandoffStatus,
  RecruitmentActorType,
} from '../recruitment.enums';
import { RecruitmentApplication } from './recruitment-application.entity';
import { RecruitmentCandidate } from './recruitment-candidate.entity';

/**
 * Yêu cầu chuyển cho người thật xử lý.
 *
 * `applicationId` trống = yêu cầu ở cấp ứng viên (vd. xin xoá dữ liệu khi
 * chưa nộp hồ sơ nào).
 */
@Entity('recruitment_handoffs')
@Index('IDX_recruitment_handoffs_status_created', ['status', 'createdAt'])
@Index('IDX_recruitment_handoffs_candidate', ['candidateId'])
@Index('IDX_recruitment_handoffs_application', ['applicationId'])
@Index('UQ_recruitment_handoffs_open_reason', ['applicationId', 'reason'], {
  unique: true,
  where: `"status" = 'OPEN'`,
})
export class RecruitmentHandoff {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_handoffs',
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
    foreignKeyConstraintName: 'FK_recruitment_handoffs_candidate',
  })
  candidate?: RecruitmentCandidate;

  @Column({ name: 'application_id', type: 'int', nullable: true })
  applicationId!: number | null;

  @ManyToOne(() => RecruitmentApplication, {
    nullable: true,
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'application_id',
    foreignKeyConstraintName: 'FK_recruitment_handoffs_application',
  })
  application?: RecruitmentApplication | null;

  @Column({
    type: 'enum',
    enum: HandoffReason,
  })
  reason!: HandoffReason;

  @Column({
    type: 'enum',
    enum: HandoffPriority,
    default: HandoffPriority.NORMAL,
  })
  priority!: HandoffPriority;

  @Column({ type: 'text' })
  summary!: string;

  @Column({
    type: 'enum',
    enum: HandoffStatus,
    default: HandoffStatus.OPEN,
  })
  status!: HandoffStatus;

  @Column({
    name: 'requested_by_type',
    type: 'enum',
    enum: RecruitmentActorType,
  })
  requestedByType!: RecruitmentActorType;

  @Column({ name: 'requested_by', type: 'int', nullable: true })
  requestedBy!: number | null;

  @ManyToOne(() => Employee, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'requested_by',
    foreignKeyConstraintName: 'FK_recruitment_handoffs_requested_by',
  })
  requester?: Employee | null;

  @Column({ name: 'resolved_by', type: 'int', nullable: true })
  resolvedBy!: number | null;

  @ManyToOne(() => Employee, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'resolved_by',
    foreignKeyConstraintName: 'FK_recruitment_handoffs_resolved_by',
  })
  resolver?: Employee | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
