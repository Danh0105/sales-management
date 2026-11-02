import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3: danh tính Zalo của ứng viên là cặp (OA, zaloUserId) — id người dùng
 * Zalo chỉ duy nhất trong một OA.
 *
 * Thứ tự an toàn: thêm cột → gán `legacy` cho dữ liệu cũ → kiểm không trùng →
 * tạo unique mới + CHECK (có zaloUserId thì phải có OA, để PostgreSQL không coi
 * các NULL là khác nhau) → **sau cùng** mới bỏ unique cũ trên zaloUserId.
 * Không bao giờ có thời điểm dữ liệu không được unique nào che.
 */
export class AddRecruitmentCandidateZaloOa1791900000000 implements MigrationInterface {
  name = 'AddRecruitmentCandidateZaloOa1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recruitment_candidates" ADD COLUMN IF NOT EXISTS "zalo_oa_id" character varying(64)`,
    );
    await queryRunner.query(
      `UPDATE "recruitment_candidates" SET "zalo_oa_id" = 'legacy' WHERE "zalo_user_id" IS NOT NULL AND "zalo_oa_id" IS NULL`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "recruitment_candidates"
          WHERE "zalo_user_id" IS NOT NULL
          GROUP BY "zalo_oa_id", "zalo_user_id"
          HAVING count(*) > 1
        ) THEN
          RAISE EXCEPTION 'recruitment_candidates có (zalo_oa_id, zalo_user_id) trùng — dừng migration';
        END IF;
      END $$`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_candidates_zalo_identity" ON "recruitment_candidates" ("zalo_oa_id", "zalo_user_id") WHERE "zalo_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_candidates" ADD CONSTRAINT "CHK_recruitment_candidates_zalo_oa" CHECK ("zalo_user_id" IS NULL OR "zalo_oa_id" IS NOT NULL)`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_recruitment_candidates_zalo_user_id"`,
    );
  }

  /** Chỉ quay lại được khi mỗi zaloUserId còn thuộc đúng một OA. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "recruitment_candidates"
          WHERE "zalo_user_id" IS NOT NULL
          GROUP BY "zalo_user_id"
          HAVING count(*) > 1
        ) THEN
          RAISE EXCEPTION 'cùng zalo_user_id ở nhiều OA — không thể bỏ zalo_oa_id';
        END IF;
      END $$`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recruitment_candidates_zalo_user_id" ON "recruitment_candidates" ("zalo_user_id") WHERE "zalo_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_candidates" DROP CONSTRAINT IF EXISTS "CHK_recruitment_candidates_zalo_oa"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_recruitment_candidates_zalo_identity"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_candidates" DROP COLUMN IF EXISTS "zalo_oa_id"`,
    );
  }
}
