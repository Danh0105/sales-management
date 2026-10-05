import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * HR role gồm những quyền nào. Scope không nằm ở đây — scope là của từng lần
 * gán (`hr.account_role_assignments`).
 *
 * Khác `HrRolePermission` (`hr.role_permissions`): bảng đó ánh xạ role CŨ
 * (`nhansu`, `director`...) sang quyền HR kèm scope cố định.
 */
@Entity({ schema: 'hr', name: 'hr_role_permissions', synchronize: false })
export class HrRoleDefinitionPermission {
  @PrimaryColumn({ name: 'role_code', type: 'varchar', length: 64 })
  roleCode: string;

  @PrimaryColumn({ name: 'permission_code', type: 'varchar', length: 64 })
  permissionCode: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
