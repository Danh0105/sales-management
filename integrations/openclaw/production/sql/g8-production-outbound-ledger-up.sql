-- G8 production — durable Send API attempt ledger + quota/cost accounting.
-- Schema only: does not modify candidates, conversations, messages or outbox rows.
-- Equivalent to TypeORM migration AddRecruitmentOutboundAttemptLedger1793200000000.
-- Run (production, only after SYSTEM OWNER approval):
--   runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db < g8-production-outbound-ledger-up.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.recruitment_outbound_attempts') IS NOT NULL THEN
    RAISE EXCEPTION 'recruitment_outbound_attempts đã tồn tại — dừng';
  END IF;
  IF to_regclass('public.recruitment_channel_outbox') IS NULL THEN
    RAISE EXCEPTION 'thiếu recruitment_channel_outbox — sai database/thứ tự migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_app') THEN
    RAISE EXCEPTION 'thiếu role sales_owner / sales_app — dừng';
  END IF;
END $$;

-- Bảng thuộc sales_owner như các bảng recruitment_* khác (tạo bằng postgres thì
-- sales_app không có quyền nào — 3010 sẽ lỗi permission denied ở mọi dispatch).
SET LOCAL ROLE sales_owner;

CREATE TABLE "recruitment_outbound_attempts" (
  "id" BIGSERIAL NOT NULL,
  "outbox_id" integer NOT NULL,
  "request_no" smallint NOT NULL,
  "lease_owner" character varying(200) NOT NULL,
  "source_type" character varying(24) NOT NULL,
  "channel_account_id" character varying(64) NOT NULL,
  "recipient_fingerprint" character(16) NOT NULL,
  "interaction_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "estimated_cost_vnd" integer NOT NULL DEFAULT 0,
  "outcome" character varying(24) NOT NULL DEFAULT 'DISPATCHING',
  "result_code" character varying(64),
  "provider_message_id" character varying(128),
  "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
  "completed_at" TIMESTAMP WITH TIME ZONE,
  CONSTRAINT "PK_recruitment_outbound_attempts" PRIMARY KEY ("id"),
  CONSTRAINT "FK_outbound_attempt_outbox" FOREIGN KEY ("outbox_id")
    REFERENCES "recruitment_channel_outbox"("id") ON DELETE RESTRICT,
  CONSTRAINT "UQ_outbound_attempt_request" UNIQUE ("outbox_id", "request_no"),
  CONSTRAINT "CHK_outbound_attempt_request_no" CHECK ("request_no" > 0),
  CONSTRAINT "CHK_outbound_attempt_source" CHECK ("source_type" IN ('AI_REPLY', 'HR_MESSAGE')),
  CONSTRAINT "CHK_outbound_attempt_fp" CHECK ("recipient_fingerprint" ~ '^[0-9a-f]{16}$'),
  CONSTRAINT "CHK_outbound_attempt_cost" CHECK ("estimated_cost_vnd" >= 0),
  CONSTRAINT "CHK_outbound_attempt_outcome" CHECK (
    "outcome" IN ('DISPATCHING', 'SENT', 'RETRY', 'UNKNOWN', 'REJECTED', 'DEAD_LETTER')
  ),
  CONSTRAINT "CHK_outbound_attempt_complete" CHECK (
    ("outcome" = 'DISPATCHING') = ("completed_at" IS NULL)
  )
);
CREATE INDEX "IDX_outbound_attempts_day"
  ON "recruitment_outbound_attempts" ("started_at");
CREATE INDEX "IDX_outbound_attempts_recipient_day"
  ON "recruitment_outbound_attempts" ("channel_account_id", "recipient_fingerprint", "started_at");
CREATE UNIQUE INDEX "UQ_outbound_attempt_active_lease"
  ON "recruitment_outbound_attempts" ("outbox_id", "lease_owner")
  WHERE "outcome" = 'DISPATCHING';

