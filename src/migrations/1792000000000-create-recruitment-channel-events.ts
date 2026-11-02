import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 (P3-3): bảng event webhook của kênh tuyển dụng.
 *
 * Chống trùng nằm ở constraint `UQ_recruitment_channel_events_dedupe` — code ghi
 * bằng `INSERT ... ON CONFLICT ON CONSTRAINT ... DO NOTHING`, nên đổi tên
 * constraint này phải sửa cả `RecruitmentZaloWebhookService`.
 *
 * Bảng mới hoàn toàn: không `IF NOT EXISTS` — nếu đã có bảng/enum cùng tên
 * (vd. do synchronize) thì migration dừng hẳn thay vì lặng lẽ bỏ qua.
 */
export class CreateRecruitmentChannelEvents1792000000000 implements MigrationInterface {
  name = 'CreateRecruitmentChannelEvents1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_events_channel_enum" AS ENUM('ZALO')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_events_status_enum" AS ENUM('RECEIVED', 'IGNORED', 'PROCESSING', 'PROCESSED', 'FAILED')`,
    );
    await queryRunner.query(`CREATE TABLE "recruitment_channel_events" (
      "id" SERIAL NOT NULL,
      "channel" "public"."recruitment_channel_events_channel_enum" NOT NULL,
      "channel_account_id" character varying(64) NOT NULL,
      "provider_event_id" character varying(128),
      "dedupe_key" character varying(200) NOT NULL,
      "external_sender_id" character varying(100),
      "event_type" character varying(64) NOT NULL,
      "provider_message_id" character varying(128),
      "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "provider_created_at" TIMESTAMP WITH TIME ZONE,
      "status" "public"."recruitment_channel_events_status_enum" NOT NULL DEFAULT 'RECEIVED',
      "processed_at" TIMESTAMP WITH TIME ZONE,
      "failure_code" character varying(64),
      "payload_hash" character varying(64) NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "UQ_recruitment_channel_events_dedupe" UNIQUE ("channel", "channel_account_id", "dedupe_key"),
      CONSTRAINT "PK_recruitment_channel_events" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_recruitment_channel_events_status_received" ON "recruitment_channel_events" ("status", "received_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "recruitment_channel_events"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_events_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_events_channel_enum"`,
    );
  }
}
