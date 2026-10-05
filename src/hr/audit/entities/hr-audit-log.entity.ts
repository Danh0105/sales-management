import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Append-only — trigger trong DB chặn UPDATE/DELETE/TRUNCATE.
 * Chỉ ghi qua `HrAuditService.record`, không `save()` lại entity đã đọc ra.
 */
@Entity({ schema: 'hr', name: 'audit_logs', synchronize: false })
export class HrAuditLog {
  /** bigint — pg trả về dạng chuỗi. */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'occurred_at', type: 'timestamptz', insert: false })
  occurredAt: Date;

  @Column({ name: 'actor_account_id', type: 'int', nullable: true })
  actorAccountId: number | null;

  @Column({ name: 'actor_name', type: 'varchar', length: 255, nullable: true })
  actorName: string | null;

  @Column({ name: 'actor_roles', type: 'text', array: true })
  actorRoles: string[];

  @Column({ type: 'varchar', length: 64 })
  action: string;

  @Column({ type: 'varchar', length: 64 })
  entity: string;

  @Column({ name: 'entity_id', type: 'varchar', length: 64, nullable: true })
  entityId: string | null;

  @Column({ name: 'old_value', type: 'jsonb', nullable: true })
  oldValue: unknown;

  @Column({ name: 'new_value', type: 'jsonb', nullable: true })
  newValue: unknown;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;

  @Column({ name: 'request_id', type: 'varchar', length: 64, nullable: true })
  requestId: string | null;
}
