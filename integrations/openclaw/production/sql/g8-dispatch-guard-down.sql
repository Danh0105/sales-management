-- Rollback schema của single dispatch guard. KHÔNG cần khi chỉ rollback ứng dụng (mã cũ
-- bỏ qua bảng này). Tự chặn nếu đã có grant từng được tiêu (giữ làm bằng chứng audit).
--   runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db -f g8-dispatch-guard-down.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF to_regclass('public.recruitment_outbound_dispatch_grants') IS NULL THEN
    RAISE EXCEPTION 'bảng grant không tồn tại — không có gì để gỡ';
  END IF;
  IF EXISTS (SELECT 1 FROM "recruitment_outbound_dispatch_grants" WHERE "dispatches_used" > 0) THEN
    RAISE EXCEPTION 'đã có grant được tiêu — giữ bảng làm bằng chứng, dừng';
  END IF;
END $$;
DROP TABLE "recruitment_outbound_dispatch_grants";
DROP FUNCTION "recruitment_dispatch_grant_guard"();
DELETE FROM "migrations" WHERE "name" = 'AddRecruitmentOutboundDispatchGrants1793000000000';
COMMIT;
