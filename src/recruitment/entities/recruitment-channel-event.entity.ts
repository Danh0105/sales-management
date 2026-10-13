import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import {
  ChannelEventAiDecision,
  ChannelEventChannel,
  ChannelEventStatus,
} from '../recruitment.enums';

/**
 * Event webhook của kênh tuyển dụng (Zalo OA tuyển dụng) đã qua xác thực.
 *
 * Chống trùng do **DB bảo đảm**: unique (kênh, OA, dedupe_key) + `INSERT ... ON
 * CONFLICT DO NOTHING` — Zalo gửi lại hay nhiều request song song cùng một event
 * thì chỉ một dòng được ghi. `dedupe_key` do server tính từ id tin của Zalo (hoặc
 * hash tất định của các trường bất biến), không bao giờ do model tạo.
 *
 * Không lưu raw payload: chỉ `payload_hash` + metadata đã chuẩn hoá.
 *
 * P3-4 — bảng còn là **hàng đợi bền** (durable inbox) cho worker: nội dung tin đã
 * chuẩn hoá nằm tạm ở `normalized_message_text` tới khi tin được ghi vào hội thoại
 * canonical (`recruitment_messages`), rồi bị xoá ngay khi `PROCESSED`. CHECK bảo đảm
 * ở DB: chỉ `RECEIVED` / `PROCESSING` / `FAILED` mới được giữ nội dung; quá 7 ngày
 * thì worker xoá nốt (dead-letter).
 */
@Entity('recruitment_channel_events')
@Unique('UQ_recruitment_channel_events_dedupe', [
  'channel',
  'channelAccountId',
  'dedupeKey',
])
@Index('IDX_recruitment_channel_events_status_received', [
  'status',
  'receivedAt',
])
@Index('IDX_recruitment_channel_events_sender_queue', [
  'channelAccountId',
  'externalSenderId',
  'status',
])
@Check(
  'CHK_recruitment_channel_events_text_status',
  `"normalized_message_text" IS NULL OR "status" IN ('RECEIVED', 'PROCESSING', 'FAILED')`,
)
export class RecruitmentChannelEvent {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_channel_events',
  })
  id!: number;

  @Column({ type: 'enum', enum: ChannelEventChannel })
  channel!: ChannelEventChannel;

  /** OA lấy từ **cấu hình server**, không lấy từ payload (payload chỉ để đối chiếu). */
  @Column({ name: 'channel_account_id', type: 'varchar', length: 64 })
  channelAccountId!: string;

  /** Zalo OA không có id event riêng — để trống; id tin nằm ở `providerMessageId`. */
  @Column({
    name: 'provider_event_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  providerEventId!: string | null;

  @Column({ name: 'dedupe_key', type: 'varchar', length: 200 })
  dedupeKey!: string;

  /** Id người dùng Zalo (theo OA) khi người dùng là bên gửi; `null` với event do OA phát. */
  @Column({
    name: 'external_sender_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  externalSenderId!: string | null;

  /** `event_name` của Zalo, vd. `user_send_text`, `follow`. */
  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType!: string;

  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  providerMessageId!: string | null;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt!: Date;

  @Column({ name: 'provider_created_at', type: 'timestamptz', nullable: true })
  providerCreatedAt!: Date | null;

  @Column({
    type: 'enum',
    enum: ChannelEventStatus,
    default: ChannelEventStatus.RECEIVED,
  })
  status!: ChannelEventStatus;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode!: string | null;

  /**
   * Nội dung tin (NFC, bỏ ký tự điều khiển) — chỉ có với event `RECEIVED` cần xử
   * lý; `NULL` sau khi xử lý xong hoặc quá hạn giữ (7 ngày).
   */
  @Column({ name: 'normalized_message_text', type: 'text', nullable: true })
  normalizedMessageText!: string | null;

  /** Số lần worker đã claim event (kể cả lần claim lại sau khi lease hết hạn). */
  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({
    name: 'processing_started_at',
    type: 'timestamptz',
    nullable: true,
  })
  processingStartedAt!: Date | null;

  /** Hết hạn mà vẫn `PROCESSING` = worker đã chết → worker khác được claim lại. */
  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

  /** Worker + nonce của lần claim gần nhất — mọi cập nhật kết quả đều phải khớp (fencing). */
  @Column({ name: 'lease_owner', type: 'varchar', length: 100, nullable: true })
  leaseOwner!: string | null;

  /** `FAILED` có giá trị = lỗi tạm, thử lại từ thời điểm này; `NULL` = lỗi cuối (dead-letter). */
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;

  @Column({ name: 'text_redacted_at', type: 'timestamptz', nullable: true })
  textRedactedAt!: Date | null;

  /** Hội thoại canonical của tin đến (worker gắn khi lưu tin đến). */
  @Column({ name: 'conversation_id', type: 'int', nullable: true })
  conversationId!: number | null;

  /**
   * Version điều khiển hội thoại lúc lượt AI của event bắt đầu (ghi trước khi gọi
   * OpenClaw). Lượt chạy lại chỉ bị chặn khi HR đã đổi version.
   */
  @Column({ name: 'ai_control_version', type: 'int', nullable: true })
  aiControlVersion!: number | null;

  /** Worker đã gọi AI hay bỏ qua (AI tạm dừng / HR tiếp quản / đóng) — P3-6. */
  @Column({
    name: 'ai_decision',
    type: 'enum',
    enum: ChannelEventAiDecision,
    nullable: true,
  })
  aiDecision!: ChannelEventAiDecision | null;

  /**
   * Token của lượt AI theo `usage` OpenClaw (P3-7.3 / G8): input gồm cả phần cache,
   * cached = phần đọc từ cache. Dùng cho trần ngân sách ngày / tháng.
   */
  @Column({ name: 'ai_input_tokens', type: 'int', nullable: true })
  aiInputTokens!: number | null;

  @Column({ name: 'ai_cached_tokens', type: 'int', nullable: true })
  aiCachedTokens!: number | null;

  @Column({ name: 'ai_output_tokens', type: 'int', nullable: true })
  aiOutputTokens!: number | null;

  @Column({ name: 'ai_total_tokens', type: 'int', nullable: true })
  aiTotalTokens!: number | null;

  /** SHA-256 (hex) của body thô — đối chiếu, không khôi phục được nội dung. */
  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
