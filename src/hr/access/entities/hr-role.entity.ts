import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * HR role — KHÔNG phải role trong `public.employee.roles`. Mã viết hoa
 * (`HR_ADMIN`) để không trùng role cũ, và không ảnh hưởng `@Roles()`.
 */
@Entity({ schema: 'hr', name: 'roles', synchronize: false })
export class HrRole {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  code: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
