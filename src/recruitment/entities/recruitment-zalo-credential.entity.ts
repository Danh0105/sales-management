import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Token OA **tuyển dụng** — kho riêng, KHÔNG dùng chung `zalo_tokens` của OA giáo viên.
 *
 * Token lưu đã mã hoá (AES-256-GCM, khoá `RECRUITMENT_ZALO_TOKEN_KEY` ngoài DB):
 * lộ bản dump DB không lộ token. `version` tăng mỗi lần refresh — sender thấy
 * token hỏng thì refresh có khoá dòng (`FOR UPDATE`) và so `version`, nên hai
 * sender không cùng xoay refresh token (Zalo chỉ cho dùng refresh token một lần).
 */
@Entity('recruitment_zalo_credentials')
export class RecruitmentZaloCredential {
  @PrimaryColumn({
    name: 'oa_id',
    type: 'varchar',
    length: 64,
    primaryKeyConstraintName: 'PK_recruitment_zalo_credentials',
  })
  oaId!: string;

  @Column({ name: 'access_token_enc', type: 'text' })
  accessTokenEnc!: string;

  @Column({ name: 'refresh_token_enc', type: 'text' })
  refreshTokenEnc!: string;

  @Column({ name: 'access_expires_at', type: 'timestamptz' })
  accessExpiresAt!: Date;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ name: 'refreshed_at', type: 'timestamptz', nullable: true })
  refreshedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
