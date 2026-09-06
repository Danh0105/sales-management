import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  ManyToMany,
  JoinTable,
  Index,
} from 'typeorm';
import { Employee } from '../../employee/employee.entity';
import { numericTransformer } from '../../utils/numeric-transformer';
import { TeachingSchedule } from './teaching-schedule.entity';
import { SubjectCatalog } from '../../subject-catalog/subject-catalog.entity';
import { Ward } from '../../ward/ward.entity';

/**
 * Giáo viên là thực thể riêng (quản lý được cả giáo viên thuê ngoài không có tài khoản).
 * `employeeId` chỉ gắn khi giáo viên cơ hữu cần đăng nhập xem lịch của mình.
 */
@Entity('teachers')
export class Teacher {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ type: 'varchar', length: 20, nullable: true, unique: true })
  phone?: string | null;

  @Column({ type: 'varchar', nullable: true })
  email?: string | null;

  @Column({ name: 'avatar_url', type: 'varchar', length: 500, nullable: true })
  avatarUrl?: string | null;

  /** Tài khoản đăng nhập tương ứng — null với giáo viên thuê ngoài. */
  @Column({ name: 'employee_id', type: 'int', nullable: true, unique: true })
  employeeId?: number | null;

  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  @Index('IDX_teachers_is_active')
  isActive!: boolean;

  @Column({ name: 'max_periods_per_week', type: 'int', nullable: true })
  maxPeriodsPerWeek?: number | null;

  /** Đơn giá riêng mỗi tiết; null = dùng đơn giá của môn học. */
  @Column({
    name: 'default_rate_per_period',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  defaultRatePerPeriod?: number | null;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  /** ID ổn định của giáo viên trong Zalo Mini App (`userInfo.id`), Nhân sự nhập tay. */
  @Column({ name: 'zalo_uid', type: 'varchar', nullable: true, unique: true })
  zaloUid?: string | null;

  /** ID giáo viên trên Zalo OA của công ty — đích để gửi thông báo qua Zalo. */
  @Column({
    name: 'zalo_user_id',
    type: 'varchar',
    nullable: true,
    unique: true,
  })
  zaloUserId?: string | null;

  /** Vị trí xuất phát/khu vực của giáo viên, dùng để gợi ý lịch gần nhất về sau. */
  @Column({
    name: 'google_maps_url',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  googleMapsUrl?: string | null;

  /**
   * Toạ độ giải ra từ `googleMapsUrl` khi Nhân sự lưu hồ sơ.
   *
   * Lưu riêng thay vì giải lại mỗi lần chấm điểm: link rút gọn `maps.app.goo.gl`
   * phải gọi mạng mới ra toạ độ, không thể làm trong vòng lặp xếp lịch. `null`
   * nghĩa là **chưa biết vị trí** — khác hẳn "ở xa", nên khi chấm điểm phải báo
   * là chưa rõ chứ không được coi như khoảng cách vô cùng.
   */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  latitude?: number | null;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  longitude?: number | null;

  /**
   * Xã/phường giáo viên có thể nhận dạy — được **toàn bộ** trường thuộc xã/
   * phường đó, tính động theo `ward.schools` tại thời điểm tra cứu (trường
   * thêm/xoá khỏi xã/phường sau này tự động cộng/trừ theo, không phải chốt
   * cứng danh sách trường lúc gán). Thay cho việc chọn từng trường lẻ trước
   * đây (`teacher_allowed_schools` cũ) — Nhân sự giờ chỉ chọn xã/phường.
   */
  @ManyToMany(() => Ward)
  @JoinTable({
    name: 'teacher_allowed_wards',
    joinColumn: { name: 'teacher_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'ward_id', referencedColumnName: 'id' },
  })
  allowedWards!: Ward[];

  /** Năng lực môn theo danh mục dùng chung, độc lập với môn riêng của từng trường. */
  @ManyToMany(() => SubjectCatalog)
  @JoinTable({
    name: 'teacher_subject_catalogs',
    joinColumn: { name: 'teacher_id', referencedColumnName: 'id' },
    inverseJoinColumn: {
      name: 'subject_catalog_id',
      referencedColumnName: 'id',
    },
  })
  teachableSubjectCatalogs!: SubjectCatalog[];

  @OneToMany(() => TeachingSchedule, (schedule) => schedule.teacher)
  schedules!: TeachingSchedule[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
