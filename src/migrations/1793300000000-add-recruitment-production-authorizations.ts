import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G8 GO PROD — uỷ quyền production của SYSTEM OWNER, ràng buộc trong DB: production mode chỉ
 * gửi khi có đúng một uỷ quyền ACTIVE cho OA; hạn mức Owner duyệt nằm ở đây (env chỉ hạ thấp
 * hơn). App chỉ đọc; Owner tạo/kết thúc qua `g8-owner-go.py`. Thêm loại cảnh báo
 * `OUTBOUND_PROVIDER_BLOCKED` (Zalo -224). Production áp bằng
 * `integrations/openclaw/production/sql/g8-production-go-prod-up.sql` (cùng DDL, role sales_owner).
 */
export class AddRecruitmentProductionAuthorizations1793300000000 implements MigrationInterface {
  name = 'AddRecruitmentProductionAuthorizations1793300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recruitment_production_authorizations" (
        "id" serial NOT NULL,
        "go_code_fp" character(64) NOT NULL,
        "channel_account_id" character varying(64) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'ACTIVE',
        "max_requests_per_recipient_day" integer NOT NULL,
        "max_requests_per_day" integer NOT NULL,
        "daily_cost_budget_vnd" integer NOT NULL,
        "monthly_cost_budget_vnd" integer NOT NULL,
        "interaction_window_hours" integer NOT NULL,
        "free_window_hours" integer NOT NULL,
        "release_dist_hash" character varying(64) NOT NULL,
        "approved_by" character varying(120) NOT NULL,
        "approved_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "activated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
        "ended_at" TIMESTAMP WITH TIME ZONE,
        "ended_by" character varying(160),
        "end_reason" character varying(300),
        CONSTRAINT "PK_recruitment_production_authorizations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_prod_auth_go" UNIQUE ("go_code_fp"),
        CONSTRAINT "CHK_prod_auth_fp" CHECK ("go_code_fp" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_prod_auth_status" CHECK ("status" IN ('ACTIVE', 'REVOKED', 'SUPERSEDED')),
        CONSTRAINT "CHK_prod_auth_ended" CHECK (("status" = 'ACTIVE') = ("ended_at" IS NULL)),
        CONSTRAINT "CHK_prod_auth_limits" CHECK (
          "max_requests_per_recipient_day" BETWEEN 1 AND 1000
          AND "max_requests_per_day" BETWEEN 1 AND 1000000
          AND "max_requests_per_recipient_day" <= "max_requests_per_day"
          AND "daily_cost_budget_vnd" >= 0
          AND "monthly_cost_budget_vnd" >= "daily_cost_budget_vnd"
          AND "interaction_window_hours" BETWEEN 1 AND 168
          AND "free_window_hours" BETWEEN 1 AND "interaction_window_hours"
        ),
        CONSTRAINT "CHK_prod_auth_window" CHECK ("activated_at" >= "approved_at")
      )
    `);
    // Mỗi OA tối đa một uỷ quyền ACTIVE.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_prod_auth_one_active" ON "recruitment_production_authorizations" ("channel_account_id") WHERE "status" = 'ACTIVE'`,
    );
    // Một chiều cho mọi role: chỉ ACTIVE → REVOKED/SUPERSEDED; nội dung bất biến; không xoá.
    await queryRunner.query(`
      CREATE FUNCTION "recruitment_production_authorization_guard"() RETURNS trigger
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
        IF OLD."status" <> 'ACTIVE' THEN
          RAISE EXCEPTION 'uỷ quyền production % đã %, không đổi được', OLD."id", OLD."status";
        END IF;
        IF NEW."status" NOT IN ('REVOKED', 'SUPERSEDED') THEN
          RAISE EXCEPTION 'uỷ quyền production %: chỉ được kết thúc (REVOKED/SUPERSEDED)', OLD."id";
        END IF;
        IF (NEW."id", NEW."go_code_fp", NEW."channel_account_id", NEW."max_requests_per_recipient_day",
            NEW."max_requests_per_day", NEW."daily_cost_budget_vnd", NEW."monthly_cost_budget_vnd",
            NEW."interaction_window_hours", NEW."free_window_hours", NEW."release_dist_hash",
            NEW."approved_by", NEW."approved_at", NEW."activated_at")
           IS DISTINCT FROM
           (OLD."id", OLD."go_code_fp", OLD."channel_account_id", OLD."max_requests_per_recipient_day",
            OLD."max_requests_per_day", OLD."daily_cost_budget_vnd", OLD."monthly_cost_budget_vnd",
            OLD."interaction_window_hours", OLD."free_window_hours", OLD."release_dist_hash",
            OLD."approved_by", OLD."approved_at", OLD."activated_at")
           OR NEW."ended_at" IS NULL OR NEW."ended_by" IS NULL OR NEW."end_reason" IS NULL THEN
          RAISE EXCEPTION 'uỷ quyền production %: nội dung bất biến, kết thúc phải ghi người + lý do', OLD."id";
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_production_authorization_guard"
        BEFORE INSERT OR UPDATE OR DELETE ON "recruitment_production_authorizations"
        FOR EACH ROW EXECUTE FUNCTION "recruitment_production_authorization_guard"()
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "recruitment_production_authorizations" IS
        'G8 GO PROD: uỷ quyền production của SYSTEM OWNER (single-use GO, hạn mức trần). App chỉ đọc; Owner tạo/kết thúc qua g8-owner-go.py.'
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_app') THEN
          REVOKE ALL ON TABLE "recruitment_production_authorizations" FROM sales_app;
          GRANT SELECT ON TABLE "recruitment_production_authorizations" TO sales_app;
          REVOKE ALL ON SEQUENCE "recruitment_production_authorizations_id_seq" FROM sales_app;
        END IF;
      END $$
    `);
    await queryRunner.query(
      `ALTER TYPE "recruitment_hr_alerts_type_enum" ADD VALUE IF NOT EXISTS 'OUTBOUND_PROVIDER_BLOCKED'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const used = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "recruitment_production_authorizations"`,
    )) as Array<{ n: number }>;
    if (Number(used[0]?.n ?? 0) > 0) {
      throw new Error('đã có uỷ quyền production — không được xoá bằng chứng');
    }
    await queryRunner.query(
      `DROP TABLE "recruitment_production_authorizations"`,
    );
    await queryRunner.query(
      `DROP FUNCTION "recruitment_production_authorization_guard"()`,
    );
    // Giá trị enum OUTBOUND_PROVIDER_BLOCKED giữ lại: PostgreSQL không gỡ được giá trị enum.
  }
}
