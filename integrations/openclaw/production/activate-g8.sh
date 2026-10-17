#!/bin/bash
# Kích hoạt AI Recruiter trên 3010 theo cổng canary G8 — CHỈ khi SYSTEM OWNER đã cấp GO cho đúng cổng bằng
# `g8-owner-go.py approve <cổng>` (mã riêng, 12 giờ, dùng 1 lần). Mỗi cổng chạy riêng, có xác nhận gõ tay.
#
#   activate-g8.sh c0  --go <mã GO C0> [--dry-run]   # nạp cấu hình gateway + pilot + trần + APP_SECRET; AI/WORKER/OUTBOUND = false
#   activate-g8.sh c1  --go <mã GO C1> [--dry-run]   # AI + WORKER = true (tin AI chỉ tạo bản nháp chờ HR duyệt)
#   activate-g8.sh c2  --go <mã GO C2> [--dry-run]   # OUTBOUND = true + single dispatch guard: CHỈ tin có grant của Owner
#                                                    # (g8-owner-go.py grant-dispatch) mới được gửi, đúng 1 lần
#   activate-g8.sh off --go "<lý do>" [--dry-run]    # AI/WORKER/OUTBOUND = false bằng env + restart — KHÔNG cần GO
#
# Dừng khẩn thường ngày dùng giao diện (Vận hành → Dừng khẩn) hoặc API runtime-controls — có hiệu lực
# không cần restart. `off` là lớp tắt cứng khi API không dùng được.
set -Eeuo pipefail
STAGE="${1:-}"; shift || true
GO=""; DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO="${2:-}"; shift 2 ;;
    --dry-run) DRY="--dry-run"; shift ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
HERE=$(cd "$(dirname "$0")" && pwd)
APP=sales-management
CONF=/opt/kido-recruiter-prod/3010-g8.env
WRAP=/opt/kido-recruiter/worktrees/release-g8-p32/integrations/openclaw/scripts/p372b-pm2-env.js
OWNER_GO="python3 -I $HERE/g8-owner-go.py"
LOG=/opt/kido-recruiter/runs/g8-activation-$(date +%Y%m%d-%H%M%S)-$STAGE.log
die() { echo "DỪNG: $*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
envflag() { pm2 jlist | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['name']=='$APP'][0];e=p['pm2_env'];print(e.get('env',{}).get('$1', e.get('$1','')) or '-')"; }
# Chỉ báo có/không — dùng cho biến bí mật, không bao giờ in giá trị.
envhas() { pm2 jlist | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['name']=='$APP'][0];e=p['pm2_env'];print('yes' if (e.get('env',{}).get('$1') or e.get('$1')) else 'no')"; }
oa_credentials() { runuser -u postgres -- psql -XAt -d sales_db -c "select count(*) from recruitment_zalo_credentials"; }

case "$STAGE" in c0|c1|c2|off) ;; *) die "cổng phải là c0 | c1 | c2 | off";; esac
[ -n "$GO" ] || die "thiếu --go (mã GO của Owner, hoặc lý do khi tắt)"
# Không ghi mã GO vào nhật ký: chỉ fingerprint sha256 (lý do tắt của `off` không phải mã GO, ghi nguyên).
if [ "$STAGE" = off ]; then GO_LOG="reason=$GO"; else GO_LOG="go_fp=$(printf %s "$GO" | sha256sum | cut -c1-12)"; fi
[ "$(id -u)" = 0 ] || die "cần root"
[ "$(stat -c '%a %U' "$CONF")" = "600 root" ] || die "$CONF phải 600 root"

echo "== Tiền kiểm ($STAGE)"
if [ "$STAGE" != off ]; then
  $OWNER_GO check "$GO" "$STAGE" || die "không có GO hợp lệ của Owner cho cổng $STAGE"
fi
[ "$(code http://127.0.0.1:3010/recruitment/operations/overview)" = 401 ] || die "3010 chưa chạy release G8 (thiếu API HR console)"
if [ "$STAGE" != off ]; then
  [ "$(docker inspect -f '{{.State.Health.Status}}' kido-recruiter-prod-openclaw-gateway-1 2>/dev/null)" = healthy ] || die "gateway production không healthy"
  [ "$(docker port kido-recruiter-prod-openclaw-gateway-1 | tr -d '\n')" = "18789/tcp -> 127.0.0.1:18790" ] || die "gateway publish khác 127.0.0.1:18790"
  [ "$(ufw status | grep -c 'br-kido-prod')" -ge 2 ] || die "thiếu 2 luật ufw br-kido-prod"
