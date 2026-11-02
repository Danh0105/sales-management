import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import {
  HrAlertSeverity,
  HrAlertStatus,
  HrAlertType,
} from '../recruitment.enums';

/**
 * Cảnh báo bền cho HR/vận hành (P3-6) — một dòng cho mỗi **nguồn** sự cố.
 *
 * Unique (`type`, `source_key`) + `INSERT ... ON CONFLICT DO NOTHING`: quét lại,
 * retry hay nhiều process cùng phát hiện vẫn chỉ một cảnh báo. `source_key` mang
 * tài nguyên gốc (`handoff:12`, `outbox:40`, `event:7`, `credential:<oa>:v3`, ...).
 *
 * Chỉ metadata (id, mã lỗi) — KHÔNG nội dung tin, token hay thông tin cá nhân.
 * Bảng này là "outbox" của cảnh báo: kênh đẩy thông báo thật đọc từ đây.
 */
@Entity('recruitment_hr_alerts')
@Unique('UQ_recruitment_hr_alerts_source', ['type', 'sourceKey'])
@Index('IDX_recruitment_hr_alerts_status_created', ['status', 'createdAt'])
export class RecruitmentHrAlert {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_hr_alerts',
  })
  id!: number;

  @Column({ type: 'enum', enum: HrAlertType })
  type!: HrAlertType;

  @Column({ type: 'enum', enum: HrAlertSeverity })
  severity!: HrAlertSeverity;

  @Column({ type: 'enum', enum: HrAlertStatus, default: HrAlertStatus.OPEN })
  status!: HrAlertStatus;

  @Column({ name: 'source_key', type: 'varchar', length: 150 })
  sourceKey!: string;

  @Column({ name: 'candidate_id', type: 'int', nullable: true })
  candidateId!: number | null;

  @Column({ name: 'application_id', type: 'int', nullable: true })
  applicationId!: number | null;

  @Column({ name: 'conversation_id', type: 'int', nullable: true })
  conversationId!: number | null;

  @Column({ name: 'handoff_id', type: 'int', nullable: true })
  handoffId!: number | null;

  @Column({ name: 'outbox_id', type: 'int', nullable: true })
  outboxId!: number | null;

  @Column({ name: 'event_id', type: 'int', nullable: true })
  eventId!: number | null;

  /** Mã lỗi / lý do / trạng thái — không nội dung. */
  @Column({ type: 'jsonb', default: {} })
  details!: Record<string, string | number | boolean | null>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt!: Date | null;

  @Column({ name: 'acknowledged_by', type: 'int', nullable: true })
  acknowledgedBy!: number | null;

  @Column({
    name: 'acknowledged_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  acknowledgedByName!: string | null;
}
