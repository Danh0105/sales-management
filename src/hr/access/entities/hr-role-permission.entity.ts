import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  VersionColumn,
} from 'typeorm';
import { HrScope } from '../hr-permission';

/**
 * Quyền HR gắn với một role của `public.employee.roles`.
 * Không khai báo relation tới `Employee` — HR chỉ đọc bảng đó, không đổi metadata của nó.
 */
@Entity({ schema: 'hr', name: 'role_permissions', synchronize: false })
export class HrRolePermission {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 64 })
  role: string;

  @Column({ name: 'permission_code', type: 'varchar', length: 64 })
  permissionCode: string;

  @Column({ type: 'varchar', length: 16 })
  scope: HrScope;

  @Column({ name: 'scope_ref_id', type: 'int', nullable: true })
  scopeRefId: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @VersionColumn()
  version: number;
}
