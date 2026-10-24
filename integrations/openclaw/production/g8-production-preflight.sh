#!/bin/bash
# Read-only production go-live preflight. Does not restart, migrate, change flags,
# call Zalo, consume a GO code or print secrets/recipient identifiers.
# activate-g8.sh prod chạy script này trước khi tạo uỷ quyền GO PROD.
set -Eeuo pipefail

APP=sales-management
CONF=${CONF:-/opt/kido-recruiter-prod/3010-production.env}
G8_CONF=${G8_CONF:-/opt/kido-recruiter-prod/3010-g8.env}
OA_ENV=${OA_ENV:-/root/recruitment-oa.env}
DB=${DB:-sales_db}

die() { echo "BLOCKED: $*" >&2; exit 1; }
ok() { echo "  OK: $*"; }
value() { sed -n "s/^$1=//p" "$2" | tail -1 | tr -d '\r'; }
v() { value "$1" "$CONF"; }
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
q() { runuser -u postgres -- psql -XAt -v ON_ERROR_STOP=1 -d "$DB" -c "SET default_transaction_read_only=on" -c "$1" | tail -n +2; }

[ "$(id -u)" = 0 ] || die "cần root"
[ -f "$CONF" ] || die "thiếu $CONF"
[ "$(stat -c '%a %U' "$CONF")" = "600 root" ] || die "$CONF phải 600 root"
[ "$(v RECRUITMENT_PRODUCTION_MODE)" = true ] || die "PRODUCTION_MODE phải true"
[ "$(v RECRUITMENT_PILOT_MODE)" = false ] || die "PILOT_MODE phải false"
[ "$(v RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED)" = false ] || die "single-dispatch grant phải false trong production"
# OUTBOUND env = true: sender chạy nhưng KHÔNG gửi khi chưa có uỷ quyền GO PROD và khi Gửi Zalo còn dừng khẩn.
[ "$(v RECRUITMENT_ZALO_OUTBOUND_ENABLED)" = true ] || die "OUTBOUND_ENABLED phải true (dừng bằng runtime, không bằng env)"
[ "$(v RECRUITMENT_AI_ENABLED)" = true ] || die "AI_ENABLED phải true"
[ "$(v RECRUITMENT_WORKER_ENABLED)" = true ] || die "WORKER_ENABLED phải true"

for key in \
  RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS \
  RECRUITMENT_ZALO_FREE_WINDOW_HOURS \
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW \
  RECRUITMENT_ZALO_RECIPIENT_WINDOW_HOURS \
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY \
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY \
  RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND \
  RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND \
  RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND \
  RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR \
  RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY \
  RECRUITMENT_AI_MAX_TURNS_PER_DAY; do
  is_uint "$(v "$key")" || die "$key phải là số nguyên tường minh"
done
[ "$(v RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND)" -gt 0 ] \
  || die "đơn giá ước lượng phải > 0 (budget 0 dùng để chặn tin tính phí)"
[ "$(v RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS)" -ge 1 ] && [ "$(v RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS)" -le 168 ] \
  || die "interaction window phải 1–168 giờ"
[ "$(v RECRUITMENT_ZALO_FREE_WINDOW_HOURS)" -ge 1 ] && [ "$(v RECRUITMENT_ZALO_FREE_WINDOW_HOURS)" -le "$(v RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS)" ] \
  || die "free window phải 1..interaction window"
[ "$(v RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY)" -ge 1 ] \
  && [ "$(v RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY)" -le "$(v RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY)" ] \
  || die "quota recipient phải 1..quota toàn hệ thống"
[ "$(v RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW)" -ge 1 ] \
  && [ "$(v RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW)" -le "$(v RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY)" ] \
  || die "quota recipient/cửa sổ phải 1..quota recipient/ngày"
[ "$(v RECRUITMENT_ZALO_RECIPIENT_WINDOW_HOURS)" -ge 1 ] \
  && [ "$(v RECRUITMENT_ZALO_RECIPIENT_WINDOW_HOURS)" -le 24 ] \
  || die "cửa sổ quota recipient phải 1–24 giờ"
[ "$(v RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR)" -ge 1 ] \
  && [ "$(v RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR)" -le "$(v RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY)" ] \
  && [ "$(v RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY)" -le "$(v RECRUITMENT_AI_MAX_TURNS_PER_DAY)" ] \
  || die "trần AI phải thoả max/người/giờ <= max/người/ngày <= max hệ thống/ngày"
[ "$(v RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND)" -le "$(v RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND)" ] \
  || die "budget ngày không được lớn hơn budget tháng"
TTL=$(v RECRUITMENT_HR_MESSAGE_TTL_MINUTES)
[ -z "$TTL" ] || { is_uint "$TTL" && [ "$TTL" -ge 5 ] && [ "$TTL" -le 1440 ]; } || die "RECRUITMENT_HR_MESSAGE_TTL_MINUTES phải 5–1440"
BLOCK=$(v RECRUITMENT_ZALO_OA_BLOCKING_ERRORS)
[ -z "$BLOCK" ] || [[ ",$BLOCK," == *",-224,"* ]] || die "RECRUITMENT_ZALO_OA_BLOCKING_ERRORS phải gồm -224"
ok "file cấu hình production hợp lệ ở mức tĩnh (không in giá trị/secret)"

