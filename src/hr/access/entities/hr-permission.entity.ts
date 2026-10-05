import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** Bảng quản lý bằng `src/hr/migrations` — `synchronize: false` là bắt buộc. */
@Entity({ schema: 'hr', name: 'permissions', synchronize: false })
export class HrPermissionEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  code: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'is_sensitive', type: 'boolean', default: false })
  isSensitive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
