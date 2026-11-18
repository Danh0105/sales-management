-- Rollback only before any GO PROD records a non-legacy rolling window.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SET LOCAL ROLE sales_owner;
LOCK TABLE "recruitment_production_authorizations" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM recruitment_production_authorizations
    WHERE recipient_window_hours <> 24
       OR max_requests_per_recipient_window <> max_requests_per_recipient_day
  ) THEN
    RAISE EXCEPTION 'đã có GO PROD dùng rolling quota — không được xoá bằng chứng hạn mức';
  END IF;
END $$;
ALTER TABLE "recruitment_production_authorizations" DISABLE TRIGGER "TRG_production_authorization_guard";

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

ALTER TABLE "recruitment_production_authorizations"
  DROP CONSTRAINT "CHK_prod_auth_recipient_window",
  DROP COLUMN "max_requests_per_recipient_window",
  DROP COLUMN "recipient_window_hours";
ALTER TABLE "recruitment_production_authorizations" ENABLE TRIGGER "TRG_production_authorization_guard";
RESET ROLE;
DELETE FROM "migrations"
WHERE "timestamp" = 1794000000000
  AND "name" = 'AddRecruitmentRecipientRollingQuota1794000000000';
COMMIT;
