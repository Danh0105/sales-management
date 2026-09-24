#!/usr/bin/env bash
#
# Backup toàn bộ cluster PostgreSQL (mọi database, không riêng sales_db) lên NAS.
#
# Đích: $NAS_ROOT/postgres-all/<YYYY-MM-DD>/
#   - globals.sql.gz        (roles, tablespaces — pg_dumpall --globals-only)
#   - <database>.dump       (từng DB, format custom -Fc: nén sẵn, phục hồi
#                             chọn lọc bảng được bằng pg_restore)
#
# Cùng nguyên tắc an toàn với backup-media-to-nas.sh: NAS này từng treo cứng
# mount NFS và kéo sập nginx toàn máy — KHÔNG BAO GIỜ chạm mount khi chưa xác
# minh sống, mọi thao tác lên NAS bọc trong `timeout`.

set -uo pipefail

NAS_HOST="${NAS_HOST:-100.125.240.63}"
NAS_MOUNT="${NAS_MOUNT:-/mnt/nas-var}"
NAS_ROOT="${NAS_ROOT:-$NAS_MOUNT/backup}"
STAMP=$(date '+%F')
DEST_DIR="$NAS_ROOT/postgres-all/$STAMP"

LOG_DIR="${LOG_DIR:-/var/log/sales-backup}"
LOG_FILE="$LOG_DIR/backup-db.log"
LOCK_FILE="/var/run/sales-backup-db.lock"

PROBE_TIMEOUT="${PROBE_TIMEOUT:-8}"
DUMP_TIMEOUT="${DUMP_TIMEOUT:-1800}"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

# Giữ lại bao nhiêu ngày backup gần nhất trên NAS trước khi dọn bản cũ.
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }
die() { log "THẤT BẠI: $*"; exit 1; }

exec 9>"$LOCK_FILE"
flock -n 9 || die "một tiến trình backup DB khác đang chạy, bỏ qua lần này"

log "===== Bắt đầu backup toàn bộ database lên NAS ====="

# --- Kiểm tra NAS sống trước khi chạm vào mount -----------------------------
if ! timeout 5 ping -c 2 -W 1 "$NAS_HOST" >/dev/null 2>&1; then
  die "NAS $NAS_HOST không phản hồi ping — bỏ qua, KHÔNG chạm vào mount NFS"
fi
if ! timeout "$PROBE_TIMEOUT" stat "$NAS_MOUNT" >/dev/null 2>&1; then
  die "mount NFS tại $NAS_MOUNT treo hoặc không truy cập được — bỏ qua lần backup này"
fi
if ! mountpoint -q "$NAS_MOUNT" 2>/dev/null; then
  die "$NAS_MOUNT không phải mountpoint đang gắn — từ chối ghi vào đĩa local"
fi
if ! timeout "$PROBE_TIMEOUT" mkdir -p "$DEST_DIR" 2>/dev/null; then
  die "không tạo được thư mục đích trên NAS (NAS chậm hoặc chỉ đọc)"
fi
log "NAS OK. Đích: $DEST_DIR"

# --- Roles/tablespaces (globals) -------------------------------------------
log "Đang dump globals (roles, tablespaces)..."
if timeout "$DUMP_TIMEOUT" pg_dumpall -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
     --globals-only 2>>"$LOG_FILE" | gzip > "$DEST_DIR/globals.sql.gz.tmp"; then
  mv "$DEST_DIR/globals.sql.gz.tmp" "$DEST_DIR/globals.sql.gz"
  log "globals.sql.gz OK ($(du -h "$DEST_DIR/globals.sql.gz" | cut -f1))"
else
  rm -f "$DEST_DIR/globals.sql.gz.tmp"
  die "dump globals thất bại"
fi

# --- Từng database ----------------------------------------------------------
DATABASES=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;")

[ -n "$DATABASES" ] || die "không lấy được danh sách database"

FAILED=0
for db in $DATABASES; do
  log "Dump database: $db"
  if timeout "$DUMP_TIMEOUT" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
       -d "$db" -Fc -f "$DEST_DIR/$db.dump.tmp" 2>>"$LOG_FILE"; then
    mv "$DEST_DIR/$db.dump.tmp" "$DEST_DIR/$db.dump"
    log "  -> OK ($(du -h "$DEST_DIR/$db.dump" | cut -f1))"
  else
    rm -f "$DEST_DIR/$db.dump.tmp"
    log "  -> LỖI khi dump $db (xem $LOG_FILE)"
    FAILED=1
  fi
done

# --- Dọn bản cũ hơn KEEP_DAYS ngày ------------------------------------------
log "Dọn các bản backup cũ hơn $KEEP_DAYS ngày..."
timeout "$PROBE_TIMEOUT" find "$NAS_ROOT/postgres-all" -maxdepth 1 -mindepth 1 -type d \
  -mtime "+$KEEP_DAYS" -print -exec rm -rf {} \; 2>>"$LOG_FILE" | tee -a "$LOG_FILE"

if [ "$FAILED" = "1" ]; then
  die "một hoặc nhiều database dump lỗi — kiểm tra $LOG_FILE"
fi

log "===== Backup database hoàn tất: $DEST_DIR ====="
