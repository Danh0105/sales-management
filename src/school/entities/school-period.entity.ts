import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { School } from '../schools.entity';

/**
 * Giờ của một tiết học tại MỘT trường (VD: Tiết 1 = 07:00–07:45).
 *
 * Mỗi trường có bảng tiết riêng nên không nhét được vào cột cố định trên
 * `schools`; tách bảng để còn thêm/bớt số tiết theo từng trường, và để xếp lịch
 * chọn "Tiết 1–2" là tự điền giờ thay vì gõ tay 07:30–09:00 như trước.
 */
@Entity('school_periods')
@Index('IDX_school_periods_school_period', ['schoolId', 'periodNo'], {
  unique: true,
})
export class SchoolPeriod {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'school_id', type: 'int' })
  schoolId!: number;

  @ManyToOne(() => School, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'school_id' })
  school?: School;

  /** Số thứ tự tiết trong ngày (1, 2, 3...). Duy nhất trong cùng một trường. */
  @Column({ name: 'period_no', type: 'int' })
  periodNo!: number;

  /**
   * Lưu kiểu `time` để so sánh/sắp xếp bằng SQL được, cùng quy ước với
   * `teaching_schedules.start_time`.
   */
  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime!: string;

  /** Nhãn hiển thị ở cột TIẾT: "1", "2", "RA CHƠI"... */
  @Column({ type: 'varchar', length: 100, nullable: true })
  label?: string | null;

  /** Cột BUỔI của lưới TKB. */
  @Column({ type: 'varchar', length: 10, default: 'SANG' })
  session!: 'SANG' | 'CHIEU';

  /**
   * `false` = dòng giờ ra chơi: vẫn chiếm chỗ trên lưới và vẫn phải khai giờ,
   * nhưng không xếp lịch dạy vào được. Lưu lại để lưới dựng lại y nguyên.
   */
  @Column({ name: 'is_period', type: 'boolean', default: true })
  isPeriod!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
