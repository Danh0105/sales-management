import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  VersionColumn,
} from 'typeorm';
import { HrScope } from '../hr-permission';

/**
 * Quyền HR cấp riêng cho một tài khoản, có thời hạn hiệu lực.
 *
 * Thu hồi = `revoked_at` (mất hiệu lực ngay trong ngày thu hồi, giờ Việt Nam —
 * như role assignment), không xoá dòng — giữ lịch sử "ai từng có quyền gì,
 * trong khoảng nào". `effective_to` là ngày cuối còn hiệu lực.
 *
 * Phase 1.3: cấp/thu hồi qua Access Admin (`HrRoleAdminService`) — cùng M1/M2/
 * audit với cấp role; bootstrap break-glass qua CLI (`granted_by` = null).
 */
@Entity({ schema: 'hr', name: 'account_permission_grants', synchronize: false })
export class HrAccountPermissionGrant {
  @PrimaryGeneratedColumn()
  id: number;

  /** `public.employee.id` — tài khoản đăng nhập. */
  @Column({ name: 'account_id', type: 'int' })
  accountId: number;

  @Column({ name: 'permission_code', type: 'varchar', length: 64 })
  permissionCode: string;

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

  /** Không có FK (migration 1791700000300) — null = script bootstrap. */
  @Column({ name: 'granted_by', type: 'int', nullable: true })
  grantedBy: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_by', type: 'int', nullable: true })
  revokedBy: number | null;

  @Column({ name: 'revoke_reason', type: 'text', nullable: true })
  revokeReason: string | null;

  @VersionColumn()
  version: number;
}
