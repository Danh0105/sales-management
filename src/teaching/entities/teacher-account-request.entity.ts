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
import { Employee } from '../../employee/employee.entity';
import { Teacher } from './teacher.entity';

export enum TeacherAccountRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * Giáo vụ đề nghị mở tài khoản giáo viên — hồ sơ nằm ở đây cho tới khi Nhân sự
 * duyệt. Trước khi duyệt **không** có bản ghi nào trong `teachers`/`employee`,
 * nên số điện thoại chưa bị chiếm và giáo viên chưa đăng nhập được.
 */
@Entity('teacher_account_requests')
@Index('IDX_teacher_account_requests_status', ['status'])
@Index('IDX_teacher_account_requests_requested_by', ['requestedBy'])
export class TeacherAccountRequest {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Toàn bộ payload tạo giáo viên, trừ `password` (xem `passwordHash`). */
  @Column({ type: 'jsonb' })
  payload!: Record<string, any>;

  /**
   * Có giá trị = hồ sơ giáo viên đã tồn tại, duyệt xong chỉ **cấp tài khoản
   * đăng nhập** rồi gắn vào hồ sơ đó. null = duyệt xong tạo hồ sơ giáo viên mới.
   */
  @Column({ name: 'teacher_id', type: 'int', nullable: true })
  teacherId!: number | null;

  @ManyToOne(() => Teacher, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher?: Teacher | null;

  /**
   * Băm sẵn ngay lúc gửi đề nghị. Cố ý **không** lưu mật khẩu thô: hồ sơ chờ
   * duyệt có thể nằm lại nhiều ngày và ai đọc được DB cũng đọc được cột này.
   * null = đề nghị gắn tài khoản `employeeId` có sẵn, không tạo mật khẩu mới.
   */
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  passwordHash!: string | null;

  /** Nhân bản từ payload để danh sách chờ duyệt và index chống trùng không phải đọc jsonb. */
  @Column({ type: 'varchar', length: 150 })
  name!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ name: 'requested_by', type: 'int' })
  requestedBy!: number;

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requested_by' })
  requester?: Employee;

  @Column({
    type: 'varchar',
    length: 20,
    default: TeacherAccountRequestStatus.PENDING,
  })
  status!: TeacherAccountRequestStatus;

  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedBy!: number | null;

  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by' })
  reviewer?: Employee | null;

  @Column({ name: 'review_note', type: 'varchar', length: 500, nullable: true })
  reviewNote!: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  /** Hồ sơ giáo viên sinh ra sau khi duyệt — null khi còn chờ hoặc bị từ chối. */
  @Column({ name: 'created_teacher_id', type: 'int', nullable: true })
  createdTeacherId!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
