import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { IdempotencyStatus } from '../recruitment.enums';

/**
 * Header `Idempotency-Key` của API AI: OpenClaw retry cùng key thì nhận lại
 * đúng response cũ thay vì tạo thêm một lịch phỏng vấn nữa.
 */
@Entity('recruitment_ai_idempotency_keys')
@Index('UQ_recruitment_ai_idempotency_key', ['idempotencyKey', 'endpoint'], {
  unique: true,
})
@Index('IDX_recruitment_ai_idempotency_created', ['createdAt'])
export class RecruitmentAiIdempotencyKey {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_ai_idempotency_keys',
  })
  id!: number;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  /** `METHOD /route/:pattern` — cùng key ở hai endpoint khác nhau là hai việc khác nhau. */
  @Column({ type: 'varchar', length: 150 })
  endpoint!: string;

  /** SHA-256 của params + body: cùng key mà khác nội dung là lỗi của caller. */
  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash!: string;

  @Column({
    type: 'enum',
    enum: IdempotencyStatus,
    default: IdempotencyStatus.IN_PROGRESS,
  })
  status!: IdempotencyStatus;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody!: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
