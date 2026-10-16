#!/bin/bash
# Deploy release G8 (HR console + cổng duyệt p32) lên 3010 `sales-management`. Chạy bằng root
# CHỈ khi có duyệt triển khai. Không đổi env pm2 (AI / worker / outbound giữ tắt), không migration
# (schema production đã đủ), không đụng 3011, nginx, ufw.
#
#   integrations/openclaw/production/deploy-3010.sh            # deploy + smoke, tự rollback nếu smoke hỏng
#   integrations/openclaw/production/deploy-3010.sh --check    # chỉ kiểm tra trước, không đổi gì
#
# Hotfix khi đang ở C1 (AI + WORKER bật): ALLOW_C1=1 — chỉ chấp nhận khi OUTBOUND env khác `true` VÀ dừng khẩn
# "Gửi Zalo" (outbound_halted) đang bật; smoke mong API AI 401 (bật, cần key) thay vì 503. Đặt ROLLBACK /
# ROLLBACK_EXPECT về bản đang chạy (vd. g8-hrconsole-fdaa3ed / a782a48a1cac837a).
set -Eeuo pipefail
REL="${REL:-/opt/kido-recruiter/releases/g8-hrconsole-fdaa3ed}"
EXPECT="${EXPECT:-a782a48a1cac837a}"
ROLLBACK="${ROLLBACK:-/opt/kido-recruiter/releases/rollback-6e79e1b}"
ROLLBACK_EXPECT="${ROLLBACK_EXPECT:-d35c4525df905174}"
ALLOW_C1="${ALLOW_C1:-0}"
AI_EXPECT=503; [ "$ALLOW_C1" = 1 ] && AI_EXPECT=401
APP=sales-management
APP_DIR=/var/www/sales-management
TS=$(date +%Y%m%d-%H%M%S)
B=/root/backups/g8-release-$TS
CHECK_ONLY=0; [ "${1:-}" = --check ] && CHECK_ONLY=1

h() { (cd "$1" && find . -type f ! -name '*.tsbuildinfo' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
die() { echo "DỪNG: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
pm2_field() { pm2 jlist | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['name']=='$APP'][0];print($1)"; }

step "1. Tiền kiểm"
[ "$(id -u)" = 0 ] || die "cần root"
[ "$(h "$REL/dist")" = "$EXPECT" ] || die "hash artifact $REL khác $EXPECT"
[ "$(h "$ROLLBACK/dist")" = "$ROLLBACK_EXPECT" ] || die "hash bản rollback khác $ROLLBACK_EXPECT"
cmp -s "$REL/package-lock.json" "$APP_DIR/package-lock.json" || die "package-lock của release khác repo live (node_modules không khớp)"
FLAGS=$(pm2_field "' '.join(p['pm2_env'].get('env',{}).get(k, p['pm2_env'].get(k,'')) or '-' for k in ('RECRUITMENT_AI_ENABLED','RECRUITMENT_WORKER_ENABLED','RECRUITMENT_ZALO_OUTBOUND_ENABLED'))")
STATUS=$(pm2_field "p['pm2_env']['status']")
[ "$STATUS" = online ] || die "3010 không online ($STATUS)"
RUNTIME=$(runuser -u postgres -- psql -XAt -d sales_db -c "select ai_halted||'/'||worker_halted||'/'||outbound_halted from recruitment_runtime_controls")
if [ "$ALLOW_C1" = 1 ]; then
  case "$FLAGS" in "true true -"|"true true false") ;; *) die "ALLOW_C1 chỉ cho AI=true WORKER=true OUTBOUND≠true (hiện $FLAGS)";; esac
  [ "${RUNTIME##*/}" = true ] || die "ALLOW_C1 cần dừng khẩn Gửi Zalo đang bật (outbound_halted=true, hiện $RUNTIME)"
else
  case " $FLAGS " in *" true "*) die "3010 đang bật AI/worker/outbound ($FLAGS) — release này chỉ deploy khi cả ba tắt (hotfix C1: ALLOW_C1=1)";; esac
fi
echo "  artifact $EXPECT, rollback $ROLLBACK_EXPECT, cờ env 3010: $FLAGS, cờ dừng khẩn: $RUNTIME, 3010 $STATUS"
[ "$CHECK_ONLY" = 1 ] && { echo "Chỉ kiểm tra — không đổi gì."; exit 0; }
exec 9>/opt/kido-recruiter/g8-deploy-3010.lock
flock -n 9 || die "đang có lượt deploy khác"