fi
case "$STAGE" in
  c0) grep -q '^RECRUITMENT_ZALO_APP_SECRET=.\{16,\}' "$CONF" || die "thiếu RECRUITMENT_ZALO_APP_SECRET trong $CONF — làm bước P0 (G8-RELEASE-RUNBOOK §6)"
      [ "$(oa_credentials)" -ge 1 ] || die "chưa nạp credential OA vào recruitment_zalo_credentials — làm bước P0" ;;
  c1) [ "$(envflag RECRUITMENT_OPENCLAW_URL)" = "http://127.0.0.1:18790" ] || die "chưa qua c0"
      [ "$(envflag RECRUITMENT_PILOT_MODE)" = true ] || die "pilot chưa bật" ;;
  c2) [ "$(envflag RECRUITMENT_AI_ENABLED)" = true ] || die "chưa qua c1"
      [ "$(runuser -u postgres -- psql -XAt -d sales_db -c "select count(*) from pg_trigger where tgname = 'TRG_dispatch_grant_guard' and not tgisinternal")" = 1 ] \
        || die "chưa áp migration single dispatch guard (production/sql/g8-dispatch-guard-up.sql)"
      grep -q recruitment_outbound_dispatch_grants /var/www/sales-management/dist/recruitment/channels/recruitment-channel-outbox.queue.js \
        || die "3010 chưa chạy bản có single dispatch guard"
      [ "$(envhas RECRUITMENT_ZALO_APP_SECRET)" = yes ] || die "3010 chưa có RECRUITMENT_ZALO_APP_SECRET (chạy lại c0)"
      [ "$(oa_credentials)" -ge 1 ] || die "chưa có credential OA trong DB" ;;
esac
echo "  3010 release G8 · gateway OK · cờ hiện tại: AI=$(envflag RECRUITMENT_AI_ENABLED) WORKER=$(envflag RECRUITMENT_WORKER_ENABLED) OUTBOUND=$(envflag RECRUITMENT_ZALO_OUTBOUND_ENABLED)"

if [ -z "$DRY" ]; then
  read -r -p "GO ($GO_LOG) — gõ KICH HOAT $STAGE để tiếp tục: " ans
  [ "$ans" = "KICH HOAT $STAGE" ] || die "đã huỷ"
fi

cd /var/www/sales-management   # dotenv cho wrapper
case "$STAGE" in
  c0) KEYS=$(grep -oE '^[A-Z_]+=' "$CONF" | tr -d = | paste -sd,)
      ARGS=(--env-file "$CONF" --keys "$KEYS") ;;
  c1) ARGS=(--set RECRUITMENT_AI_ENABLED=true --set RECRUITMENT_WORKER_ENABLED=true) ;;
  c2) ARGS=(--set RECRUITMENT_ZALO_OUTBOUND_ENABLED=true --set RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED=true) ;;
  off) ARGS=(--set RECRUITMENT_AI_ENABLED=false --set RECRUITMENT_WORKER_ENABLED=false --set RECRUITMENT_ZALO_OUTBOUND_ENABLED=false) ;;
esac
umask 077
{ echo "stage=$STAGE $GO_LOG at=$(date -Is) dry=${DRY:-no}"; node "$WRAP" --app "$APP" "${ARGS[@]}" $DRY; } 2>&1 | tee "$LOG"
[ -n "$DRY" ] && exit 0

for _ in $(seq 1 30); do [ "$(code http://127.0.0.1:3010/recruitment/jobs)" = 401 ] && break; sleep 2; done
AI=$(code http://127.0.0.1:3010/recruitment/ai/jobs/active)
FLAGS="$(envflag RECRUITMENT_AI_ENABLED)/$(envflag RECRUITMENT_WORKER_ENABLED)/$(envflag RECRUITMENT_ZALO_OUTBOUND_ENABLED)"
echo "== Sau $STAGE: 3010 $(code http://127.0.0.1:3010/recruitment/jobs) · API AI $AI (503 = tắt, 401 = bật cần key) · AI/WORKER/OUTBOUND=$FLAGS" | tee -a "$LOG"
case "$STAGE" in
  c0) WANT=false/false/false ;; c1) WANT=true/true/false ;; c2) WANT=true/true/true ;; off) WANT=false/false/false ;;
esac
[ "$FLAGS" = "$WANT" ] || die "cờ sau $STAGE là $FLAGS, mong đợi $WANT — xem $LOG (GO chưa bị đánh dấu đã dùng)"
[ "$(code http://127.0.0.1:3010/recruitment/jobs)" = 401 ] || die "3010 chưa lên lại — xem pm2 logs (GO chưa bị đánh dấu đã dùng)"
if [ "$STAGE" = c2 ]; then
  SENDER=$(pm2 logs "$APP" --nostream --lines 400 2>/dev/null | grep -E "sender start|sender KHÔNG chạy" | tail -1)
  case "$SENDER" in
    *"dispatchGuard=on"*) echo "  sender: single dispatch guard BẬT" | tee -a "$LOG" ;;
    *) die "sender không báo dispatchGuard=on (${SENDER:-không thấy dòng sender start}) — đặt lại OUTBOUND=false: ./activate-g8.sh off --go \"guard\"" ;;
  esac
fi
[ "$STAGE" = off ] || $OWNER_GO consume "$GO" "$STAGE" "$LOG" | tee -a "$LOG"
echo "Nhật ký: $LOG — nhớ 'pm2 save' (dump.pm2 phải 600) nếu muốn giữ qua reboot."
