import { MigrationInterface, QueryRunner } from 'typeorm';

/** P1-FIX: additive fail-safe latch and per-event quota reservation. */
export class AddRecruitmentAuditQuotaFailsafe1792800000000 implements MigrationInterface {
  name = 'AddRecruitmentAuditQuotaFailsafe1792800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "recruitment_runtime_controls"
      ADD "failsafe_halted" boolean NOT NULL DEFAULT false,
      ADD "failsafe_reason" character varying(100),
      ADD "failsafe_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "recruitment_channel_events"
      ADD "ai_reserved_tokens" integer,
      ADD "ai_reserved_at" TIMESTAMP WITH TIME ZONE,
      ADD "ai_reservation_day" date,
      ADD "ai_reservation_month" date,
      ADD "ai_provider_dispatched_at" TIMESTAMP WITH TIME ZONE,
      ADD CONSTRAINT "CHK_recruitment_channel_events_reserved_tokens_nonnegative"
        CHECK ("ai_reserved_tokens" IS NULL OR "ai_reserved_tokens" >= 0),
      ADD CONSTRAINT "CHK_recruitment_channel_events_reservation_complete"
        CHECK (num_nonnulls("ai_reserved_tokens", "ai_reserved_at", "ai_reservation_day", "ai_reservation_month") IN (0, 4)),
      ADD CONSTRAINT "CHK_recruitment_channel_events_dispatch_after_reservation"
        CHECK ("ai_provider_dispatched_at" IS NULL OR "ai_control_version" IS NOT NULL)`);
    await q.query(`CREATE INDEX "IDX_recruitment_channel_events_ai_quota"
      ON "recruitment_channel_events" ("ai_reservation_day", "ai_reservation_month", "ai_reserved_at")
      WHERE "ai_control_version" IS NOT NULL`);
    await q.query(`ALTER TYPE "public"."recruitment_channel_events_ai_decision_enum"
      ADD VALUE IF NOT EXISTS 'DISCARDED_RUNTIME_HALTED'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "recruitment_runtime_controls" WHERE failsafe_halted)
         OR EXISTS (SELECT 1 FROM "recruitment_channel_events"
                    WHERE ai_reserved_at IS NOT NULL OR ai_provider_dispatched_at IS NOT NULL
                       OR ai_decision::text = 'DISCARDED_RUNTIME_HALTED') THEN
        RAISE EXCEPTION 'P1-FIX state exists; reconcile before rollback';
      END IF;
    END $$`);
    await q.query(`DROP INDEX "IDX_recruitment_channel_events_ai_quota"`);
    await q.query(`ALTER TABLE "recruitment_channel_events"
      DROP CONSTRAINT "CHK_recruitment_channel_events_dispatch_after_reservation",
      DROP CONSTRAINT "CHK_recruitment_channel_events_reservation_complete",
      DROP CONSTRAINT "CHK_recruitment_channel_events_reserved_tokens_nonnegative",
      DROP COLUMN "ai_provider_dispatched_at",
      DROP COLUMN "ai_reservation_month",
      DROP COLUMN "ai_reservation_day",
      DROP COLUMN "ai_reserved_at",
      DROP COLUMN "ai_reserved_tokens"`);
    await q.query(`ALTER TABLE "recruitment_runtime_controls"
      DROP COLUMN "failsafe_at", DROP COLUMN "failsafe_reason", DROP COLUMN "failsafe_halted"`);
    // PostgreSQL cannot remove an enum value without retyping the column. Leaving an
    // unused value is deliberate; code/schema rollback remains data-safe.
  }
}
