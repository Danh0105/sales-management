#!/usr/bin/env bash
#
# Đối chiếu từng file local với bản trên NAS trước khi xoá bất cứ thứ gì.
#
# Chỉ so tên + kích thước là KHÔNG đủ để dám xoá bản gốc: một file rsync dở
# dang vẫn có thể trùng tên. Script này so checksum nội dung.
#
#   ./verify-backup-on-nas.sh            # chỉ báo cáo (mặc định)
#   ./verify-backup-on-nas.sh --delete   # xoá những file ĐÃ xác minh khớp
#
# Mặc định luôn là dry-run. Xoá phải nói rõ bằng cờ --delete.

set -uo pipefail

APP_DIR="${APP_DIR:-/var/www/sales-management}"
SOURCE_DIR="${SOURCE_DIR:-$APP_DIR/uploads/lesson-images}"
NAS_MOUNT="${NAS_MOUNT:-/mnt/nas-var}"
DEST_DIR="${DEST_DIR:-$NAS_MOUNT/backup/sales-management/lesson-images}"

# Chỉ đụng tới file đã cũ hơn ngần này ngày. File mới còn đang được xem nhiều,
# và giữ lại vài ngày gần nhất là biên an toàn cho mọi sự cố backup.
MIN_AGE_DAYS="${MIN_AGE_DAYS:-30}"

# thumb/ KHÔNG BAO GIỜ bị xoá khỏi VPS: đó là ảnh dự phòng mà backend trả về
# khi NAS mất kết nối. Nó chỉ chiếm vài MB.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-8}"

DELETE=0
[ "${1:-}" = "--delete" ] && DELETE=1

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "THẤT BẠI: $*"; exit 1; }

timeout 5 ping -c 2 -W 1 "${NAS_HOST:-100.125.240.63}" >/dev/null 2>&1 \
  || die "NAS không phản hồi — không xác minh được, KHÔNG xoá gì cả"
timeout "$PROBE_TIMEOUT" stat "$NAS_MOUNT" >/dev/null 2>&1 \
  || die "mount NFS treo — KHÔNG xoá gì cả"
mountpoint -q "$NAS_MOUNT" \
  || die "$NAS_MOUNT không phải mountpoint — KHÔNG xoá gì cả"
[ -d "$DEST_DIR" ] || die "chưa có thư mục backup $DEST_DIR — hãy chạy backup trước"

[ "$DELETE" = 1 ] && log "CHẾ ĐỘ XOÁ" || log "Chế độ báo cáo (dry-run), không xoá gì"
log "Chỉ xét file cũ hơn $MIN_AGE_DAYS ngày"

ok=0; missing=0; differ=0; freed=0

while IFS= read -r -d '' src; do
  rel="${src#$SOURCE_DIR/}"
  dst="$DEST_DIR/$rel"

  if ! timeout "$PROBE_TIMEOUT" test -f "$dst" 2>/dev/null; then
    missing=$((missing+1)); echo "  THIẾU trên NAS : $rel"; continue
  fi

  src_sum=$(md5sum "$src" 2>/dev/null | cut -d' ' -f1)
  dst_sum=$(timeout 60 md5sum "$dst" 2>/dev/null | cut -d' ' -f1)

  if [ -z "$dst_sum" ] || [ "$src_sum" != "$dst_sum" ]; then
    differ=$((differ+1)); echo "  KHÁC NỘI DUNG : $rel"; continue
  fi

  ok=$((ok+1))
  freed=$((freed + $(stat -c%s "$src")))
  [ "$DELETE" = 1 ] && rm -f "$src"
done < <(find "$SOURCE_DIR" -type f -not -path '*/thumb/*' -mtime +"$MIN_AGE_DAYS" -print0)

echo
log "Khớp checksum : $ok"
log "Thiếu trên NAS: $missing"
log "Khác nội dung : $differ"
log "Dung lượng    : $(numfmt --to=iec $freed)"
if [ "$DELETE" = 1 ]; then
  log "Đã xoá $ok file khỏi VPS."
else
  log "Chưa xoá gì. Chạy lại với --delete nếu muốn giải phóng."
fi
[ "$missing" -eq 0 ] && [ "$differ" -eq 0 ]
