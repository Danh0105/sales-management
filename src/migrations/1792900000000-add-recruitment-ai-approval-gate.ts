import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3.2 Human Approval Gate.
 *
 * Schema only: does NOT enable AI, worker or outbound.
 * Existing AI PENDING rows are NOT automatically approved.
 */
export class AddRecruitmentAiApprovalGate1792900000000
  implements MigrationInterface
{
  name = 'AddRecruitmentAiApprovalGate1792900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Do not use the new enum value for DML within this transaction.
    await queryRunner.query(`
      ALTER TYPE "public"."recruitment_channel_outbox_status_enum"
      ADD VALUE IF NOT EXISTS 'AWAITING_APPROVAL'
    `);

    await queryRunner.query(`
      CREATE TABLE "recruitment_outbox_approvals" (
        "outbox_id" integer NOT NULL,
        "state" varchar(24) NOT NULL DEFAULT 'AWAITING_APPROVAL',
        "version" integer NOT NULL DEFAULT 0,
        "approved_by" integer,
        "approved_at" timestamptz,
        "expires_at" timestamptz,
        "approved_text_sha256" char(64),
        "approved_oa_id" varchar(64),
        "approved_recipient_id" varchar(100),
        "approved_control_version" integer,
        "approved_message_id" integer,
        "rejected_by" integer,
        "rejected_at" timestamptz,
        "rejection_reason" varchar(500),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "PK_p32_outbox_approvals"
          PRIMARY KEY ("outbox_id"),

        CONSTRAINT "FK_p32_approval_outbox"
          FOREIGN KEY ("outbox_id")
          REFERENCES "recruitment_channel_outbox"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "CHK_p32_approval_state"
          CHECK ("state" IN (
            'AWAITING_APPROVAL', 'APPROVED', 'REJECTED',
            'REVOKED', 'EXPIRED'
          )),

        CONSTRAINT "CHK_p32_approval_version"
          CHECK ("version" >= 0),

        CONSTRAINT "CHK_p32_approval_hash"
          CHECK (
            "approved_text_sha256" IS NULL
            OR "approved_text_sha256" ~ '^[0-9a-f]{64}$'
          ),

        CONSTRAINT "CHK_p32_approval_complete"
          CHECK (
            "state" <> 'APPROVED'
            OR (
              "approved_by" IS NOT NULL
              AND "approved_at" IS NOT NULL
              AND "expires_at" IS NOT NULL
              AND "expires_at" > "approved_at"
              AND "approved_text_sha256" IS NOT NULL
              AND "approved_oa_id" IS NOT NULL
              AND "approved_recipient_id" IS NOT NULL
              AND "approved_control_version" IS NOT NULL
              AND "approved_message_id" IS NOT NULL
            )
          ),

        CONSTRAINT "CHK_p32_rejection_complete"
          CHECK (
            "state" <> 'REJECTED'
            OR (
              "rejected_by" IS NOT NULL
              AND "rejected_at" IS NOT NULL
            )
          )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_p32_approvals_state_created"
      ON "recruitment_outbox_approvals" ("state", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "recruitment_outbox_approval_events" (
        "id" bigserial NOT NULL,
        "outbox_id" integer NOT NULL,
        "version" integer NOT NULL,
        "action" varchar(32) NOT NULL,
        "actor_employee_id" integer,
        "request_id" uuid,
        "previous_sha256" char(64),
        "current_sha256" char(64),
        "reason" varchar(500),
        "created_at" timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "PK_p32_approval_events"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_p32_approval_events_outbox"
          FOREIGN KEY ("outbox_id")
          REFERENCES "recruitment_outbox_approvals"("outbox_id")
          ON DELETE RESTRICT,

        CONSTRAINT "UQ_p32_approval_event_version"
          UNIQUE ("outbox_id", "version"),

        CONSTRAINT "UQ_p32_approval_request"
          UNIQUE ("request_id"),

        CONSTRAINT "CHK_p32_approval_event_action"
          CHECK ("action" IN (
            'CREATED',
            'APPROVED',
            'EDITED_AND_APPROVED',
            'REJECTED',
            'REVOKED',
            'EXPIRED'
          ))
      )
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL cannot directly remove one enum value.
    // Manual rollback requires an explicit data-safety review.
    throw new Error(
      'P3.2 approval schema requires a reviewed manual rollback',
    );
  }
}
