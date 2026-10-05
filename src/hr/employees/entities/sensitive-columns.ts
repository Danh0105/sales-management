import { Column } from 'typeorm';

/**
 * Cột chung của bảng dữ liệu nhạy cảm theo nhân viên. Cột `*_encrypted` /
 * `*_hash` không bao giờ được trả ra API — service map sang dạng che.
 */
export abstract class HrSensitiveRecord {
  @Column({ name: 'employee_id', type: 'int' })
  employeeId: number;

  @Column({ type: 'int' })
  version: number;

  @Column({ name: 'created_at', type: 'timestamptz', insert: false })
  createdAt: Date;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'updated_at', type: 'timestamptz', insert: false })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;
}
