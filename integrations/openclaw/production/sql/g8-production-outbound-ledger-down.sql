-- Chỉ dùng trước go-live nếu ledger hoàn toàn rỗng. Sau request đầu tiên phải giữ
-- bảng làm bằng chứng đối soát; rollback ứng dụng không cần rollback schema.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.recruitment_outbound_attempts') IS NULL THEN
    RAISE EXCEPTION 'migration chưa áp dụng — không có gì để gỡ';
  END IF;
  IF EXISTS (SELECT 1 FROM "recruitment_outbound_attempts") THEN
    RAISE EXCEPTION 'ledger đã có request — không được xoá bằng chứng đối soát';
  END IF;
  IF to_regclass('public.recruitment_production_authorizations') IS NOT NULL THEN
    RAISE EXCEPTION 'còn migration GO PROD (1793300000000) — gỡ migration đó trước';
  END IF;
END $$;

SET LOCAL ROLE sales_owner;
DROP TABLE "recruitment_outbound_attempts";
DROP FUNCTION "recruitment_outbound_attempt_guard"();
RESET ROLE;
DELETE FROM "migrations"
WHERE "timestamp" = 1793200000000
  AND "name" = 'AddRecruitmentOutboundAttemptLedger1793200000000';

COMMIT;
