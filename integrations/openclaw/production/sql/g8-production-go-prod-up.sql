-- G8 production — GO PROD: uỷ quyền production của SYSTEM OWNER, ràng buộc trong DB.
-- Production mode của 3010 chỉ gửi khi có ĐÚNG một uỷ quyền ACTIVE cho OA; hạn mức Owner
-- duyệt nằm ở đây (env chỉ được hạ thấp hơn). App (sales_app) chỉ ĐỌC; chỉ Owner tạo/kết thúc
-- qua g8-owner-go.py (postgres). Đổi biến môi trường một mình không bật được production.
-- Thêm loại cảnh báo OUTBOUND_PROVIDER_BLOCKED (Zalo -224: OA thiếu quyền gói dịch vụ).
-- Schema only — không đổi dữ liệu nghiệp vụ. = migration AddRecruitmentProductionAuthorizations1793300000000.
-- Chạy SAU g8-production-outbound-ledger-up.sql:
--   runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db < g8-production-go-prod-up.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.recruitment_production_authorizations') IS NOT NULL THEN
    RAISE EXCEPTION 'recruitment_production_authorizations đã tồn tại — dừng';
  END IF;
  IF to_regclass('public.recruitment_outbound_attempts') IS NULL THEN
    RAISE EXCEPTION 'chưa áp g8-production-outbound-ledger-up.sql (1793200000000) — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_app') THEN
    RAISE EXCEPTION 'thiếu role sales_owner / sales_app — dừng';
  END IF;
END $$;

SET LOCAL ROLE sales_owner;

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
);
-- Mỗi OA tối đa một uỷ quyền ACTIVE.
CREATE UNIQUE INDEX "UQ_prod_auth_one_active"
  ON "recruitment_production_authorizations" ("channel_account_id") WHERE "status" = 'ACTIVE';

-- Một chiều cho mọi role: chỉ ACTIVE → REVOKED/SUPERSEDED (ghi ended_*); hạn mức, mã, người
-- duyệt bất biến; không xoá (bằng chứng ai cho phép gửi thật, khi nào, với hạn mức nào).
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
$fn$;
CREATE TRIGGER "TRG_production_authorization_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "recruitment_production_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "recruitment_production_authorization_guard"();
COMMENT ON TABLE "recruitment_production_authorizations" IS
  'G8 GO PROD: uỷ quyền production của SYSTEM OWNER (single-use GO, hạn mức trần). App chỉ đọc; Owner tạo/kết thúc qua g8-owner-go.py.';

REVOKE ALL ON TABLE "recruitment_production_authorizations" FROM sales_app;
GRANT SELECT ON TABLE "recruitment_production_authorizations" TO sales_app;
REVOKE ALL ON SEQUENCE "recruitment_production_authorizations_id_seq" FROM sales_app;

-- Cảnh báo HR + Owner khi Zalo từ chối vì quyền gói dịch vụ OA (-224) — outbound tự dừng.
ALTER TYPE "recruitment_hr_alerts_type_enum" ADD VALUE IF NOT EXISTS 'OUTBOUND_PROVIDER_BLOCKED';

RESET ROLE;

DO $$
BEGIN
  IF has_table_privilege('sales_app', 'public.recruitment_production_authorizations', 'INSERT')
     OR has_table_privilege('sales_app', 'public.recruitment_production_authorizations', 'UPDATE')
     OR has_table_privilege('sales_app', 'public.recruitment_production_authorizations', 'DELETE')
     OR NOT has_table_privilege('sales_app', 'public.recruitment_production_authorizations', 'SELECT')
     OR (SELECT tableowner FROM pg_tables WHERE tablename = 'recruitment_production_authorizations') <> 'sales_owner'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_production_authorization_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'quyền/owner/trigger của recruitment_production_authorizations sai — rollback';
  END IF;
END $$;

INSERT INTO "migrations" ("timestamp", "name")
VALUES (1793300000000, 'AddRecruitmentProductionAuthorizations1793300000000');

COMMIT;
