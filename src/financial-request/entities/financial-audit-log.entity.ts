import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Nhật ký bất biến của phân hệ (trigger trong migration chặn UPDATE/DELETE).
 * `requestId` có giá trị cho thao tác trên chứng từ; thay đổi cấu hình ghi
 * `entityType`/`entityId`. `changes` chỉ chứa phần dữ liệu thay đổi, không chứa
 * số tài khoản ngân hàng đầy đủ.
 */
@Entity('financial_audit_logs')
@Index('IDX_financial_audit_logs_request', ['requestId', 'createdAt'])
@Index('IDX_financial_audit_logs_entity', ['entityType', 'entityId'])
export class FinancialAuditLog {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_audit_logs',
  })
  id!: number;

  @Column({ name: 'request_id', type: 'int', nullable: true })
  requestId!: number | null;

  @Column({ name: 'entity_type', type: 'varchar', length: 50 })
  entityType!: string;

  @Column({ name: 'entity_id', type: 'int', nullable: true })
  entityId!: number | null;

  @Column({ type: 'varchar', length: 50 })
  action!: string;

  @Column({ name: 'from_status', type: 'varchar', length: 20, nullable: true })
  fromStatus!: string | null;

  @Column({ name: 'to_status', type: 'varchar', length: 20, nullable: true })
  toStatus!: string | null;

  @Column({ name: 'actor_id', type: 'int', nullable: true })
  actorId!: number | null;

  @Column({ name: 'actor_name', type: 'varchar', length: 255, nullable: true })
  actorName!: string | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  changes!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
