import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Gợi ý đơn vị từ phòng ban / role cũ — chỉ dùng cho script import (Phase 1.2). */
@Entity({ schema: 'hr', name: 'legacy_org_mappings', synchronize: false })
export class LegacyOrgMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'source_type', type: 'varchar', length: 16 })
  sourceType: 'DEPARTMENT' | 'ROLE';

  @Column({ name: 'source_value', type: 'varchar', length: 100 })
  sourceValue: string;

  @Column({ name: 'org_unit_id', type: 'int' })
  orgUnitId: number;

  @Column({ type: 'int' })
  priority: number;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', insert: false })
  createdAt: Date;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ type: 'int' })
  version: number;
}
