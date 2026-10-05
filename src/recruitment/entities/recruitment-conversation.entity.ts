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

import { ConversationChannel, ConversationStatus } from '../recruitment.enums';
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
