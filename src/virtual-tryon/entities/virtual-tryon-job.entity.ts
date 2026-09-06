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
import { TryOnJobStatus } from '../virtual-tryon.enum';

/**
 * Một lần thử đồ ảo: ảnh người + ảnh trang phục → ảnh kết quả.
 *
 * Lưu cả 2 ảnh đầu vào chứ không chỉ ảnh kết quả: khi khách báo "ra ảnh sai",
 * không có đầu vào thì không dựng lại được tình huống để đối chiếu; và cần
 * chúng để chạy lại job mà không bắt người dùng upload lần nữa.
 */
@Entity('virtual_tryon_jobs')
export class VirtualTryOnJob {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: 'varchar',
    length: 20,
    default: TryOnJobStatus.PENDING,
  })
  @Index('IDX_virtual_tryon_jobs_status')
  status!: TryOnJobStatus;

  /** Ảnh người mặc, đường dẫn public dạng `/uploads/virtual-tryon/...`. */
  @Column({ name: 'person_image_url', type: 'varchar', length: 500 })
  personImageUrl!: string;

  /** Ảnh món đồ cần mặc thử. */
  @Column({ name: 'garment_image_url', type: 'varchar', length: 500 })
  garmentImageUrl!: string;

  /** Chỉ có khi job thành công. */
  @Column({
    name: 'result_image_url',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  resultImageUrl?: string | null;

  /**
   * Prompt thực tế đã gửi cho mô hình (mặc định hoặc người dùng tự nhập).
   * Lưu lại để giải thích được vì sao ảnh ra như vậy khi cần rà soát.
   */
  @Column({ type: 'text' })
  prompt!: string;

  @Column({ type: 'varchar', length: 60 })
  model!: string;

  @Column({ type: 'varchar', length: 20 })
  size!: string;

  /** Mã lỗi ổn định cho client xử lý; message là câu tiếng Việt hiển thị được. */
  @Column({
    name: 'error_code',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  errorCode?: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string | null;

  /** Token đã dùng — để đối soát chi phí theo từng job. */
  @Column({ name: 'input_tokens', type: 'int', nullable: true })
  inputTokens?: number | null;

  @Column({ name: 'output_tokens', type: 'int', nullable: true })
  outputTokens?: number | null;

  /** Thời gian gọi mô hình (ms), tách khỏi thời gian nằm chờ trong hàng đợi. */
  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs?: number | null;

  /**
   * Mã bí mật cấp cho người tạo job KHI KHÔNG ĐĂNG NHẬP.
   *
   * Id là số tăng dần nên nếu chỉ dựa vào id thì ai cũng dò được job của người
   * khác — mà job chứa ảnh chân dung. Người ẩn danh phải kèm đúng token này
   * mới xem/xoá được job của chính họ; người đã đăng nhập dùng quyền tài khoản
   * nên không cần.
   */
  @Column({ name: 'public_token', type: 'varchar', length: 64, nullable: true })
  @Index('IDX_virtual_tryon_jobs_public_token')
  publicToken?: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  @Index('IDX_virtual_tryon_jobs_created_by')
  createdBy?: number | null;

  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  creator?: Employee | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamp', nullable: true })
  finishedAt?: Date | null;
}
