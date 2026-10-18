import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nhật ký bất biến tối thiểu cho từng request Send API. Không lưu nội dung, token,
 * header hay Zalo user id; chỉ fingerprint người nhận và metadata đối soát/quota.
 */
export class AddRecruitmentOutboundAttemptLedger1793200000000 implements MigrationInterface {
  name = 'AddRecruitmentOutboundAttemptLedger1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "recruitment_outbound_attempts" (
      "id" BIGSERIAL NOT NULL,
      "outbox_id" integer NOT NULL,
      "request_no" smallint NOT NULL,
      "lease_owner" character varying(200) NOT NULL,
      "source_type" character varying(24) NOT NULL,
      "channel_account_id" character varying(64) NOT NULL,
      "recipient_fingerprint" character(16) NOT NULL,
      "interaction_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "estimated_cost_vnd" integer NOT NULL DEFAULT 0,
      "outcome" character varying(24) NOT NULL DEFAULT 'DISPATCHING',
      "result_code" character varying(64),
      "provider_message_id" character varying(128),
      "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
      "completed_at" TIMESTAMP WITH TIME ZONE,
      CONSTRAINT "PK_recruitment_outbound_attempts" PRIMARY KEY ("id"),
      CONSTRAINT "FK_outbound_attempt_outbox" FOREIGN KEY ("outbox_id")
        REFERENCES "recruitment_channel_outbox"("id") ON DELETE RESTRICT,
      CONSTRAINT "UQ_outbound_attempt_request" UNIQUE ("outbox_id", "request_no"),
      CONSTRAINT "CHK_outbound_attempt_request_no" CHECK ("request_no" > 0),
      CONSTRAINT "CHK_outbound_attempt_source" CHECK ("source_type" IN ('AI_REPLY', 'HR_MESSAGE')),
      CONSTRAINT "CHK_outbound_attempt_fp" CHECK ("recipient_fingerprint" ~ '^[0-9a-f]{16}$'),
      CONSTRAINT "CHK_outbound_attempt_cost" CHECK ("estimated_cost_vnd" >= 0),
      CONSTRAINT "CHK_outbound_attempt_outcome" CHECK (
        "outcome" IN ('DISPATCHING', 'SENT', 'RETRY', 'UNKNOWN', 'REJECTED', 'DEAD_LETTER')
      ),
      CONSTRAINT "CHK_outbound_attempt_complete" CHECK (
        ("outcome" = 'DISPATCHING') = ("completed_at" IS NULL)
      )
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbound_attempts_day" ON "recruitment_outbound_attempts" ("started_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_outbound_attempts_recipient_day" ON "recruitment_outbound_attempts" ("channel_account_id", "recipient_fingerprint", "started_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_outbound_attempt_active_lease" ON "recruitment_outbound_attempts" ("outbox_id", "lease_owner") WHERE "outcome" = 'DISPATCHING'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const used = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "recruitment_outbound_attempts"`,
    )) as Array<{ n: number }>;
    if (Number(used[0]?.n ?? 0) > 0) {
      throw new Error(
        'recruitment_outbound_attempts có dữ liệu đối soát — không được xoá',
      );
    }
    await queryRunner.query(`DROP TABLE "recruitment_outbound_attempts"`);
  }
}
