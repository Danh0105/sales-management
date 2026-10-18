#!/bin/bash
# Rollback 3010 về bản backend đang chạy trước G8: 6e79e1b (artifact Codex 14/10, hash d35c4525df905174).
# Sau G8 production: ROLLBACK=/opt/kido-recruiter/releases/g8-guard-591dd90 ROLLBACK_EXPECT=083001e9b044f070 —
# CHỈ sau khi đã về pilot (activate-g8.sh pilot) hoặc tắt (activate-g8.sh off); script tự chặn nếu chưa.
# KHÔNG quay về dist-before-g8-* (đó là build WIP trên đĩa, chưa từng chạy). Schema giữ nguyên.
set -Eeuo pipefail
ROLLBACK="${ROLLBACK:-/opt/kido-recruiter/releases/rollback-6e79e1b}"   # hotfix sau G8: ROLLBACK=…/g8-hrconsole-fdaa3ed
ROLLBACK_EXPECT="${ROLLBACK_EXPECT:-d35c4525df905174}"                    #                 ROLLBACK_EXPECT=a782a48a1cac837a
APP=sales-management
APP_DIR=/var/www/sales-management
TS=$(date +%Y%m%d-%H%M%S)
h() { (cd "$1" && find . -type f ! -name '*.tsbuildinfo' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
die() { echo "DỪNG: $*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

envflag() { pm2 jlist | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['name']=='$APP'][0];e=p['pm2_env'];print(e.get('env',{}).get('$1', e.get('$1','')) or '-')"; }

[ "$(id -u)" = 0 ] || die "cần root"
[ "$(h "$ROLLBACK/dist")" = "$ROLLBACK_EXPECT" ] || die "hash bản rollback sai"
# Bản cũ (trước GO PROD) không biết RECRUITMENT_PRODUCTION_MODE: nếu env đang production (PILOT=false, không
# grant) mà OUTBOUND bật, code cũ sẽ gửi KHÔNG có guard / quota. Phải về pilot hoặc tắt trước.
if [ "$(envflag RECRUITMENT_ZALO_OUTBOUND_ENABLED)" = true ] && \
   [ "$(envflag RECRUITMENT_PILOT_MODE)/$(envflag RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED)" != "true/true" ]; then
  die "OUTBOUND bật mà không ở pilot + single dispatch guard — chạy trước: ./activate-g8.sh pilot --go \"rollback\" (hoặc ./activate-g8.sh off --go \"rollback\")"
fi
[ "$(envflag RECRUITMENT_PRODUCTION_MODE)" != true ] || die "RECRUITMENT_PRODUCTION_MODE=true — chạy ./activate-g8.sh pilot --go \"rollback\" trước"
read -r -p "Rollback 3010 về $ROLLBACK ($ROLLBACK_EXPECT)? Gõ ROLLBACK: " ans
[ "$ans" = ROLLBACK ] || die "đã huỷ"
cp -a "$ROLLBACK/dist" "$APP_DIR/dist-rollback-$TS"
mv "$APP_DIR/dist" "$APP_DIR/dist-g8-rolledback-$TS"
mv "$APP_DIR/dist-rollback-$TS" "$APP_DIR/dist"
pm2 restart "$APP" > /dev/null
for _ in $(seq 1 30); do [ "$(code http://127.0.0.1:3010/recruitment/jobs)" = 401 ] && break; sleep 2; done
echo "3010: /recruitment/jobs $(code http://127.0.0.1:3010/recruitment/jobs) (401 = chạy), HR console $(code http://127.0.0.1:3010/recruitment/operations/overview) (401 = bản G8, 404 = 6e79e1b)"
echo "Bản G8 giữ ở $APP_DIR/dist-g8-rolledback-$TS."
