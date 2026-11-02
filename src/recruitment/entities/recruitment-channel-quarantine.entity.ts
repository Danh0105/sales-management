import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import {
  ChannelEventChannel,
  ChannelQuarantineStatus,
} from '../recruitment.enums';
import { RecruitmentChannelEvent } from './recruitment-channel-event.entity';

/**
 * Request webhook Zalo OA tuyển dụng nhận ở **chế độ cách ly** (P3-7.2A): khi Zalo chỉ
 * cấp OA secret key sau khi URL webhook trả 200, chữ ký chưa kiểm được. Request khai
 * đúng app + OA được ghi bền ở đây (thân request thô **mã hoá**) TRƯỚC khi trả 200,
 * rồi được xác minh hồi tố khi có key.
 *
 * Bảng này KHÔNG phải inbox: không worker nào đọc, không tạo ứng viên/hội thoại. Chỉ
 * request đã xác minh chữ ký mới đi tiếp vào `recruitment_channel_events`.
 *
 * CHECK: nội dung mã hoá chỉ tồn tại khi `QUARANTINED`; rời trạng thái đó là xoá.
 */
@Entity('recruitment_channel_quarantine')
@Unique('UQ_recruitment_channel_quarantine_payload', [
  'channel',
  'channelAccountId',
  'payloadHash',
])
@Index('IDX_recruitment_channel_quarantine_status_received', [
  'status',
  'receivedAt',
])
@Check(
  'CHK_recruitment_channel_quarantine_body',
  `("body_enc" IS NULL) = ("status" <> 'QUARANTINED')`,
)
export class RecruitmentChannelQuarantine {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_channel_quarantine',
  })
  id!: number;

  @Column({ type: 'enum', enum: ChannelEventChannel })
  channel!: ChannelEventChannel;

  /** OA tuyển dụng trong cấu hình server (payload đã khai đúng OA này). */
  @Column({ name: 'channel_account_id', type: 'varchar', length: 64 })
  channelAccountId!: string;

  /** SHA-256 (hex) của body thô — chống trùng khi Zalo gửi lại, kiểm toàn vẹn khi giải mã. */
  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash!: string;

  /** Header `X-ZEvent-Signature` nguyên văn (MAC, không phải bí mật); thiếu → `NULL`. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  signature!: string | null;

  @Column({ name: 'event_type', type: 'varchar', length: 64, nullable: true })
  eventType!: string | null;

  @Column({ name: 'body_size', type: 'int' })
  bodySize!: number;

  /** Body thô (base64) mã hoá AES-256-GCM, AAD = OA + payload hash. */
  @Column({ name: 'body_enc', type: 'text', nullable: true })
  bodyEnc!: string | null;

  @Column({
    type: 'enum',
    enum: ChannelQuarantineStatus,
    default: ChannelQuarantineStatus.QUARANTINED,
  })
  status!: ChannelQuarantineStatus;

  /** Lý do kết thúc: NEW / DUPLICATE (đã vào inbox), mã từ chối, RETENTION_EXPIRED. */
  @Column({
    name: 'resolution_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  resolutionCode!: string | null;

  @Column({ name: 'channel_event_id', type: 'int', nullable: true })
  channelEventId!: number | null;

  @ManyToOne(() => RecruitmentChannelEvent, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  })
  @JoinColumn({
    name: 'channel_event_id',
    foreignKeyConstraintName: 'FK_recruitment_channel_quarantine_event',
  })
  channelEvent?: RecruitmentChannelEvent | null;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt!: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
