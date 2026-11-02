import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 (P3-7.2A): bảng cách ly webhook Zalo OA tuyển dụng — request nhận khi chưa
 * có OA secret key (thân thô mã hoá), xác minh chữ ký hồi tố khi có key.
 *
 * - CHECK: nội dung mã hoá chỉ tồn tại khi `QUARANTINED`.
 * - Unique (kênh, OA, payload hash): Zalo gửi lại cùng request → một dòng.
 * - Bảng mới, không đụng bảng hiện có.
 */
export class AddRecruitmentWebhookQuarantine1792600000000 implements MigrationInterface {
  name = 'AddRecruitmentWebhookQuarantine1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_quarantine_channel_enum" AS ENUM('ZALO')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_quarantine_status_enum" AS ENUM('QUARANTINED', 'VERIFIED', 'REJECTED', 'EXPIRED')`,
    );
    await queryRunner.query(`CREATE TABLE "recruitment_channel_quarantine" (
      "id" SERIAL NOT NULL,
      "channel" "public"."recruitment_channel_quarantine_channel_enum" NOT NULL,
      "channel_account_id" character varying(64) NOT NULL,
      "payload_hash" character varying(64) NOT NULL,
      "signature" character varying(200),
      "event_type" character varying(64),
      "body_size" integer NOT NULL,
      "body_enc" text,
      "status" "public"."recruitment_channel_quarantine_status_enum" NOT NULL DEFAULT 'QUARANTINED',
      "resolution_code" character varying(64),
      "channel_event_id" integer,
      "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "resolved_at" TIMESTAMP WITH TIME ZONE,
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "UQ_recruitment_channel_quarantine_payload" UNIQUE ("channel", "channel_account_id", "payload_hash"),
      CONSTRAINT "CHK_recruitment_channel_quarantine_body" CHECK (("body_enc" IS NULL) = ("status" <> 'QUARANTINED')),
      CONSTRAINT "PK_recruitment_channel_quarantine" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_recruitment_channel_quarantine_status_received" ON "recruitment_channel_quarantine" ("status", "received_at")`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_quarantine"
      ADD CONSTRAINT "FK_recruitment_channel_quarantine_event" FOREIGN KEY ("channel_event_id")
      REFERENCES "recruitment_channel_events"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "recruitment_channel_quarantine" WHERE "status" = 'QUARANTINED') THEN
          RAISE EXCEPTION 'còn request đang cách ly chưa xác minh — xác minh hoặc chờ hết hạn trước khi gỡ bảng';
        END IF;
      END $$`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "recruitment_channel_quarantine"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_quarantine_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_quarantine_channel_enum"`,
    );
  }
}
