-- G8 C2S — grant dispatch chỉ được tạo từ GO C2S (tách khỏi GO C2 kích hoạt).
-- CHỈ schema: không tạo/sửa grant, không đổi dữ liệu khác. Grant hiện có (mã G8-C2-…) giữ nguyên.
--   runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db -f g8-dispatch-guard-c2s-up.sql
-- = migration TypeORM RequireC2sGoForDispatchGrants1793100000000.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
  IF to_regclass('public.recruitment_outbound_dispatch_grants') IS NULL THEN
    RAISE EXCEPTION 'chưa có bảng grant (g8-dispatch-guard-up.sql) — dừng';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_dispatch_grant_c2s_only') THEN
    RAISE EXCEPTION 'migration C2S đã áp dụng — dừng';
  END IF;
  IF EXISTS (SELECT go_code FROM "recruitment_outbound_dispatch_grants" GROUP BY go_code HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'có go_code trùng trong grant hiện có — không thể thêm UNIQUE, dừng';
  END IF;
END $$;

SET LOCAL ROLE sales_owner;

-- Mã GO: chấp nhận mã cũ (G8-C2-, cho grant đã có) và mã C2S; grant MỚI bị trigger buộc dùng C2S.
ALTER TABLE "recruitment_outbound_dispatch_grants" DROP CONSTRAINT "CHK_dispatch_grant_go";
ALTER TABLE "recruitment_outbound_dispatch_grants" ADD CONSTRAINT "CHK_dispatch_grant_go"
  CHECK ("go_code" ~ '^G8-C2S?-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$');
-- Một GO → tối đa một grant (hai tiến trình dùng cùng GO: chỉ một INSERT thành công).
ALTER TABLE "recruitment_outbound_dispatch_grants" ADD CONSTRAINT "UQ_dispatch_grant_go" UNIQUE ("go_code");

CREATE FUNCTION "recruitment_dispatch_grant_c2s_only"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."go_code" !~ '^G8-C2S-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$' THEN
    RAISE EXCEPTION 'grant dispatch mới chỉ được tạo từ GO C2S (G8-C2S-…), không dùng GO C2 kích hoạt';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "TRG_dispatch_grant_c2s_only"
  BEFORE INSERT ON "recruitment_outbound_dispatch_grants"
  FOR EACH ROW EXECUTE FUNCTION "recruitment_dispatch_grant_c2s_only"();

RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_dispatch_grant_c2s_only' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_dispatch_grant_go')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_dispatch_grant_guard' AND NOT tgisinternal)
     OR has_table_privilege('sales_app', 'public.recruitment_outbound_dispatch_grants', 'INSERT') THEN
    RAISE EXCEPTION 'kiểm sau migration C2S không đạt — rollback';
  END IF;
END $$;

INSERT INTO "migrations" ("timestamp", "name")
VALUES (1793100000000, 'RequireC2sGoForDispatchGrants1793100000000');
COMMIT;
