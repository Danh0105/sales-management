import {
  Check,
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Dừng khẩn AI / worker / outbound KHÔNG cần restart (P3-7.3 / G8). Đúng một dòng (id = 1).
 * App đọc mỗi vòng lặp; đọc lỗi = coi như đang dừng (fail-closed). Chỉ đổi qua endpoint
 * vận hành có audit, hoặc hệ thống tự dừng AI khi vượt trần lượt / token.
 */
@Entity('recruitment_runtime_controls')
@Check('CHK_recruitment_runtime_controls_single_row', `"id" = 1`)
export class RecruitmentRuntimeControl {
  @PrimaryColumn({
    type: 'smallint',
    default: 1,
    primaryKeyConstraintName: 'PK_recruitment_runtime_controls',
  })
  id!: number;

  @Column({ name: 'ai_halted', type: 'boolean', default: false })
  aiHalted!: boolean;

  @Column({ name: 'worker_halted', type: 'boolean', default: false })
  workerHalted!: boolean;

  @Column({ name: 'outbound_halted', type: 'boolean', default: false })
  outboundHalted!: boolean;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reason!: string | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /** Fallback bền nếu transaction emergency stop không thể ghi mandatory audit. */
  @Column({ name: 'failsafe_halted', type: 'boolean', default: false })
  failsafeHalted!: boolean;

  @Column({
    name: 'failsafe_reason',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  failsafeReason!: string | null;

  @Column({ name: 'failsafe_at', type: 'timestamptz', nullable: true })
  failsafeAt!: Date | null;
}
