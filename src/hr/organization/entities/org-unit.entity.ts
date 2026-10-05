import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Định danh cố định của đơn vị. Thuộc tính theo thời gian ở `OrgUnitRevision`. */
@Entity({ schema: 'hr', name: 'org_units', synchronize: false })
export class OrgUnit {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 32 })
  code: string;

  @Column({ name: 'created_at', type: 'timestamptz', insert: false })
  createdAt: Date;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  /** Tăng mỗi khi thêm revision — khoá lạc quan cho thay đổi cơ cấu. */
  @Column({ type: 'int' })
  version: number;
}
