import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an immutable, Owner-approved rolling recipient quota to GO PROD.
 * Existing authorizations retain their exact daily behavior as a 24-hour
 * rolling cap until a new GO PROD supersedes them.
 */
export class AddRecruitmentRecipientRollingQuota1794000000000 implements MigrationInterface {
  name = 'AddRecruitmentRecipientRollingQuota1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `LOCK TABLE "recruitment_production_authorizations" IN ACCESS EXCLUSIVE MODE`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_production_authorizations" DISABLE TRIGGER "TRG_production_authorization_guard"`,
    );
    await queryRunner.query(`
      ALTER TABLE "recruitment_production_authorizations"
        ADD COLUMN "max_requests_per_recipient_window" integer,
        ADD COLUMN "recipient_window_hours" integer
    `);
    await queryRunner.query(`
      UPDATE "recruitment_production_authorizations"
      SET "max_requests_per_recipient_window" = "max_requests_per_recipient_day",
          "recipient_window_hours" = 24
    `);
    await queryRunner.query(`
      ALTER TABLE "recruitment_production_authorizations"
        ALTER COLUMN "max_requests_per_recipient_window" SET NOT NULL,
        ALTER COLUMN "recipient_window_hours" SET NOT NULL,
        ADD CONSTRAINT "CHK_prod_auth_recipient_window" CHECK (
          "max_requests_per_recipient_window" BETWEEN 1 AND 1000
          AND "recipient_window_hours" BETWEEN 1 AND 24
          AND "max_requests_per_recipient_window" <= "max_requests_per_recipient_day"
        )
    `);
    await queryRunner.query(this.guardFunction(true));
    await queryRunner.query(
      `ALTER TABLE "recruitment_production_authorizations" ENABLE TRIGGER "TRG_production_authorization_guard"`,
    );
    await queryRunner.query(`
      COMMENT ON COLUMN "recruitment_production_authorizations"."max_requests_per_recipient_window" IS
        'Maximum outbound attempts for one OA recipient inside the rolling window approved by Owner';
      COMMENT ON COLUMN "recruitment_production_authorizations"."recipient_window_hours" IS
        'Rolling recipient quota window in hours (1..24) approved by Owner'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `LOCK TABLE "recruitment_production_authorizations" IN ACCESS EXCLUSIVE MODE`,
    );
    const incompatible = (await queryRunner.query(`
      SELECT count(*)::int AS n FROM "recruitment_production_authorizations"
      WHERE "recipient_window_hours" <> 24
         OR "max_requests_per_recipient_window" <> "max_requests_per_recipient_day"
    `)) as Array<{ n: number }>;
    if (Number(incompatible[0]?.n ?? 0) > 0) {
      throw new Error(
        'đã có GO PROD dùng rolling quota — không được xoá bằng chứng hạn mức',
      );
    }
    await queryRunner.query(
      `ALTER TABLE "recruitment_production_authorizations" DISABLE TRIGGER "TRG_production_authorization_guard"`,
    );
    await queryRunner.query(this.guardFunction(false));
    await queryRunner.query(`
      ALTER TABLE "recruitment_production_authorizations"
        DROP CONSTRAINT "CHK_prod_auth_recipient_window",
        DROP COLUMN "max_requests_per_recipient_window",
        DROP COLUMN "recipient_window_hours"
    `);
    await queryRunner.query(
      `ALTER TABLE "recruitment_production_authorizations" ENABLE TRIGGER "TRG_production_authorization_guard"`,
    );
  }

  private guardFunction(withRollingQuota: boolean): string {
    const rollingNew = withRollingQuota
      ? 'NEW."max_requests_per_recipient_window", NEW."recipient_window_hours",'
      : '';
    const rollingOld = withRollingQuota
      ? 'OLD."max_requests_per_recipient_window", OLD."recipient_window_hours",'
      : '';
    return `
      CREATE OR REPLACE FUNCTION "recruitment_production_authorization_guard"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'uỷ quyền production % là bằng chứng audit — không xoá được', OLD."id";
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW."status" <> 'ACTIVE' OR NEW."ended_at" IS NOT NULL THEN
            RAISE EXCEPTION 'uỷ quyền production mới phải ACTIVE';
          END IF;
          NEW."activated_at" := clock_timestamp();
          RETURN NEW;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtext('recruitment_production_authorizations'));
        IF OLD."status" <> 'ACTIVE' THEN
          RAISE EXCEPTION 'uỷ quyền production % đã %, không đổi được', OLD."id", OLD."status";
        END IF;
        IF NEW."status" NOT IN ('REVOKED', 'SUPERSEDED') THEN
          RAISE EXCEPTION 'uỷ quyền production %: chỉ được kết thúc (REVOKED/SUPERSEDED)', OLD."id";
        END IF;
        IF (NEW."id", NEW."go_code_fp", NEW."channel_account_id", ${rollingNew}
            NEW."max_requests_per_recipient_day", NEW."max_requests_per_day",
            NEW."daily_cost_budget_vnd", NEW."monthly_cost_budget_vnd",
            NEW."interaction_window_hours", NEW."free_window_hours", NEW."release_dist_hash",
            NEW."approved_by", NEW."approved_at", NEW."activated_at")
           IS DISTINCT FROM
           (OLD."id", OLD."go_code_fp", OLD."channel_account_id", ${rollingOld}
            OLD."max_requests_per_recipient_day", OLD."max_requests_per_day",
            OLD."daily_cost_budget_vnd", OLD."monthly_cost_budget_vnd",
            OLD."interaction_window_hours", OLD."free_window_hours", OLD."release_dist_hash",
            OLD."approved_by", OLD."approved_at", OLD."activated_at")
           OR NEW."ended_at" IS NULL OR NEW."ended_by" IS NULL OR NEW."end_reason" IS NULL THEN
          RAISE EXCEPTION 'uỷ quyền production %: nội dung bất biến, kết thúc phải ghi người + lý do', OLD."id";
        END IF;
        RETURN NEW;
      END
      $fn$
    `;
  }
}
