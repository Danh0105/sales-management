#!/bin/bash
# Read-only production go-live preflight. Does not restart, migrate, change flags,
# call Zalo, consume a GO code or print secrets/recipient identifiers.
set -Eeuo pipefail

APP=sales-management
CONF=${CONF:-/opt/kido-recruiter-prod/3010-production.env}
DB=${DB:-sales_db}
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "BLOCKED: $*" >&2; exit 1; }
ok() { echo "  OK: $*"; }
value() { sed -n "s/^$1=//p" "$CONF" | tail -1 | tr -d '\r'; }
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
q() { runuser -u postgres -- psql -XAt -v ON_ERROR_STOP=1 -d "$DB" -c "SET default_transaction_read_only=on" -c "$1" | tail -n +2; }
flag() { pm2 jlist | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['name']=='$APP'][0];e=p['pm2_env'];print(e.get('env',{}).get('$1',e.get('$1','')) or '-')"; }

[ "$(id -u)" = 0 ] || die "cần root"
[ -f "$CONF" ] || die "thiếu $CONF"
[ "$(stat -c '%a %U' "$CONF")" = "600 root" ] || die "$CONF phải 600 root"
[ "$(value RECRUITMENT_PRODUCTION_MODE)" = true ] || die "PRODUCTION_MODE phải true"
[ "$(value RECRUITMENT_PILOT_MODE)" = false ] || die "PILOT_MODE phải false"
[ "$(value RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED)" = false ] || die "single-dispatch grant phải false"
[ "$(value RECRUITMENT_ZALO_OUTBOUND_ENABLED)" = false ] || die "file cutover phải giữ OUTBOUND=false đến GO cuối"
[ "$(value RECRUITMENT_AI_ENABLED)" = true ] || die "AI_ENABLED phải true trong cấu hình cutover"
[ "$(value RECRUITMENT_WORKER_ENABLED)" = true ] || die "WORKER_ENABLED phải true trong cấu hình cutover"

for key in \
  RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS \
  RECRUITMENT_ZALO_FREE_WINDOW_HOURS \
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY \
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY \
  RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND \
  RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND \
  RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND; do
  v=$(value "$key"); is_uint "$v" || die "$key phải là số nguyên tường minh"
done
[ "$(value RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND)" -gt 0 ] \
  || die "đơn giá ước lượng phải > 0 (budget 0 dùng để chặn tin tính phí)"
[ "$(value RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS)" -le 168 ] \
  || die "interaction window không được quá 168 giờ"
[ "$(value RECRUITMENT_ZALO_FREE_WINDOW_HOURS)" -le "$(value RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS)" ] \
  || die "free window không được lớn hơn interaction window"
[ "$(value RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY)" -le "$(value RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY)" ] \
  || die "quota recipient không được lớn hơn quota toàn hệ thống"
[ "$(value RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND)" -le "$(value RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND)" ] \
  || die "budget ngày không được lớn hơn budget tháng"
ok "file cấu hình production hợp lệ ở mức tĩnh (không in giá trị/secret)"

[ "$(q "select current_database()")" = "$DB" ] || die "sai database"
[ "$(q "select to_regclass('public.recruitment_outbound_attempts') is not null")" = t ] \
  || die "chưa có migration outbound ledger"
[ "$(q "select count(*) from migrations where timestamp=1793200000000 and name='AddRecruitmentOutboundAttemptLedger1793200000000'")" = 1 ] \
  || die "thiếu migration record 1793200000000"
[ "$(q "select count(*) from recruitment_jobs where status='ACTIVE' and published_at is null")" = 0 ] \
  || die "có job ACTIVE nhưng chưa published_at"
[ "$(q "select count(*) from recruitment_channel_outbox where status in ('PENDING','SENDING','RETRY','UNKNOWN')")" = 0 ] \
  || die "còn outbox có thể gửi/chưa đối soát — HR phải xử lý từng dòng trước GO"
[ "$(q "select outbound_halted from recruitment_runtime_controls where id=1")" = t ] \
  || die "runtime OUTBOUND chưa dừng khẩn"
[ "$(q "select count(*) from recruitment_zalo_credentials")" -ge 1 ] \
  || die "thiếu credential OA đã mã hoá"
ok "DB đúng, migration đủ, job công bố hợp lệ, outbox sạch, outbound đang dừng"

[ "$(docker inspect -f '{{.State.Health.Status}}' kido-recruiter-prod-openclaw-gateway-1 2>/dev/null)" = healthy ] \
  || die "OpenClaw gateway không healthy"
[ "$(docker port kido-recruiter-prod-openclaw-gateway-1 2>/dev/null | tr -d '\n')" = "18789/tcp -> 127.0.0.1:18790" ] \
  || die "gateway không chỉ bind localhost"
grep -q recruitment_outbound_attempts /var/www/sales-management/dist/recruitment/channels/recruitment-channel-outbox.queue.js \
  || die "3010 chưa chạy release production ledger"
[ "$(flag RECRUITMENT_ZALO_OUTBOUND_ENABLED)" != true ] || die "PM2 OUTBOUND đang bật"
ok "gateway localhost/healthy, release mới hiện diện, PM2 outbound tắt"

echo "PASS READ-ONLY. Vẫn BLOCKED gửi thật cho tới khi SYSTEM OWNER xác nhận riêng:"
echo "  (1) OA Tier Package đã kích hoạt; (2) hạn mức/chi phí; (3) OpenAI hard limit;"
echo "  (4) HR trực ca; (5) backup + rollback; (6) GO bật outbound."
echo "Kill switch: HR console dừng OUTBOUND; lớp cứng: activate-g8.sh off --go \"incident\"."
