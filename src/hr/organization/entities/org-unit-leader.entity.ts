import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { OrgLeaderRole } from '../org-policy';

/** Lãnh đạo đơn vị theo thời gian. Kết thúc = `effectiveTo` + lý do, không xoá. */
@Entity({ schema: 'hr', name: 'org_unit_leaders', synchronize: false })
export class OrgUnitLeader {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'org_unit_id', type: 'int' })
  orgUnitId: number;

  @Column({ name: 'employee_id', type: 'int' })
  employeeId: number;

  @Column({ name: 'leader_role', type: 'varchar', length: 24 })
  leaderRole: OrgLeaderRole;

  @Column({ name: 'position_id', type: 'int', nullable: true })
  positionId: number | null;

  @Column({ name: 'is_approval_authority', type: 'boolean' })
  isApprovalAuthority: boolean;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom: string;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  @Column({ type: 'text' })
  reason: string;

  @Column({ name: 'end_reason', type: 'text', nullable: true })
  endReason: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', insert: false })
  createdAt: Date;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ name: 'ended_by', type: 'int', nullable: true })
  endedBy: number | null;

  @Column({ type: 'int' })
  version: number;
}
