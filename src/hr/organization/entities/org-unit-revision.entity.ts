import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { OrgUnitStatus, OrgUnitType } from '../org-policy';

/** Thuộc tính đơn vị trong một khoảng hiệu lực. Không sửa đè — chỉ đóng `effectiveTo`. */
@Entity({ schema: 'hr', name: 'org_unit_revisions', synchronize: false })
export class OrgUnitRevision {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'org_unit_id', type: 'int' })
  orgUnitId: number;

  @Column({ name: 'unit_type', type: 'varchar', length: 16 })
  unitType: OrgUnitType;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ name: 'parent_id', type: 'int', nullable: true })
  parentId: number | null;

  @Column({ type: 'varchar', length: 16 })
  status: OrgUnitStatus;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom: string;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  @Column({ type: 'text' })
  reason: string;

  @Column({ name: 'created_at', type: 'timestamptz', insert: false })
  createdAt: Date;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;
}
