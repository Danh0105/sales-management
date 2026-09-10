import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Nhật ký thao tác của Giáo vụ / Nhân sự.
 *
 * Hai bộ phận này sửa được gần như toàn bộ dữ liệu giảng dạy (giáo viên, lớp,
 * lịch dạy, chấm công, đơn giá) và cả tài khoản nhân viên — nhưng các bảng đó
 * chỉ giữ **trạng thái hiện tại**, không cho biết ai đã đổi và đổi lúc nào.
 * Bảng này ghi lại từng request ghi dữ liệu để truy ngược khi có tranh cãi.
 */
@Entity('activity_log')
@Index(['actorId', 'createdAt'])
@Index(['resource', 'createdAt'])
export class ActivityLog {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn()
  createdAt: Date;

  @Column()
  actorId: number;

  @Column({ type: 'varchar', nullable: true })
  actorName?: string | null;

  /** Toàn bộ role của người thao tác tại thời điểm gọi, không chỉ giaovu/nhansu. */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  actorRoles: string[];

  @Column()
  method: string;

  @Column()
  path: string;

  /**
   * Đoạn đầu của path (`teachers`, `employees`, `teaching-sessions`...) — tách
   * sẵn để lọc theo màn hình mà không phải LIKE trên `path`.
   */
  @Column()
  resource: string;

  /** Body đã lược bỏ mật khẩu/token và cắt bớt nếu quá lớn. */
  @Column({ type: 'jsonb', nullable: true })
  body?: any;

  @Column({ type: 'jsonb', nullable: true })
  params?: any;

  /**
   * Tên trường / lớp / giáo viên / môn và ngày giờ tiết, chốt tại thời điểm
   * thao tác. Xem `extractContext` — nhật ký chỉ có id thì không ai đọc nổi.
   */
  @Column({ type: 'jsonb', nullable: true })
  context?: any;

  /** Bản ghi **trước** khi sửa/xoá. `null` với thao tác thêm mới. */
  @Column({ type: 'jsonb', nullable: true })
  beforeData?: any;

  /** Bản ghi **sau** khi sửa. `null` với thao tác xoá. */
  @Column({ type: 'jsonb', nullable: true })
  afterData?: any;

  /** Các field thực sự đổi: `[{ field, before, after }]`. */
  @Column({ type: 'jsonb', nullable: true })
  changes?: any;

  @Column({ type: 'jsonb', nullable: true })
  query?: any;

  @Column({ type: 'int', nullable: true })
  statusCode?: number | null;

  /** `false` khi request ném lỗi — thao tác bị từ chối cũng là thông tin cần lưu. */
  @Column({ default: true })
  success: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string | null;

  @Column({ type: 'int', nullable: true })
  durationMs?: number | null;

  @Column({ type: 'varchar', nullable: true })
  ip?: string | null;
}
