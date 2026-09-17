#!/usr/bin/env bash
#
# Backup cuối ngày ảnh/video check-in/check-out và báo giảng của giáo viên lên NAS.
#
# Nguồn : uploads/lesson-images/          (cả ảnh check-in lẫn minh chứng báo giảng)
# Đích  : $NAS_ROOT/sales-management/lesson-images/
#
# Kèm một manifest CSV đối chiếu từng file với buổi dạy / giáo viên / trường,
# vì bản thân tên file là UUID nên sao lưu không manifest sẽ không phục hồi được
# ngữ cảnh.
#
# NGUYÊN TẮC AN TOÀN: NAS này từng chết và treo cứng mount NFS, kéo sập nginx
# toàn máy. Script vì vậy KHÔNG BAO GIỜ được chạm vào mount khi chưa kiểm tra
# sống, và mọi thao tác lên NAS đều bọc trong `timeout`.

set -uo pipefail

APP_DIR="${APP_DIR:-/var/www/sales-management}"
SOURCE_DIR="${SOURCE_DIR:-$APP_DIR/uploads/lesson-images}"
NAS_HOST="${NAS_HOST:-100.125.240.63}"
NAS_MOUNT="${NAS_MOUNT:-/mnt/nas-var}"
NAS_ROOT="${NAS_ROOT:-$NAS_MOUNT/backup}"
DEST_DIR="$NAS_ROOT/sales-management/lesson-images"
MANIFEST_DIR="$NAS_ROOT/sales-management/manifest"

LOG_DIR="${LOG_DIR:-/var/log/sales-backup}"
LOG_FILE="$LOG_DIR/backup-media.log"
LOCK_FILE="/var/run/sales-backup-media.lock"

# Thời gian tối đa cho rsync (giây). 1.9 GB qua LAN thừa sức trong 30 phút;
# quá ngưỡng này nghĩa là NAS lại có vấn đề, cắt để khỏi treo vô hạn.
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-1800}"
# Thời gian tối đa cho một thao tác thăm dò mount.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-8}"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-sales_db}"

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }
die() { log "THẤT BẠI: $*"; exit 1; }

# Chỉ cho một lần chạy tại một thời điểm.
exec 9>"$LOCK_FILE"
flock -n 9 || die "một tiến trình backup khác đang chạy, bỏ qua lần này"

log "===== Bắt đầu backup media lên NAS ====="

[ -d "$SOURCE_DIR" ] || die "không tìm thấy thư mục nguồn $SOURCE_DIR"

# --- Kiểm tra NAS sống trước khi chạm vào mount -----------------------------
# Thứ tự quan trọng: ping trước (không đụng NFS), rồi mới thăm dò mount.
if ! timeout 5 ping -c 2 -W 1 "$NAS_HOST" >/dev/null 2>&1; then
  die "NAS $NAS_HOST không phản hồi ping — bỏ qua, KHÔNG chạm vào mount NFS"
fi

# Thăm dò chính mountpoint, không phải thư mục con (thư mục con có thể chưa
# tồn tại, và stat sẽ báo lỗi vì lý do đó chứ không phải vì NFS treo).
if ! timeout "$PROBE_TIMEOUT" stat "$NAS_MOUNT" >/dev/null 2>&1; then
  die "mount NFS tại $NAS_MOUNT treo hoặc không truy cập được — bỏ qua lần backup này"
fi

if ! mountpoint -q "$NAS_MOUNT" 2>/dev/null; then
  die "$NAS_MOUNT không phải mountpoint đang gắn — từ chối ghi vào đĩa local"
fi

if ! timeout "$PROBE_TIMEOUT" mkdir -p "$DEST_DIR" "$MANIFEST_DIR" 2>/dev/null; then
  die "không tạo được thư mục đích trên NAS (NAS chậm hoặc chỉ đọc)"
fi

log "NAS OK. Đích: $DEST_DIR"

SOURCE_COUNT=$(find "$SOURCE_DIR" -type f | wc -l)
SOURCE_SIZE=$(du -sh "$SOURCE_DIR" | cut -f1)
log "Nguồn: $SOURCE_COUNT file, $SOURCE_SIZE"

# --- Đồng bộ file ----------------------------------------------------------
# Không dùng --delete: đây là kho lưu trữ minh chứng chấm công, file đã backup
# phải giữ lại kể cả khi bản gốc bị xoá.
log "Đang rsync..."
timeout "$RSYNC_TIMEOUT" rsync -a --partial --no-perms --no-owner --no-group \
  --stats "$SOURCE_DIR/" "$DEST_DIR/" >>"$LOG_FILE" 2>&1
RSYNC_RC=$?

case "$RSYNC_RC" in
  0)   log "rsync xong." ;;
  24)  log "rsync xong (có file biến mất giữa chừng — bình thường khi app đang ghi)." ;;
  124) die "rsync vượt quá ${RSYNC_TIMEOUT}s và đã bị cắt — NAS có vấn đề" ;;
  *)   die "rsync lỗi, mã $RSYNC_RC (xem $LOG_FILE)" ;;
esac

# --- Manifest đối chiếu file <-> buổi dạy ----------------------------------
# Tên file là UUID, không mang thông tin. Manifest là thứ giúp bản backup
# thực sự dùng được khi cần tra cứu hoặc phục hồi.
STAMP=$(date '+%F')
MANIFEST_TMP=$(mktemp)
log "Đang xuất manifest..."

