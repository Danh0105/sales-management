#!/bin/bash
# Dọn outbox CÒN GỬI ĐƯỢC trên DB STAGING trước khi bật sender Zalo — để không bao
# giờ "lỡ" gửi tin test của các lần chạy trước (P3-4 acceptance, hội thoại giả lập).
#
#   integrations/openclaw/scripts/outbox-fixture-cleanup.sh "<lý do>" [id_tối_đa]
#
# - chỉ chạy trên sales_db_staging (container staging-db), không bao giờ prod
# - backup CSV đủ cột + manifest (số dòng, dải id, sha256, lý do) vào backups/
# - xoá trong MỘT transaction, đối chiếu đúng số dòng đã backup; lệch → rollback
# - [id_tối_đa]: chỉ dọn dòng có id ≤ giá trị này (giữ dòng tạo sau mốc)
set -euo pipefail
cd "$(dirname "$0")/.."
REASON="${1:?Dùng: outbox-fixture-cleanup.sh \"<lý do>\" [id_tối_đa]}"
MAX_ID="${2:-2147483647}"
[[ "$MAX_ID" =~ ^[0-9]+$ ]] || { echo "id_tối_đa phải là số" >&2; exit 2; }
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
BACKUPS="${KIDO_RECRUITER_DIR:-/opt/kido-recruiter}/backups"
psql_staging() { "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -v ON_ERROR_STOP=1 -At "$@"; }

[ "$(psql_staging -c "select current_database()")" = sales_db_staging ] || { echo "không phải DB staging — dừng" >&2; exit 3; }
WHERE="status::text in ('PENDING', 'SENDING', 'RETRY', 'UNKNOWN') and id <= $MAX_ID"
COUNT=$(psql_staging -c "select count(*) from recruitment_channel_outbox where $WHERE")
if [ "$COUNT" = 0 ]; then echo "outbox: không có dòng nào còn gửi được — không dọn"; exit 0; fi

TS=$(date +%Y%m%d-%H%M%S)
CSV="$BACKUPS/outbox-fixtures-$TS.csv"
MANIFEST="$BACKUPS/outbox-fixtures-$TS.manifest"
(umask 077
 psql_staging -c "\\copy (select * from recruitment_channel_outbox where $WHERE order by id) to stdout with csv header" > "$CSV"
 {
   echo "time=$(date -Is)"
   echo "database=sales_db_staging"
   echo "reason=$REASON"
   echo "rows=$COUNT"
   echo "status=$(psql_staging -c "select string_agg(status || ':' || n, ',') from (select status::text, count(*) n from recruitment_channel_outbox where $WHERE group by 1) x")"
   echo "accounts=$(psql_staging -c "select string_agg(distinct channel_account_id, ',') from recruitment_channel_outbox where $WHERE")"
   echo "id_range=$(psql_staging -c "select min(id) || '-' || max(id) from recruitment_channel_outbox where $WHERE")"
   echo "ids=$(psql_staging -c "select string_agg(id::text, ',' order by id) from recruitment_channel_outbox where $WHERE")"
   echo "csv=$CSV"
   echo "csv_sha256=$(sha256sum "$CSV" | cut -d' ' -f1)"
 } > "$MANIFEST")
[ "$(($(wc -l < "$CSV") - 1))" -ge "$COUNT" ] || { echo "backup thiếu dòng — dừng, chưa xoá gì" >&2; exit 4; }

DELETED=$(psql_staging <<SQL | grep -E "^[0-9]+$" | tail -1
BEGIN;
CREATE TEMP TABLE doomed AS SELECT id FROM recruitment_channel_outbox WHERE $WHERE;
DO \$\$ BEGIN
  IF (SELECT count(*) FROM doomed) <> $COUNT THEN
    RAISE EXCEPTION 'số dòng thay đổi giữa backup và xoá — rollback';
  END IF;
END \$\$;
DELETE FROM recruitment_channel_outbox WHERE id IN (SELECT id FROM doomed);
SELECT count(*) FROM doomed;
COMMIT;
SQL
)
echo "deleted=$DELETED" >> "$MANIFEST"
echo "outbox: đã backup + xoá $DELETED dòng còn gửi được → $MANIFEST"
