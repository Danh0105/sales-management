import {
  Check,
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
 * Tin trả lời của AI chờ gửi ra kênh — nguồn DUY NHẤT của tin gửi ra Zalo: chỉ
 * `RecruitmentZaloSender` đọc bảng này để gửi; OpenClaw/model/worker không gọi Zalo.
 *
 * Mỗi event đến sinh **tối đa một** tin đi: unique `source_event_id` + `INSERT ...
 * ON CONFLICT DO NOTHING` — worker retry hay hai worker cùng xong một event cũng
 * chỉ có một dòng. Nội dung là bản canonical đã nằm trong `recruitment_messages`
 * (`recruitment_message_id`), không phải bản nháp của model.
 *
 * `message_text` chỉ là bản sao để gửi: `SENT` thì bắt buộc NULL (CHECK); trạng thái
 * còn phải gửi (`PENDING`/`SENDING`/`RETRY`) thì bắt buộc có.
 */
@Entity('recruitment_channel_outbox')
@Unique('UQ_recruitment_channel_outbox_source_event', ['sourceEventId'])
@Index('IDX_recruitment_channel_outbox_status_created', ['status', 'createdAt'])
@Index('IDX_recruitment_channel_outbox_recipient_queue', [
  'channelAccountId',
  'externalRecipientId',
  'status',
])
@Check(
  'CHK_recruitment_channel_outbox_text_status',
  `("status" <> 'SENT' OR "message_text" IS NULL) AND ("message_text" IS NOT NULL OR "status" IN ('SENT', 'UNKNOWN', 'DEAD_LETTER'))`,
)
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

  @Column({ name: 'message_text', type: 'text', nullable: true })
  messageText!: string | null;

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

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

  /** Sender + nonce của lần claim gần nhất — mọi cập nhật kết quả phải khớp (fencing). */
  @Column({ name: 'lease_owner', type: 'varchar', length: 100, nullable: true })
  leaseOwner!: string | null;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'sending_started_at', type: 'timestamptz', nullable: true })
  sendingStartedAt!: Date | null;

  /**
   * Ghi bền NGAY TRƯỚC khi mở kết nối tới Zalo. Lease hết hạn mà cột này có giá
   * trị → request có thể đã tới Zalo → `UNKNOWN`, không gửi lại.
   */
  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt!: Date | null;

  @Column({ name: 'text_redacted_at', type: 'timestamptz', nullable: true })
  textRedactedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;
}
