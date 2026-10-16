#!/bin/bash
# Rollback 3010 về bản backend đang chạy trước G8: 6e79e1b (artifact Codex 14/10, hash d35c4525df905174).
# KHÔNG quay về dist-before-g8-* (đó là build WIP trên đĩa, chưa từng chạy). Schema giữ nguyên.
set -Eeuo pipefail
ROLLBACK=/opt/kido-recruiter/releases/rollback-6e79e1b
ROLLBACK_EXPECT=d35c4525df905174
APP=sales-management
APP_DIR=/var/www/sales-management
TS=$(date +%Y%m%d-%H%M%S)
h() { (cd "$1" && find . -type f ! -name '*.tsbuildinfo' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
die() { echo "DỪNG: $*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

[ "$(id -u)" = 0 ] || die "cần root"
[ "$(h "$ROLLBACK/dist")" = "$ROLLBACK_EXPECT" ] || die "hash bản rollback sai"
read -r -p "Rollback 3010 về 6e79e1b? Gõ ROLLBACK: " ans
[ "$ans" = ROLLBACK ] || die "đã huỷ"
cp -a "$ROLLBACK/dist" "$APP_DIR/dist-rollback-$TS"
mv "$APP_DIR/dist" "$APP_DIR/dist-g8-rolledback-$TS"
mv "$APP_DIR/dist-rollback-$TS" "$APP_DIR/dist"
pm2 restart "$APP" > /dev/null
for _ in $(seq 1 30); do [ "$(code http://127.0.0.1:3010/recruitment/jobs)" = 401 ] && break; sleep 2; done
echo "3010: /recruitment/jobs $(code http://127.0.0.1:3010/recruitment/jobs) (401 = chạy), HR console $(code http://127.0.0.1:3010/recruitment/operations/overview) (404 = đã về 6e79e1b)"
echo "Bản G8 giữ ở $APP_DIR/dist-g8-rolledback-$TS."
