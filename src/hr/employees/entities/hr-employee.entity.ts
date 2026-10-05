import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { AttendanceMode, Gender } from '../hr-employee-profile';

export enum HrEmployeeStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

/**
 * Hồ sơ nhân sự. KHÔNG phải tài khoản đăng nhập: `accountId` trỏ tới tài
 * khoản nếu có, có thể null.
 *
 * `status` (ACTIVE/INACTIVE) là trạng thái HỒ SƠ trong hệ thống — KHÔNG phải
 * nguồn sự thật về trạng thái việc làm (thử việc, chính thức, nghỉ việc…).
 * Từ Phase 1.4, Employment History là nguồn sự thật đó tại một thời điểm;
 * không thêm dữ liệu việc làm (ngày vào làm, đơn vị, chức danh…) vào bảng này.
 */
@Entity({ schema: 'hr', name: 'employees', synchronize: false })
export class HrEmployee {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'employee_code', type: 'varchar', length: 32 })
  employeeCode: string;

  @Column({ name: 'full_name', type: 'varchar', length: 200 })
  fullName: string;

  @Column({ name: 'account_id', type: 'int', nullable: true })
  accountId: number | null;

  @Column({ type: 'varchar', length: 16 })
  status: HrEmployeeStatus;

  /** Phase 1.2.3 — UNASSIGNED = chưa phân loại (không ngầm hiểu là SHIFT). */
  @Column({ name: 'attendance_mode', type: 'varchar', length: 20 })
  attendanceMode: AttendanceMode;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  gender: Gender | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ name: 'work_email', type: 'varchar', length: 254, nullable: true })
  workEmail: string | null;

  @Column({
    name: 'personal_email',
    type: 'varchar',
    length: 254,
    nullable: true,
  })
  personalEmail: string | null;

  /**
   * NỘI BỘ — luôn do server tính từ `fullName` (`normalizeVietnameseName`),
   * cùng transaction với thay đổi tên. Không nhận từ client, không trả ra API.
   */
  @Column({ name: 'full_name_search', type: 'text', select: false })
  fullNameSearch: string;

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
