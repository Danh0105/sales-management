import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import {
  MessageContentType,
  MessageDirection,
  MessageSenderType,
} from '../recruitment.enums';
import { RecruitmentConversation } from './recruitment-conversation.entity';

/** Một tin nhắn trong hội thoại. Chống lưu trùng khi OpenClaw retry theo `externalMessageId`. */
@Entity('recruitment_messages')
@Index('IDX_recruitment_messages_conversation_created', [
  'conversationId',
  'createdAt',
])
@Index(
  'UQ_recruitment_messages_external',
  ['conversationId', 'externalMessageId'],
  { unique: true, where: '"external_message_id" IS NOT NULL' },
)
export class RecruitmentMessage {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_messages',
  })
  id!: number;

  @Column({ name: 'conversation_id', type: 'int' })
  conversationId!: number;

  @ManyToOne(() => RecruitmentConversation, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'conversation_id',
    foreignKeyConstraintName: 'FK_recruitment_messages_conversation',
  })
  conversation?: RecruitmentConversation;

  @Column({
    name: 'external_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  externalMessageId!: string | null;

  @Column({
    name: 'sender_type',
    type: 'enum',
    enum: MessageSenderType,
  })
  senderType!: MessageSenderType;

  @Column({
    type: 'enum',
    enum: MessageDirection,
  })
  direction!: MessageDirection;

  @Column({ type: 'text' })
  content!: string;

  @Column({
    name: 'content_type',
    type: 'enum',
    enum: MessageContentType,
    default: MessageContentType.TEXT,
  })
  contentType!: MessageContentType;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, string | number | boolean | null>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