OA=$(value RECRUITMENT_ZALO_OA_ID "$OA_ENV")
[[ "$OA" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "không đọc được RECRUITMENT_ZALO_OA_ID trong $OA_ENV"
[ -n "$(value RECRUITMENT_PILOT_SENDER_FINGERPRINTS "$G8_CONF")" ] || die "$G8_CONF thiếu fingerprint pilot (cần để quay lại pilot)"

[ "$(q "select current_database()")" = "$DB" ] || die "sai database"
[ "$(q "select count(*) from migrations where timestamp=1793200000000 and name='AddRecruitmentOutboundAttemptLedger1793200000000'")" = 1 ] \
  && [ "$(q "select to_regclass('public.recruitment_outbound_attempts') is not null")" = t ] \
  || die "chưa có migration outbound ledger 1793200000000"
[ "$(q "select count(*) from migrations where timestamp=1793300000000 and name='AddRecruitmentProductionAuthorizations1793300000000'")" = 1 ] \
  && [ "$(q "select to_regclass('public.recruitment_production_authorizations') is not null")" = t ] \
  || die "chưa có migration GO PROD 1793300000000"
[ "$(q "select count(*) from migrations where timestamp=1794000000000 and name='AddRecruitmentRecipientRollingQuota1794000000000'")" = 1 ] \
  && [ "$(q "select count(*) from information_schema.columns where table_schema='public' and table_name='recruitment_production_authorizations' and column_name in ('max_requests_per_recipient_window','recipient_window_hours')")" = 2 ] \
  || die "chưa có migration quota trượt 1794000000000"
[ "$(q "select has_table_privilege('sales_app','public.recruitment_outbound_attempts','INSERT') and not has_table_privilege('sales_app','public.recruitment_outbound_attempts','DELETE') and not has_table_privilege('sales_app','public.recruitment_production_authorizations','INSERT')")" = t ] \
  || die "quyền sales_app trên bảng ledger / uỷ quyền sai"
[ "$(q "select count(*) from recruitment_jobs where status='ACTIVE' and published_at is null")" = 0 ] \
  || die "có job ACTIVE nhưng chưa published_at"
[ "$(q "select count(*) from recruitment_channel_outbox where status in ('PENDING','SENDING','RETRY','UNKNOWN')")" = 0 ] \
  || die "còn outbox có thể gửi/chưa đối soát — HR huỷ/đối soát từng dòng trước GO"
[ "$(q "select outbound_halted from recruitment_runtime_controls where id=1")" = t ] \
  || die "runtime OUTBOUND chưa dừng khẩn"
[ "$(q "select failsafe_halted from recruitment_runtime_controls where id=1")" = f ] \
  || die "failsafe đang bật"
[ "$(q "select count(*) from recruitment_zalo_credentials where oa_id = '$OA'")" = 1 ] \
  && [ "$(q "select count(*) from recruitment_zalo_credentials where oa_id <> '$OA'")" = 0 ] \
  || die "credential OA trong DB không đúng một dòng của đúng OA tuyển dụng"
ok "DB đúng, migration + quyền đủ, job công bố hợp lệ, outbox sạch, outbound đang dừng, credential đúng OA"
echo "  Vị trí ACTIVE: $(q "select count(*) from recruitment_jobs where status='ACTIVE'") · uỷ quyền production ACTIVE: $(q "select coalesce(string_agg(id::text, ','), 'không') from recruitment_production_authorizations where status='ACTIVE'")"

[ "$(docker inspect -f '{{.State.Health.Status}}' kido-recruiter-prod-openclaw-gateway-1 2>/dev/null)" = healthy ] \
  || die "OpenClaw gateway không healthy"
[ "$(docker port kido-recruiter-prod-openclaw-gateway-1 2>/dev/null | tr -d '\n')" = "18789/tcp -> 127.0.0.1:18790" ] \
  || die "gateway không chỉ bind localhost"
grep -q recruitment_production_authorizations /var/www/sales-management/dist/recruitment/channels/recruitment-channel-outbox.queue.js \
  || die "3010 chưa chạy release production (GO PROD)"
grep -q HR_MESSAGE_EXPIRED /var/www/sales-management/dist/recruitment/channels/recruitment-outbox-approval-expiry.service.js \
  || die "3010 chưa chạy release có TTL tin HR"
ok "gateway localhost/healthy, release production hiện diện"

echo "PASS READ-ONLY. Vẫn chưa gửi được cho tới khi: (1) Owner cấp GO PROD + activate-g8.sh prod tạo uỷ quyền;"
echo "  (2) HR mở lại Gửi Zalo (khoá thứ hai). Kill switch: HR console dừng OUTBOUND;"
echo "  thu hồi production: g8-owner-go.py revoke-prod <id>; lớp cứng: activate-g8.sh off --go \"incident\"."