-- Ledger là nguồn quota/chi phí: một chiều cho mọi role kể cả superuser.
-- INSERT: luôn bắt đầu DISPATCHING, thời điểm do DB đặt (không lùi ngày để né quota).
-- UPDATE: chỉ dòng DISPATCHING được ghi kết quả một lần; metadata bất biến.
-- DELETE: cấm (xoá = "hoàn" quota + mất bằng chứng đối soát).
CREATE FUNCTION "recruitment_outbound_attempt_guard"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'request outbound % là bằng chứng đối soát/quota — không xoá được', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."outcome" := 'DISPATCHING';
    NEW."result_code" := NULL;
    NEW."provider_message_id" := NULL;
    NEW."completed_at" := NULL;
    NEW."started_at" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD."outcome" <> 'DISPATCHING' THEN
    RAISE EXCEPTION 'request outbound % đã kết thúc (%) — bất biến', OLD."id", OLD."outcome";
  END IF;
  IF (NEW."id", NEW."outbox_id", NEW."request_no", NEW."lease_owner", NEW."source_type",
      NEW."channel_account_id", NEW."recipient_fingerprint", NEW."interaction_at",
      NEW."estimated_cost_vnd", NEW."started_at")
     IS DISTINCT FROM
     (OLD."id", OLD."outbox_id", OLD."request_no", OLD."lease_owner", OLD."source_type",
      OLD."channel_account_id", OLD."recipient_fingerprint", OLD."interaction_at",
      OLD."estimated_cost_vnd", OLD."started_at") THEN
    RAISE EXCEPTION 'request outbound %: chỉ được ghi kết quả, metadata bất biến', OLD."id";
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "TRG_outbound_attempt_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "recruitment_outbound_attempts"
  FOR EACH ROW EXECUTE FUNCTION "recruitment_outbound_attempt_guard"();
COMMENT ON TABLE "recruitment_outbound_attempts" IS
  'G8 production: mỗi request Send API Zalo một dòng, ghi trước khi mở mạng. Nguồn quota/chi phí/đối soát. Không nội dung, token hay user id thô. App chỉ thêm + ghi kết quả một lần; không xoá.';

-- App: đọc, thêm, ghi kết quả. Không xoá, không sửa metadata.
REVOKE ALL ON TABLE "recruitment_outbound_attempts" FROM sales_app;
GRANT SELECT, INSERT ON TABLE "recruitment_outbound_attempts" TO sales_app;
GRANT UPDATE ("outcome", "result_code", "provider_message_id", "completed_at")
  ON TABLE "recruitment_outbound_attempts" TO sales_app;
REVOKE ALL ON SEQUENCE "recruitment_outbound_attempts_id_seq" FROM sales_app;
GRANT USAGE, SELECT ON SEQUENCE "recruitment_outbound_attempts_id_seq" TO sales_app;

RESET ROLE;

DO $$
BEGIN
  IF has_table_privilege('sales_app', 'public.recruitment_outbound_attempts', 'DELETE')
     OR has_table_privilege('sales_app', 'public.recruitment_outbound_attempts', 'TRUNCATE')
     OR has_column_privilege('sales_app', 'public.recruitment_outbound_attempts', 'started_at', 'UPDATE')
     OR has_column_privilege('sales_app', 'public.recruitment_outbound_attempts', 'estimated_cost_vnd', 'UPDATE')
     OR NOT has_table_privilege('sales_app', 'public.recruitment_outbound_attempts', 'SELECT')
     OR NOT has_table_privilege('sales_app', 'public.recruitment_outbound_attempts', 'INSERT')
     OR NOT has_column_privilege('sales_app', 'public.recruitment_outbound_attempts', 'outcome', 'UPDATE')
     OR NOT has_sequence_privilege('sales_app', 'public.recruitment_outbound_attempts_id_seq', 'USAGE')
     OR (SELECT tableowner FROM pg_tables WHERE tablename = 'recruitment_outbound_attempts') <> 'sales_owner'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_outbound_attempt_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'quyền/owner/trigger của recruitment_outbound_attempts sai — rollback';
  END IF;
END $$;

INSERT INTO "migrations" ("timestamp", "name")
VALUES (1793200000000, 'AddRecruitmentOutboundAttemptLedger1793200000000');

DO $$
BEGIN
  IF to_regclass('public.recruitment_outbound_attempts') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM "migrations"
       WHERE "timestamp" = 1793200000000
         AND "name" = 'AddRecruitmentOutboundAttemptLedger1793200000000'
     ) THEN
    RAISE EXCEPTION 'kiểm sau migration không đạt — rollback';
  END IF;
END $$;

COMMIT;
