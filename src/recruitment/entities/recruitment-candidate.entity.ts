import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../utils/numeric-transformer';
import { CandidateSource } from '../recruitment.enums';

/**
 * Ứng viên. Một người có thể ứng tuyển nhiều vị trí (xem `RecruitmentApplication`).
 *
 * Chống trùng: `zaloUserId` là định danh mạnh (unique); `phone`/`email` chỉ để
 * **báo nghi trùng** — không unique vì không được tự gộp hồ sơ, HR quyết định.
 */
@Entity('recruitment_candidates')
@Index('UQ_recruitment_candidates_zalo_user_id', ['zaloUserId'], {
  unique: true,
  where: '"zalo_user_id" IS NOT NULL',
})
@Index('IDX_recruitment_candidates_phone', ['phone'])
@Index('IDX_recruitment_candidates_email', ['email'])
@Check(
  'CHK_recruitment_candidates_experience',
  '"total_experience_months" IS NULL OR "total_experience_months" >= 0',
)
@Check(
  'CHK_recruitment_candidates_salary',
  '"expected_salary" IS NULL OR "expected_salary" >= 0',
)
export class RecruitmentCandidate {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_recruitment_candidates',
  })
  id!: number;

  /** Có thể trống lúc AI mới nhận tin nhắn đầu tiên, chưa hỏi được tên. */
  @Column({ name: 'full_name', type: 'varchar', length: 255, nullable: true })
  fullName!: string | null;

  /** Đã chuẩn hoá về dạng `0xxxxxxxxx` (xem `normalizePhone`). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone!: string | null;

  /** Đã chuẩn hoá chữ thường. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({
    name: 'zalo_user_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  zaloUserId!: string | null;

  @Column({
    type: 'enum',
    enum: CandidateSource,
    default: CandidateSource.MANUAL,
  })
  source!: CandidateSource;

  @Column({ type: 'varchar', length: 255, nullable: true })
  location!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  education!: string | null;

  @Column({ name: 'experience_summary', type: 'text', nullable: true })
  experienceSummary!: string | null;

  @Column({ name: 'total_experience_months', type: 'int', nullable: true })
  totalExperienceMonths!: number | null;

  @Column({ name: 'current_job', type: 'varchar', length: 255, nullable: true })
  currentJob!: string | null;

  @Column({
    name: 'expected_salary',
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  expectedSalary!: number | null;

  /** `YYYY-MM-DD`. */
  @Column({ name: 'available_from', type: 'date', nullable: true })
  availableFrom!: string | null;

  /** Kỹ năng đã được AI/HR map về đúng từ vựng của tiêu chí vị trí. */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  skills!: string[];

  /**
   * Chỉ lưu tham chiếu tới CV. **Không** upload CV vào `uploads/` — thư mục
   * đó public qua `/uploads/`.
   */
  @Column({ name: 'cv_url', type: 'varchar', length: 1000, nullable: true })
  cvUrl!: string | null;

  /** Ghi chú nội bộ của HR — không bao giờ trả cho AI. */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, string | number | boolean | null>;

  /** Ứng viên khác trùng SĐT/email lúc tạo/sửa — chờ HR xem, không tự gộp. */
  @Column({
    name: 'suspected_duplicate_ids',
    type: 'int',
    array: true,
    default: () => "'{}'",
  })
  suspectedDuplicateIds!: number[];

  @Column({
    name: 'deletion_requested_at',
    type: 'timestamptz',
    nullable: true,
  })
  deletionRequestedAt!: Date | null;

  /** Có giá trị thì mọi thao tác ghi của AI trên ứng viên này bị chặn. */
  @Column({ name: 'ai_stopped_at', type: 'timestamptz', nullable: true })
  aiStoppedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
