import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { ChannelEventChannel, ChannelEventStatus } from '../recruitment.enums';

/**
 * Event webhook của kênh tuyển dụng (Zalo OA tuyển dụng) đã qua xác thực.
 *
 * Chống trùng do **DB bảo đảm**: unique (kênh, OA, dedupe_key) + `INSERT ... ON
 * CONFLICT DO NOTHING` — Zalo gửi lại hay nhiều request song song cùng một event
 * thì chỉ một dòng được ghi. `dedupe_key` do server tính từ id tin của Zalo (hoặc
 * hash tất định của các trường bất biến), không bao giờ do model tạo.
 *
 * Không lưu raw payload: chỉ `payload_hash` + metadata đã chuẩn hoá.
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

  /** SHA-256 (hex) của body thô — đối chiếu, không khôi phục được nội dung. */
  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
