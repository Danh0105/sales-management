import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { ChannelEventChannel, ChannelOutboxStatus } from '../recruitment.enums';
import { RecruitmentChannelEvent } from './recruitment-channel-event.entity';
import { RecruitmentMessage } from './recruitment-message.entity';

/**
 * Tin trả lời của AI chờ gửi ra kênh (P3-4 chỉ ghi `PENDING`, gửi Zalo là bước sau).
 *
 * Mỗi event đến sinh **tối đa một** tin đi: unique `source_event_id` + `INSERT ...
 * ON CONFLICT DO NOTHING` — worker retry hay hai worker cùng xong một event cũng
 * chỉ có một dòng. Nội dung là bản canonical đã nằm trong `recruitment_messages`
 * (`recruitment_message_id`), không phải bản nháp của model.
 */
@Entity('recruitment_channel_outbox')
@Unique('UQ_recruitment_channel_outbox_source_event', ['sourceEventId'])
@Index('IDX_recruitment_channel_outbox_status_created', ['status', 'createdAt'])
export class RecruitmentChannelOutbox {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_channel_outbox',
  })
  id!: number;

  @Column({ name: 'source_event_id', type: 'int' })
  sourceEventId!: number;

  @ManyToOne(() => RecruitmentChannelEvent, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'source_event_id',
    foreignKeyConstraintName: 'FK_recruitment_channel_outbox_source_event',
  })
  sourceEvent?: RecruitmentChannelEvent;

  @Column({ type: 'enum', enum: ChannelEventChannel })
  channel!: ChannelEventChannel;

  @Column({ name: 'channel_account_id', type: 'varchar', length: 64 })
  channelAccountId!: string;

  @Column({ name: 'external_recipient_id', type: 'varchar', length: 100 })
  externalRecipientId!: string;

  @Column({ name: 'message_text', type: 'text' })
  messageText!: string;

  /** Tin đi canonical trong hội thoại — bước gửi đánh dấu đã gửi theo dòng này. */
  @Column({ name: 'recruitment_message_id', type: 'int', nullable: true })
  recruitmentMessageId!: number | null;

  @ManyToOne(() => RecruitmentMessage, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'recruitment_message_id',
    foreignKeyConstraintName: 'FK_recruitment_channel_outbox_message',
  })
  recruitmentMessage?: RecruitmentMessage | null;

  @Column({
    type: 'enum',
    enum: ChannelOutboxStatus,
    default: ChannelOutboxStatus.PENDING,
  })
  status!: ChannelOutboxStatus;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  providerMessageId!: string | null;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;
}
