import { MigrationInterface, QueryRunner } from 'typeorm';

const STATUSES = `'PENDING', 'SENDING', 'SENT', 'RETRY', 'UNKNOWN', 'DEAD_LETTER'`;

/**
 * Phase 3 (P3-6.5): trạng thái outbox `SUPPRESSED` — tin AI bị chặn ngay trước khi
 * gửi vì HR đã tiếp quản / đóng / đổi version hội thoại sau khi tin được xếp hàng.
 *
 * - Enum dựng lại (rename → create → đổi kiểu cột → drop) thay vì `ADD VALUE`: giá
 *   trị mới thêm bằng `ADD VALUE` không dùng được trong CHECK của cùng transaction.
 * - CHECK nội dung: `SUPPRESSED` như `SENT` — bắt buộc đã xoá bản sao nội dung.
 * - CHECK nguồn: chỉ tin AI mới được `SUPPRESSED` (tin HR luôn gửi khi HR tiếp quản).
 */
export class AddRecruitmentOutboxSuppressed1792500000000 implements MigrationInterface {
  name = 'AddRecruitmentOutboxSuppressed1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      DROP CONSTRAINT "CHK_recruitment_channel_outbox_text_status"`);
    await this.retype(
      queryRunner,
      `${STATUSES}, 'SUPPRESSED'`,
      `"status"::text`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ADD CONSTRAINT "CHK_recruitment_channel_outbox_text_status"
      CHECK (("status" NOT IN ('SENT', 'SUPPRESSED') OR "message_text" IS NULL)
         AND ("message_text" IS NOT NULL OR "status" IN ('SENT', 'UNKNOWN', 'DEAD_LETTER', 'SUPPRESSED'))),
      ADD CONSTRAINT "CHK_recruitment_channel_outbox_suppressed_source"
      CHECK ("status" <> 'SUPPRESSED' OR "source_type" = 'AI_REPLY')`);
  }

  /**
   * Quay lại: dòng `SUPPRESSED` thành `DEAD_LETTER` (cùng ý nghĩa "không bao giờ gửi",
   * `last_error_code` vẫn giữ lý do CONTROL_*).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      DROP CONSTRAINT IF EXISTS "CHK_recruitment_channel_outbox_suppressed_source",
      DROP CONSTRAINT "CHK_recruitment_channel_outbox_text_status"`);
    await this.retype(
      queryRunner,
      STATUSES,
      `CASE "status"::text WHEN 'SUPPRESSED' THEN 'DEAD_LETTER' ELSE "status"::text END`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ADD CONSTRAINT "CHK_recruitment_channel_outbox_text_status"
      CHECK (("status" <> 'SENT' OR "message_text" IS NULL)
         AND ("message_text" IS NOT NULL OR "status" IN ('SENT', 'UNKNOWN', 'DEAD_LETTER')))`);
  }

  private async retype(
    queryRunner: QueryRunner,
    values: string,
    using: string,
  ) {
    await queryRunner.query(
      `ALTER TYPE "public"."recruitment_channel_outbox_status_enum" RENAME TO "recruitment_channel_outbox_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_outbox_status_enum" AS ENUM(${values})`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_outbox" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ALTER COLUMN "status" TYPE "public"."recruitment_channel_outbox_status_enum"
      USING (${using})::"public"."recruitment_channel_outbox_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_outbox" ALTER COLUMN "status" SET DEFAULT 'PENDING'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."recruitment_channel_outbox_status_enum_old"`,
    );
  }
}
