#!/bin/bash
# Deploy frontend kido-app (HR console tuyển dụng) — nginx phục vụ tĩnh /var/www/kido-app/dist.
# Chạy bằng root khi có duyệt triển khai. Màn mới tự ẩn khi backend chưa có API HR console,
# nên deploy được trước hoặc sau backend.
#
#   SRC=<artifact> EXPECT=<hash16> integrations/openclaw/production/deploy-fe.sh [--check]
#
# Artifact phải build từ commit (worktree sạch + npm ci). Không có giá trị mặc định: bản
# dist-g8-hrconsole (e75dbbc70cc53ce4) build từ working tree — KHÔNG deploy; dist-g8-4dd3cc9 thiếu
# WIP live + asset public (FaceId) — KHÔNG deploy. Bản đã deploy 16/10 14:39: kido-app
# release/g8-fe-live 1520f5a → /opt/kido-recruiter/releases/kido-app-g8-1520f5a/dist (a533c0eacfe19ca4).
set -Eeuo pipefail
SRC="${SRC:?đặt SRC=<thư mục artifact build từ commit>}"
EXPECT="${EXPECT:?đặt EXPECT=<hash 16 ký tự của artifact>}"
[ "$EXPECT" != e75dbbc70cc53ce4 ] || { echo "DỪNG: artifact e75dbbc70cc53ce4 không tái tạo được" >&2; exit 1; }
ROOT=/var/www/kido-app
TS=$(date +%Y%m%d-%H%M%S)
BK=/root/kido-app-dist-backups/dist-$TS
h() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
die() { echo "DỪNG: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "cần root"
[ "$(h "$SRC")" = "$EXPECT" ] || die "hash artifact $SRC khác $EXPECT"
BUNDLE=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$SRC/index.html" | head -1)
LIVE=$(curl -s https://kidoapp.kidoedu.vn/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
echo "bundle mới: $BUNDLE · đang live: $LIVE"
[ "${1:-}" = --check ] && { echo "Chỉ kiểm tra — không đổi gì."; exit 0; }

mkdir -p /root/kido-app-dist-backups && cp -a "$ROOT/dist" "$BK"
NEW="$ROOT/dist-new-g8-$TS"
cp -a "$SRC" "$NEW"
cp -an "$ROOT/dist/assets/." "$NEW/assets/"        # giữ chunk cũ để tab đang mở không lỗi
mv "$ROOT/dist" "$ROOT/dist-old-g8-$TS"
mv "$NEW" "$ROOT/dist"
NOW=$(curl -s https://kidoapp.kidoedu.vn/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
if [ "$NOW" != "$BUNDLE" ] || [ "$(curl -s -o /dev/null -w '%{http_code}' "https://kidoapp.kidoedu.vn/$BUNDLE")" != 200 ]; then
  mv "$ROOT/dist" "$ROOT/dist-g8-failed-$TS"; cp -a "$BK" "$ROOT/dist"
  die "trang live không trỏ bundle mới ($NOW) — đã trả bản cũ từ $BK"
fi
echo "XONG: kidoapp.kidoedu.vn → $BUNDLE · backup $BK · bản cũ giữ ở $ROOT/dist-old-g8-$TS"
echo "Rollback: mv $ROOT/dist $ROOT/dist-g8-rolledback-\$(date +%s) && cp -a $BK $ROOT/dist"
