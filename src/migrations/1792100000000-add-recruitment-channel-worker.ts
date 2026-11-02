import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 (P3-4): `recruitment_channel_events` thành hàng đợi bền cho worker
 * (nội dung tin tạm thời + lease/fencing + lịch thử lại) và bảng
 * `recruitment_channel_outbox` giữ tin trả lời chờ gửi.
 *
 * - CHECK `CHK_recruitment_channel_events_text_status`: event `PROCESSED`/`IGNORED`
 *   không bao giờ còn nội dung tin — PII chỉ nằm lâu dài ở `recruitment_messages`.
 * - Unique `source_event_id` ở outbox: một event đến sinh tối đa một tin đi.
 *
 * Chỉ thêm cột nullable/có default → không khoá bảng lâu, không đổi dữ liệu cũ.
 */
export class AddRecruitmentChannelWorker1792100000000 implements MigrationInterface {
  name = 'AddRecruitmentChannelWorker1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recruitment_channel_events"
      ADD COLUMN "normalized_message_text" text,
      ADD COLUMN "attempt_count" integer NOT NULL DEFAULT 0,
      ADD COLUMN "processing_started_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "lease_until" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "lease_owner" character varying(100),
      ADD COLUMN "next_attempt_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "last_error_code" character varying(64),
      ADD COLUMN "text_redacted_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "recruitment_channel_events"
      ADD CONSTRAINT "CHK_recruitment_channel_events_text_status"
      CHECK ("normalized_message_text" IS NULL OR "status" IN ('RECEIVED', 'PROCESSING', 'FAILED'))`);
    await queryRunner.query(
      `CREATE INDEX "IDX_recruitment_channel_events_sender_queue" ON "recruitment_channel_events" ("channel_account_id", "external_sender_id", "status")`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_outbox_channel_enum" AS ENUM('ZALO')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_outbox_status_enum" AS ENUM('PENDING', 'SENDING', 'SENT', 'FAILED')`,
    );
    await queryRunner.query(`CREATE TABLE "recruitment_channel_outbox" (
      "id" SERIAL NOT NULL,
      "source_event_id" integer NOT NULL,
      "channel" "public"."recruitment_channel_outbox_channel_enum" NOT NULL,
      "channel_account_id" character varying(64) NOT NULL,
      "external_recipient_id" character varying(100) NOT NULL,
      "message_text" text NOT NULL,
      "recruitment_message_id" integer,
      "status" "public"."recruitment_channel_outbox_status_enum" NOT NULL DEFAULT 'PENDING',
      "attempt_count" integer NOT NULL DEFAULT 0,
      "provider_message_id" character varying(128),
      "last_error_code" character varying(64),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "sent_at" TIMESTAMP WITH TIME ZONE,
      CONSTRAINT "UQ_recruitment_channel_outbox_source_event" UNIQUE ("source_event_id"),
      CONSTRAINT "PK_recruitment_channel_outbox" PRIMARY KEY ("id"),
      CONSTRAINT "FK_recruitment_channel_outbox_source_event" FOREIGN KEY ("source_event_id") REFERENCES "recruitment_channel_events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "FK_recruitment_channel_outbox_message" FOREIGN KEY ("recruitment_message_id") REFERENCES "recruitment_messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_recruitment_channel_outbox_status_created" ON "recruitment_channel_outbox" ("status", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "recruitment_channel_outbox"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_outbox_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_outbox_channel_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_recruitment_channel_events_sender_queue"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_channel_events" DROP CONSTRAINT IF EXISTS "CHK_recruitment_channel_events_text_status"`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_events"
      DROP COLUMN IF EXISTS "text_redacted_at",
      DROP COLUMN IF EXISTS "last_error_code",
      DROP COLUMN IF EXISTS "next_attempt_at",
      DROP COLUMN IF EXISTS "lease_owner",
      DROP COLUMN IF EXISTS "lease_until",
      DROP COLUMN IF EXISTS "processing_started_at",
      DROP COLUMN IF EXISTS "attempt_count",
      DROP COLUMN IF EXISTS "normalized_message_text"`);
  }
}
