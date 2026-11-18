-- Rollback migration C2S. Tự chặn nếu đã có grant mang mã C2S (ràng buộc cũ ^G8-C2- sẽ không nhận chúng).
-- Không đụng grant nào; bảng grant + trigger một chiều giữ nguyên.
--   runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db -f g8-dispatch-guard-c2s-down.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_dispatch_grant_c2s_only') THEN
    RAISE EXCEPTION 'migration C2S chưa áp dụng — không có gì để gỡ';
  END IF;
  IF EXISTS (SELECT 1 FROM "recruitment_outbound_dispatch_grants" WHERE go_code ~ '^G8-C2S-') THEN
    RAISE EXCEPTION 'đã có grant tạo từ GO C2S — giữ migration (bằng chứng + ràng buộc cũ không nhận mã C2S), dừng';
  END IF;
END $$;
SET LOCAL ROLE sales_owner;
DROP TRIGGER "TRG_dispatch_grant_c2s_only" ON "recruitment_outbound_dispatch_grants";
DROP FUNCTION "recruitment_dispatch_grant_c2s_only"();
ALTER TABLE "recruitment_outbound_dispatch_grants" DROP CONSTRAINT "UQ_dispatch_grant_go";
ALTER TABLE "recruitment_outbound_dispatch_grants" DROP CONSTRAINT "CHK_dispatch_grant_go";
ALTER TABLE "recruitment_outbound_dispatch_grants" ADD CONSTRAINT "CHK_dispatch_grant_go"
  CHECK ("go_code" ~ '^G8-C2-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$');
RESET ROLE;
DELETE FROM "migrations" WHERE "name" = 'RequireC2sGoForDispatchGrants1793100000000';
COMMIT;
