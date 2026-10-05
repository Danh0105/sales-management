import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { HrScope } from '../hr-permission';

/**
 * Gán HR role cho một tài khoản, kèm scope và thời hạn.
 *
 * Thu hồi = `revokedAt` (có hiệu lực ngay từ request kế tiếp), không xoá dòng.
 * `grantedBy` null = cấp bởi script bootstrap (không có người thao tác).
 */
@Entity({ schema: 'hr', name: 'account_role_assignments', synchronize: false })
export class HrAccountRoleAssignment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'account_id', type: 'int' })
  accountId: number;

  @Column({ name: 'role_code', type: 'varchar', length: 64 })
  roleCode: string;

  @Column({ type: 'varchar', length: 16 })
  scope: HrScope;

  @Column({ name: 'scope_ref_id', type: 'int', nullable: true })
  scopeRefId: number | null;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom: string;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  @Column({ type: 'text' })
  reason: string;

  @Column({ name: 'granted_by', type: 'int', nullable: true })
  grantedBy: number | null;

  @Column({ name: 'granted_at', type: 'timestamptz', insert: false })
  grantedAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_by', type: 'int', nullable: true })
  revokedBy: number | null;

  @Column({ name: 'revoke_reason', type: 'text', nullable: true })
  revokeReason: string | null;

  /** Tăng thủ công trong câu UPDATE thu hồi (optimistic locking → 409). */
  @Column({ type: 'int', default: 1 })
  version: number;
}
