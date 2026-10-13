import { MigrationInterface, QueryRunner } from 'typeorm';

const AI_DECISIONS = `'AI_REPLIED', 'SKIPPED_AI_PAUSED', 'SKIPPED_HUMAN_TAKEOVER', 'SKIPPED_CLOSED', 'DISCARDED_CONTROL_CHANGED'`;
const ALERT_TYPES = `'CANDIDATE_REQUESTED_HUMAN', 'AI_POLICY_HANDOFF', 'CANDIDATE_MESSAGE_WAITING', 'OUTBOUND_UNKNOWN', 'OUTBOUND_DEAD_LETTER', 'CHANNEL_EVENT_DEAD_LETTER', 'REFRESH_OUTCOME_UNKNOWN', 'REPEATED_AI_FAILURE'`;

/**
 * Phase 3 (P3-7.3 / G8): kiểm soát an toàn trước khi bật AI / worker / outbound.
 *
 * - `recruitment_runtime_controls`: MỘT dòng (id = 1) — dừng khẩn AI / worker / outbound
 *   không cần restart; app đọc mỗi vòng lặp, đọc lỗi = coi như đang dừng (fail-closed).
 * - Token mỗi lượt AI trên `recruitment_channel_events` (lấy từ `usage` của OpenClaw) —
 *   để giới hạn ngân sách ngày / tháng.
 * - Quyết định AI mới: `SKIPPED_RATE_LIMITED` (vượt trần lượt của người gửi → HR),
 *   `BLOCKED_BY_POLICY` (câu trả lời vi phạm chính sách → không gửi, HR xem).
 * - Cảnh báo HR mới `AI_LIMIT_REACHED` (vượt trần lượt / token toàn hệ thống → tự dừng AI).
 *
 * Enum dựng lại (rename → create → đổi kiểu cột → drop) như 1792500000000. Down từ chối
 * khi đã có dữ liệu dùng giá trị mới — không đổi nghĩa / xoá dữ liệu.
 */
export class AddRecruitmentAiSafetyControls1792700000000 implements MigrationInterface {
  name = 'AddRecruitmentAiSafetyControls1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "recruitment_runtime_controls" (
      "id" smallint NOT NULL DEFAULT 1,
      "ai_halted" boolean NOT NULL DEFAULT false,
      "worker_halted" boolean NOT NULL DEFAULT false,
      "outbound_halted" boolean NOT NULL DEFAULT false,
      "reason" character varying(200),
      "updated_by" integer,
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "CHK_recruitment_runtime_controls_single_row" CHECK ("id" = 1),
      CONSTRAINT "PK_recruitment_runtime_controls" PRIMARY KEY ("id"))`);
    await queryRunner.query(
      `INSERT INTO "recruitment_runtime_controls" ("id") VALUES (1)`,
    );

    await queryRunner.query(`ALTER TABLE "recruitment_channel_events"
      ADD "ai_input_tokens" integer,
      ADD "ai_cached_tokens" integer,
      ADD "ai_output_tokens" integer,
      ADD "ai_total_tokens" integer`);

    await this.retype(
      queryRunner,
      'recruitment_channel_events',
      'ai_decision',
      'recruitment_channel_events_ai_decision_enum',
      `${AI_DECISIONS}, 'SKIPPED_RATE_LIMITED', 'BLOCKED_BY_POLICY'`,
    );
    await this.retype(
      queryRunner,
      'recruitment_hr_alerts',
      'type',
      'recruitment_hr_alerts_type_enum',
      `${ALERT_TYPES}, 'AI_LIMIT_REACHED'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "recruitment_channel_events"
                   WHERE "ai_decision"::text IN ('SKIPPED_RATE_LIMITED', 'BLOCKED_BY_POLICY'))
           OR EXISTS (SELECT 1 FROM "recruitment_hr_alerts" WHERE "type"::text = 'AI_LIMIT_REACHED') THEN
          RAISE EXCEPTION 'còn dữ liệu dùng quyết định AI / cảnh báo mới — không gỡ';
        END IF;
      END $$`);
    await this.retype(
      queryRunner,
      'recruitment_hr_alerts',
      'type',
      'recruitment_hr_alerts_type_enum',
      ALERT_TYPES,
    );
    await this.retype(
      queryRunner,
      'recruitment_channel_events',
      'ai_decision',
      'recruitment_channel_events_ai_decision_enum',
      AI_DECISIONS,
    );
    await queryRunner.query(`ALTER TABLE "recruitment_channel_events"
      DROP COLUMN "ai_total_tokens",
      DROP COLUMN "ai_output_tokens",
      DROP COLUMN "ai_cached_tokens",
      DROP COLUMN "ai_input_tokens"`);
    await queryRunner.query(`DROP TABLE "recruitment_runtime_controls"`);
  }

  /** Cột enum không có DEFAULT (ai_decision, type) — đổi kiểu giữ nguyên giá trị. */
  private async retype(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    type: string,
    values: string,
  ) {
    await queryRunner.query(
      `ALTER TYPE "public"."${type}" RENAME TO "${type}_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."${type}" AS ENUM(${values})`,
    );
    await queryRunner.query(`ALTER TABLE "${table}"
      ALTER COLUMN "${column}" TYPE "public"."${type}"
      USING "${column}"::text::"public"."${type}"`);
    await queryRunner.query(`DROP TYPE "public"."${type}_old"`);
  }
}
