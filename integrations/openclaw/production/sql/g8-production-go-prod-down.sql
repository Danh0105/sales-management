-- Gỡ GO PROD — CHỈ khi chưa từng có uỷ quyền production nào (bảng rỗng). Sau lần kích hoạt
-- đầu tiên phải giữ bảng làm bằng chứng; quay lại pilot dùng `activate-g8.sh pilot`.
-- Giá trị enum OUTBOUND_PROVIDER_BLOCKED được giữ lại (PostgreSQL không gỡ được giá trị enum;
-- vô hại với code cũ). Từ chối nếu đã có cảnh báo loại này.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.recruitment_production_authorizations') IS NULL THEN
    RAISE EXCEPTION 'migration GO PROD chưa áp dụng — không có gì để gỡ';
  END IF;
  IF EXISTS (SELECT 1 FROM "recruitment_production_authorizations") THEN
    RAISE EXCEPTION 'đã có uỷ quyền production — không được xoá bằng chứng';
  END IF;
END $$;

SET LOCAL ROLE sales_owner;
DROP TABLE "recruitment_production_authorizations";
DROP FUNCTION "recruitment_production_authorization_guard"();
RESET ROLE;
DELETE FROM "migrations"
WHERE "timestamp" = 1793300000000
  AND "name" = 'AddRecruitmentProductionAuthorizations1793300000000';

COMMIT;
