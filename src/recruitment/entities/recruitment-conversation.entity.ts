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

import {
  ConversationChannel,
  ConversationControlMode,
  ConversationStatus,
} from '../recruitment.enums';
import { RecruitmentApplication } from './recruitment-application.entity';
import { RecruitmentCandidate } from './recruitment-candidate.entity';

/**
 * Hội thoại với ứng viên trên một kênh. Lưu ở backend để OpenClaw không phụ
 * thuộc vào bộ nhớ của model.
 */
@Entity('recruitment_conversations')
@Index('IDX_recruitment_conversations_candidate', ['candidateId'])
@Index(
  'UQ_recruitment_conversations_external',
  ['channel', 'externalConversationId'],
  { unique: true, where: '"external_conversation_id" IS NOT NULL' },
)
export class RecruitmentConversation {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_conversations',
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
    foreignKeyConstraintName: 'FK_recruitment_conversations_candidate',
  })
  candidate?: RecruitmentCandidate;

  @Column({ name: 'application_id', type: 'int', nullable: true })
  applicationId!: number | null;

  @ManyToOne(() => RecruitmentApplication, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'application_id',
    foreignKeyConstraintName: 'FK_recruitment_conversations_application',
  })
  application?: RecruitmentApplication | null;

  @Column({
    type: 'enum',
    enum: ConversationChannel,
  })
  channel!: ConversationChannel;

  @Column({
    name: 'external_conversation_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  externalConversationId!: string | null;

  @Column({
    type: 'enum',
    enum: ConversationStatus,
    default: ConversationStatus.ACTIVE,
  })
  status!: ConversationStatus;

  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  /**
   * Chế độ do HR chọn (P3-6). Đổi chế độ luôn tăng `controlVersion` — worker so
   * version lúc bắt đầu và lúc ghi kết quả, đổi giữa chừng thì bỏ câu trả lời AI.
   */
  @Column({
    name: 'control_mode',
    type: 'enum',
    enum: ConversationControlMode,
    default: ConversationControlMode.AI_ACTIVE,
  })
  controlMode!: ConversationControlMode;

  @Column({ name: 'control_version', type: 'int', default: 1 })
  controlVersion!: number;

  @Column({ name: 'control_changed_at', type: 'timestamptz', nullable: true })
  controlChangedAt!: Date | null;

  /** Nhân viên đổi chế độ gần nhất. */
  @Column({ name: 'control_changed_by', type: 'int', nullable: true })
  controlChangedBy!: number | null;

  /** Nhân viên đang tiếp quản (khi `HUMAN_TAKEOVER`). */
  @Column({ name: 'taken_over_by', type: 'int', nullable: true })
  takenOverBy!: number | null;

  /** HR vừa trả lại cho AI — lượt AI kế tiếp được nhắc làm mới context từ backend. */
  @Column({ name: 'resume_signal_pending', type: 'boolean', default: false })
  resumeSignalPending!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
