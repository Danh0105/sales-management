import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 (P3-5): gửi outbox ra Zalo.
 *
 * - Trạng thái outbox: PENDING / SENDING / SENT / RETRY / UNKNOWN / DEAD_LETTER
 *   (bỏ FAILED chưa từng dùng — dòng FAILED nếu có thành DEAD_LETTER).
 * - Cột lease/fencing + `dispatched_at` (request có thể đã tới Zalo) + redact.
 * - CHECK: `SENT` không còn bản sao nội dung; trạng thái còn phải gửi phải có nội dung.
 * - `recruitment_zalo_credentials`: kho token riêng của OA tuyển dụng (đã mã hoá).
 */
export class AddRecruitmentZaloOutbound1792200000000 implements MigrationInterface {
  name = 'AddRecruitmentZaloOutbound1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."recruitment_channel_outbox_status_enum" RENAME TO "recruitment_channel_outbox_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_outbox_status_enum" AS ENUM('PENDING', 'SENDING', 'SENT', 'RETRY', 'UNKNOWN', 'DEAD_LETTER')`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_outbox" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ALTER COLUMN "status" TYPE "public"."recruitment_channel_outbox_status_enum"
      USING (CASE "status"::text WHEN 'FAILED' THEN 'DEAD_LETTER' ELSE "status"::text END)::"public"."recruitment_channel_outbox_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_outbox" ALTER COLUMN "status" SET DEFAULT 'PENDING'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."recruitment_channel_outbox_status_enum_old"`,
    );

    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ALTER COLUMN "message_text" DROP NOT NULL,
      ADD COLUMN "lease_until" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "lease_owner" character varying(100),
      ADD COLUMN "next_attempt_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "sending_started_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "dispatched_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "text_redacted_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ADD CONSTRAINT "CHK_recruitment_channel_outbox_text_status"
      CHECK (("status" <> 'SENT' OR "message_text" IS NULL)
         AND ("message_text" IS NOT NULL OR "status" IN ('SENT', 'UNKNOWN', 'DEAD_LETTER')))`);
    await queryRunner.query(
      `CREATE INDEX "IDX_recruitment_channel_outbox_recipient_queue" ON "recruitment_channel_outbox" ("channel_account_id", "external_recipient_id", "status")`,
    );

    await queryRunner.query(`CREATE TABLE "recruitment_zalo_credentials" (
      "oa_id" character varying(64) NOT NULL,
      "access_token_enc" text NOT NULL,
      "refresh_token_enc" text NOT NULL,
      "access_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "version" integer NOT NULL DEFAULT 1,
      "refreshed_at" TIMESTAMP WITH TIME ZONE,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_recruitment_zalo_credentials" PRIMARY KEY ("oa_id")
    )`);
  }

  /** Chỉ quay lại được khi chưa có dòng nào đã gửi/đang chờ đối soát cần giữ. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "recruitment_zalo_credentials"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_recruitment_channel_outbox_recipient_queue"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_outbox" DROP CONSTRAINT IF EXISTS "CHK_recruitment_channel_outbox_text_status"`,
    );
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "recruitment_channel_outbox" WHERE "message_text" IS NULL) THEN
          RAISE EXCEPTION 'outbox có dòng đã redact nội dung — không thể khôi phục NOT NULL';
        END IF;
      END $$`);
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ALTER COLUMN "message_text" SET NOT NULL,
      DROP COLUMN IF EXISTS "text_redacted_at",
      DROP COLUMN IF EXISTS "dispatched_at",
      DROP COLUMN IF EXISTS "sending_started_at",
      DROP COLUMN IF EXISTS "next_attempt_at",
      DROP COLUMN IF EXISTS "lease_owner",
      DROP COLUMN IF EXISTS "lease_until"`);
    await queryRunner.query(
      `ALTER TYPE "public"."recruitment_channel_outbox_status_enum" RENAME TO "recruitment_channel_outbox_status_enum_new"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_outbox_status_enum" AS ENUM('PENDING', 'SENDING', 'SENT', 'FAILED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_outbox" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ALTER COLUMN "status" TYPE "public"."recruitment_channel_outbox_status_enum"
      USING (CASE WHEN "status"::text IN ('RETRY', 'UNKNOWN', 'DEAD_LETTER') THEN 'FAILED' ELSE "status"::text END)::"public"."recruitment_channel_outbox_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_outbox" ALTER COLUMN "status" SET DEFAULT 'PENDING'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."recruitment_channel_outbox_status_enum_new"`,
    );
  }
}