if PGPASSWORD="${PGPASSWORD:-postgres}" timeout 120 psql -h "$PGHOST" -p "$PGPORT" \
     -U "$PGUSER" -d "$PGDATABASE" --csv -t -o "$MANIFEST_TMP" -c "
  SELECT
    s.id                AS session_id,
    s.date              AS ngay_day,
    kind.loai           AS loai_anh,
    img->>'url'         AS duong_dan,
    img->>'name'        AS ten_goc,
    img->>'mimeType'    AS mime_type
  FROM teaching_sessions s
  CROSS JOIN LATERAL (
    VALUES ('checkin', s.checkin_images), ('bao_giang', s.lesson_images)
  ) AS kind(loai, images)
  CROSS JOIN LATERAL jsonb_array_elements(kind.images) AS img
  WHERE kind.images IS NOT NULL
    AND jsonb_typeof(kind.images) = 'array'
  ORDER BY s.date DESC, s.id, kind.loai;
" 2>>"$LOG_FILE"; then
  if timeout "$PROBE_TIMEOUT" cp "$MANIFEST_TMP" "$MANIFEST_DIR/manifest-$STAMP.csv" 2>>"$LOG_FILE"; then
    log "Manifest: $(wc -l <"$MANIFEST_TMP") dòng -> manifest-$STAMP.csv"
  else
    log "CẢNH BÁO: không chép được manifest lên NAS (file đã sao lưu vẫn an toàn)"
  fi
else
  log "CẢNH BÁO: xuất manifest từ database thất bại (file đã sao lưu vẫn an toàn)"
fi
rm -f "$MANIFEST_TMP"

# --- Đối chiếu kết quả -----------------------------------------------------
DEST_COUNT=$(timeout "$PROBE_TIMEOUT" find "$DEST_DIR" -type f 2>/dev/null | wc -l)
log "Đích hiện có: $DEST_COUNT file (nguồn $SOURCE_COUNT)"
if [ "$DEST_COUNT" -lt "$SOURCE_COUNT" ]; then
  die "số file trên NAS ÍT HƠN nguồn — backup không đầy đủ"
fi

# --- Giải phóng VPS ---------------------------------------------------------
# Chỉ tới bước này khi rsync xong và số file trên NAS >= nguồn. Xoá bản gốc
# trên VPS của những file cũ hơn HOT_DAYS ngày, sau khi so checksum từng file
# với bản trên NAS. thumb/ được giữ lại làm ảnh dự phòng.
# Backend tự tìm sang NAS khi file không còn trên VPS (LessonMediaController).
HOT_DAYS="${HOT_DAYS:-7}"
# Backend đang chạy (để kiểm tra nó thật sự đọc được từ NAS trước khi xoá).
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3010}"

# Khoá liên động: đặt một file "canh" chỉ có trên NAS rồi hỏi backend đang
# chạy. Nếu nó không trả về với tier=archive thì bản đang chạy chưa có tầng
# lạnh (chưa restart sau deploy, cấu hình sai, breaker đang ngắt...) — xoá lúc
# này là ảnh biến mất khỏi app. Trường hợp đó giữ nguyên VPS, chỉ cảnh báo.
backend_serves_from_nas() {
  local sentinel="ffffffff-0000-4000-8000-00000000cafe.webp"
  local probe="$DEST_DIR/$sentinel"
  printf 'RIFF\0\0\0\0WEBP' | timeout "$PROBE_TIMEOUT" tee "$probe" >/dev/null 2>&1 || return 1
  local tier
  tier=$(curl -s -o /dev/null -m 10 -w '%header{x-lesson-media-tier}' \
    "$BACKEND_URL/uploads/lesson-images/$sentinel" 2>/dev/null)
  timeout "$PROBE_TIMEOUT" rm -f "$probe" 2>/dev/null
  [ "$tier" = "archive" ]
}

if [ "${PRUNE_LOCAL:-1}" != "1" ]; then
  log "Bỏ qua giải phóng VPS (PRUNE_LOCAL=$PRUNE_LOCAL)"
elif ! backend_serves_from_nas; then
  log "CẢNH BÁO: backend tại $BACKEND_URL chưa phục vụ được ảnh từ NAS — KHÔNG xoá gì trên VPS. Kiểm tra đã restart bản mới và LESSON_IMAGE_ARCHIVE_DIR chưa."
else
  log "Giải phóng VPS: xoá bản gốc đã xác minh, cũ hơn $HOT_DAYS ngày..."
  if MIN_AGE_DAYS="$HOT_DAYS" SOURCE_DIR="$SOURCE_DIR" DEST_DIR="$DEST_DIR" \
       NAS_MOUNT="$NAS_MOUNT" NAS_HOST="$NAS_HOST" \
       "$APP_DIR/scripts/verify-backup-on-nas.sh" --delete >>"$LOG_FILE" 2>&1; then
    log "Giải phóng xong: $(grep -E 'Đã xoá|Dung lượng' "$LOG_FILE" | tail -2 | tr '\n' ' ')"
  else
    log "CẢNH BÁO: có file không khớp NAS, đã giữ lại trên VPS (xem chi tiết trong log)"
  fi
fi

log "===== Backup hoàn tất ====="
