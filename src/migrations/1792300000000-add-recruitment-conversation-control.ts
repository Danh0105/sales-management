import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 (P3-6): điều khiển hội thoại (HR tiếp quản / trả lại AI / đóng), tin HR
 * qua outbox, đối soát outbox UNKNOWN, cảnh báo HR bền.
 *
 * - `recruitment_conversations`: `control_mode` (AI_ACTIVE/HUMAN_TAKEOVER/CLOSED) +
 *   `control_version` (fencing với worker). Hội thoại đang `CLOSED` → `control_mode`
 *   CLOSED. `AI_PAUSED` không lưu: suy ra từ handoff/hồ sơ/ứng viên.
 * - `recruitment_messages.author_employee_id`: HR nào viết tin.
 * - `recruitment_channel_outbox`: `source_type` (AI_REPLY/HR_MESSAGE), `source_event_id`
 *   chỉ bắt buộc với AI_REPLY (CHECK), unique `recruitment_message_id` (một tin
 *   canonical → tối đa một dòng gửi), cột đối soát.
 * - `recruitment_channel_events`: `conversation_id`, `ai_decision`.
 * - `recruitment_hr_alerts`: unique (`type`, `source_key`).
 */
export class AddRecruitmentConversationControl1792300000000 implements MigrationInterface {
  name = 'AddRecruitmentConversationControl1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_conversations_control_mode_enum" AS ENUM('AI_ACTIVE', 'HUMAN_TAKEOVER', 'CLOSED')`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_conversations"
      ADD COLUMN "control_mode" "public"."recruitment_conversations_control_mode_enum" NOT NULL DEFAULT 'AI_ACTIVE',
      ADD COLUMN "control_version" integer NOT NULL DEFAULT 1,
      ADD COLUMN "control_changed_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "control_changed_by" integer,
      ADD COLUMN "taken_over_by" integer,
      ADD COLUMN "resume_signal_pending" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `UPDATE "recruitment_conversations" SET "control_mode" = 'CLOSED' WHERE "status" = 'CLOSED'`,
    );

    await queryRunner.query(
      `ALTER TABLE "recruitment_messages" ADD COLUMN "author_employee_id" integer`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_outbox_source_type_enum" AS ENUM('AI_REPLY', 'HR_MESSAGE')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_outbox_resolution_enum" AS ENUM('MARK_SENT', 'RETRY', 'DEAD_LETTER')`,
    );
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "recruitment_channel_outbox"
          WHERE "recruitment_message_id" IS NOT NULL
          GROUP BY "recruitment_message_id" HAVING count(*) > 1
        ) THEN
          RAISE EXCEPTION 'outbox có nhiều dòng cho cùng một tin canonical — dừng migration';
        END IF;
      END $$`);
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      ALTER COLUMN "source_event_id" DROP NOT NULL,
      ADD COLUMN "source_type" "public"."recruitment_channel_outbox_source_type_enum" NOT NULL DEFAULT 'AI_REPLY',
      ADD COLUMN "control_version" integer,
      ADD COLUMN "resolution" "public"."recruitment_channel_outbox_resolution_enum",
      ADD COLUMN "resolved_by" integer,
      ADD COLUMN "resolved_at" TIMESTAMP WITH TIME ZONE,
      ADD CONSTRAINT "UQ_recruitment_channel_outbox_message" UNIQUE ("recruitment_message_id"),
      ADD CONSTRAINT "CHK_recruitment_channel_outbox_source"
        CHECK ("source_type" <> 'AI_REPLY' OR "source_event_id" IS NOT NULL)`);

    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_channel_events_ai_decision_enum" AS ENUM('AI_REPLIED', 'SKIPPED_AI_PAUSED', 'SKIPPED_HUMAN_TAKEOVER', 'SKIPPED_CLOSED', 'DISCARDED_CONTROL_CHANGED')`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_events"
      ADD COLUMN "conversation_id" integer,
      ADD COLUMN "ai_decision" "public"."recruitment_channel_events_ai_decision_enum"`);

    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_hr_alerts_type_enum" AS ENUM('CANDIDATE_REQUESTED_HUMAN', 'AI_POLICY_HANDOFF', 'CANDIDATE_MESSAGE_WAITING', 'OUTBOUND_UNKNOWN', 'OUTBOUND_DEAD_LETTER', 'CHANNEL_EVENT_DEAD_LETTER', 'REFRESH_OUTCOME_UNKNOWN', 'REPEATED_AI_FAILURE')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_hr_alerts_severity_enum" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recruitment_hr_alerts_status_enum" AS ENUM('OPEN', 'ACKNOWLEDGED')`,
    );
    await queryRunner.query(`CREATE TABLE "recruitment_hr_alerts" (
      "id" SERIAL NOT NULL,
      "type" "public"."recruitment_hr_alerts_type_enum" NOT NULL,
      "severity" "public"."recruitment_hr_alerts_severity_enum" NOT NULL,
      "status" "public"."recruitment_hr_alerts_status_enum" NOT NULL DEFAULT 'OPEN',
      "source_key" character varying(150) NOT NULL,
      "candidate_id" integer,
      "application_id" integer,
      "conversation_id" integer,
      "handoff_id" integer,
      "outbox_id" integer,
      "event_id" integer,
      "details" jsonb NOT NULL DEFAULT '{}',
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "acknowledged_at" TIMESTAMP WITH TIME ZONE,
      "acknowledged_by" integer,
      "acknowledged_by_name" character varying(255),
      CONSTRAINT "UQ_recruitment_hr_alerts_source" UNIQUE ("type", "source_key"),
      CONSTRAINT "PK_recruitment_hr_alerts" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_recruitment_hr_alerts_status_created" ON "recruitment_hr_alerts" ("status", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "recruitment_hr_alerts"`);
    for (const type of [
      'recruitment_hr_alerts_status_enum',
      'recruitment_hr_alerts_severity_enum',
      'recruitment_hr_alerts_type_enum',
    ]) {
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."${type}"`);
    }
    await queryRunner.query(`ALTER TABLE "recruitment_channel_events"
      DROP COLUMN IF EXISTS "ai_decision",
      DROP COLUMN IF EXISTS "conversation_id"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_events_ai_decision_enum"`,
    );
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "recruitment_channel_outbox" WHERE "source_event_id" IS NULL) THEN
          RAISE EXCEPTION 'outbox có tin HR (không có source_event_id) — không thể quay lại';
        END IF;
      END $$`);
    await queryRunner.query(`ALTER TABLE "recruitment_channel_outbox"
      DROP CONSTRAINT IF EXISTS "CHK_recruitment_channel_outbox_source",
      DROP CONSTRAINT IF EXISTS "UQ_recruitment_channel_outbox_message",
      DROP COLUMN IF EXISTS "resolved_at",
      DROP COLUMN IF EXISTS "resolved_by",
      DROP COLUMN IF EXISTS "resolution",
      DROP COLUMN IF EXISTS "control_version",
      DROP COLUMN IF EXISTS "source_type",
      ALTER COLUMN "source_event_id" SET NOT NULL`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_outbox_resolution_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_channel_outbox_source_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_messages" DROP COLUMN IF EXISTS "author_employee_id"`,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_conversations"
      DROP COLUMN IF EXISTS "resume_signal_pending",
      DROP COLUMN IF EXISTS "taken_over_by",
      DROP COLUMN IF EXISTS "control_changed_by",
      DROP COLUMN IF EXISTS "control_changed_at",
      DROP COLUMN IF EXISTS "control_version",
      DROP COLUMN IF EXISTS "control_mode"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."recruitment_conversations_control_mode_enum"`,
    );
  }
}