step "2. Backup DB + trạng thái pm2 → $B"
mkdir -m 700 -p "$B"; umask 077
runuser -u postgres -- pg_dump -Fc sales_db > "$B/sales_db.dump"
pg_restore --list "$B/sales_db.dump" > /dev/null || die "backup DB không đọc được"
sha256sum "$B/sales_db.dump" > "$B/SHA256SUMS"
pm2_field "f\"{p['pid']} restarts={p['pm2_env']['restart_time']} {p['pm2_env']['pm_exec_path']}\"" > "$B/pm2-before.txt"
echo "  OK ($(du -h "$B/sales_db.dump" | cut -f1))"

rollback() {
  echo; echo "== ROLLBACK về $ROLLBACK ($1)"
  mv "$APP_DIR/dist" "$APP_DIR/dist-g8-failed-$TS"
  cp -a "$ROLLBACK/dist" "$APP_DIR/dist"
  pm2 restart "$APP" > /dev/null
  sleep 15
  echo "  sau rollback: 3010 $(pm2_field "p['pm2_env']['status']"), /recruitment/jobs $(code http://127.0.0.1:3010/recruitment/jobs)"
  die "đã rollback — xem log pm2 và $B"
}

step "3. Đổi dist nguyên khối + restart (không --update-env)"
cp -a "$REL/dist" "$APP_DIR/dist-g8-$TS"
[ "$(h "$APP_DIR/dist-g8-$TS")" = "$EXPECT" ] || die "bản stage sai hash"
mv "$APP_DIR/dist" "$APP_DIR/dist-before-g8-$TS"     # bản WIP trên đĩa — KHÔNG dùng để rollback
mv "$APP_DIR/dist-g8-$TS" "$APP_DIR/dist"
RESTARTS0=$(pm2_field "p['pm2_env']['restart_time']")
pm2 restart "$APP" > /dev/null
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)

step "4. Smoke"
ok=0
for _ in $(seq 1 30); do [ "$(code http://127.0.0.1:3010/recruitment/jobs)" = 401 ] && { ok=1; break; }; sleep 2; done
[ "$ok" = 1 ] || rollback "3010 không lên"
sleep 15
R1=$(pm2_field "p['pm2_env']['restart_time']")
[ "$R1" -le $((RESTARTS0 + 1)) ] || rollback "crash loop (restart $RESTARTS0 → $R1)"
[ "$(code http://127.0.0.1:3010/recruitment/ai/jobs/active)" = "$AI_EXPECT" ] || rollback "API AI không trả $AI_EXPECT"
[ "$(code http://127.0.0.1:3010/recruitment/operations/overview)" = 401 ] || rollback "thiếu API HR console"
[ "$(code https://sales.kidoedu.vn/recruitment/jobs)" = 401 ] || rollback "qua nginx không tới được 3010"
ERR=$(pm2 logs "$APP" --nostream --lines 300 2>&1 | grep -E "RECRUITMENT_AI_SAFETY_CONFIG_INVALID|Error: |ERROR \[" | grep -vc "FCM Error" || true)
[ "$ERR" -eq 0 ] || echo "  CẢNH BÁO: $ERR dòng lỗi trong 300 dòng log gần nhất — xem pm2 logs $APP"
[ "$(runuser -u postgres -- psql -XAt -d sales_db -c "select ai_halted||'/'||worker_halted||'/'||outbound_halted from recruitment_runtime_controls")" = "$RUNTIME" ] || rollback "cờ dừng khẩn bị đổi"
[ "$(pm2_field "' '.join(p['pm2_env'].get('env',{}).get(k, p['pm2_env'].get(k,'')) or '-' for k in ('RECRUITMENT_AI_ENABLED','RECRUITMENT_WORKER_ENABLED','RECRUITMENT_ZALO_OUTBOUND_ENABLED'))")" = "$FLAGS" ] || rollback "cờ env 3010 bị đổi"
echo "  OK: 3010 online, API AI $AI_EXPECT, HR console 401 (cần đăng nhập), nginx OK, cờ env giữ $FLAGS, cờ dừng khẩn giữ $RUNTIME"
echo
echo "XONG. Bản trước (WIP trên đĩa) giữ ở $APP_DIR/dist-before-g8-$TS. Rollback: production/rollback-3010.sh"
