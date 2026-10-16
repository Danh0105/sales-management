#!/bin/bash
# Kích hoạt AI Recruiter trên 3010 theo cổng canary G8 — CHỈ khi có GO hợp lệ cho đúng cổng
# (3 chữ ký: HR, vận hành, privacy). Mỗi cổng chạy riêng, có xác nhận gõ tay.
#
#   activate-g8.sh c0  --go "<mã biên bản GO>" [--dry-run]   # nạp cấu hình gateway + pilot + trần; AI/WORKER/OUTBOUND = false
#   activate-g8.sh c1  --go "<mã>" [--dry-run]               # AI + WORKER = true (tin AI chỉ tạo bản nháp chờ duyệt)
#   activate-g8.sh c2  --go "<mã>" [--dry-run]               # OUTBOUND = true (chỉ tin đã duyệt mới được gửi)
#   activate-g8.sh off --go "<lý do>" [--dry-run]            # AI/WORKER/OUTBOUND = false bằng env + restart
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
APP=sales-management
CONF=/opt/kido-recruiter-prod/3010-g8.env
WRAP=/opt/kido-recruiter/worktrees/release-g8-p32/integrations/openclaw/scripts/p372b-pm2-env.js
LOG=/opt/kido-recruiter/runs/g8-activation-$(date +%Y%m%d-%H%M%S)-$STAGE.log
die() { echo "DỪNG: $*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
envflag() { pm2 jlist | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['name']=='$APP'][0];e=p['pm2_env'];print(e.get('env',{}).get('$1', e.get('$1','')) or '-')"; }

case "$STAGE" in c0|c1|c2|off) ;; *) die "cổng phải là c0 | c1 | c2 | off";; esac
[ -n "$GO" ] || die "thiếu --go (mã biên bản GO hoặc lý do tắt)"
[ "$(id -u)" = 0 ] || die "cần root"
[ "$(stat -c '%a %U' "$CONF")" = "600 root" ] || die "$CONF phải 600 root"

echo "== Tiền kiểm ($STAGE)"
[ "$(code http://127.0.0.1:3010/recruitment/operations/overview)" = 401 ] || die "3010 chưa chạy release G8 (thiếu API HR console)"
if [ "$STAGE" != off ]; then
  [ "$(docker inspect -f '{{.State.Health.Status}}' kido-recruiter-prod-openclaw-gateway-1 2>/dev/null)" = healthy ] || die "gateway production không healthy"
  [ "$(docker port kido-recruiter-prod-openclaw-gateway-1 | tr -d '\n')" = "18789/tcp -> 127.0.0.1:18790" ] || die "gateway publish khác 127.0.0.1:18790"
  [ "$(ufw status | grep -c 'br-kido-prod')" -ge 2 ] || die "thiếu 2 luật ufw br-kido-prod"
fi
case "$STAGE" in
  c1) [ "$(envflag RECRUITMENT_OPENCLAW_URL)" = "http://127.0.0.1:18790" ] || die "chưa qua c0"
      [ "$(envflag RECRUITMENT_PILOT_MODE)" = true ] || die "pilot chưa bật" ;;
  c2) [ "$(envflag RECRUITMENT_AI_ENABLED)" = true ] || die "chưa qua c1" ;;
esac
echo "  3010 release G8 · gateway OK · cờ hiện tại: AI=$(envflag RECRUITMENT_AI_ENABLED) WORKER=$(envflag RECRUITMENT_WORKER_ENABLED) OUTBOUND=$(envflag RECRUITMENT_ZALO_OUTBOUND_ENABLED)"

if [ -z "$DRY" ]; then
  read -r -p "GO '$GO' — gõ KICH HOAT $STAGE để tiếp tục: " ans
  [ "$ans" = "KICH HOAT $STAGE" ] || die "đã huỷ"
fi

cd /var/www/sales-management   # dotenv cho wrapper
case "$STAGE" in
  c0) KEYS=$(grep -oE '^[A-Z_]+=' "$CONF" | tr -d = | paste -sd,)
      ARGS=(--env-file "$CONF" --keys "$KEYS") ;;
  c1) ARGS=(--set RECRUITMENT_AI_ENABLED=true --set RECRUITMENT_WORKER_ENABLED=true) ;;
  c2) ARGS=(--set RECRUITMENT_ZALO_OUTBOUND_ENABLED=true) ;;
  off) ARGS=(--set RECRUITMENT_AI_ENABLED=false --set RECRUITMENT_WORKER_ENABLED=false --set RECRUITMENT_ZALO_OUTBOUND_ENABLED=false) ;;
esac
umask 077
{ echo "stage=$STAGE go=$GO at=$(date -Is) dry=${DRY:-no}"; node "$WRAP" --app "$APP" "${ARGS[@]}" $DRY; } 2>&1 | tee "$LOG"
[ -n "$DRY" ] && exit 0

for _ in $(seq 1 30); do [ "$(code http://127.0.0.1:3010/recruitment/jobs)" = 401 ] && break; sleep 2; done
AI=$(code http://127.0.0.1:3010/recruitment/ai/jobs/active)
echo "== Sau $STAGE: 3010 $(code http://127.0.0.1:3010/recruitment/jobs) · API AI $AI (503 = tắt, 401 = bật cần key) · AI=$(envflag RECRUITMENT_AI_ENABLED) WORKER=$(envflag RECRUITMENT_WORKER_ENABLED) OUTBOUND=$(envflag RECRUITMENT_ZALO_OUTBOUND_ENABLED)" | tee -a "$LOG"
echo "Nhật ký: $LOG — nhớ 'pm2 save' (dump.pm2 phải 600) nếu muốn giữ qua reboot."
