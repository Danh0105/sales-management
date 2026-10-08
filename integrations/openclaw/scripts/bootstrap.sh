#!/bin/bash
# Dựng (hoặc dựng lại) stack staging + OpenClaw cho Phase 2. Chạy lại được nhiều lần.
#
#   PGPASSWORD=... integrations/openclaw/scripts/bootstrap.sh [git-ref]
#
# Không đụng production: chỉ ĐỌC schema của sales_db (pg_dump -s, không dữ liệu)
# để dựng DB staging riêng trong Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${1:-sales-release-20261005}"
DIR="${KIDO_RECRUITER_DIR:-/opt/kido-recruiter}"
ENV_FILE="$DIR/.env"
DC=(docker compose --env-file "$ENV_FILE")
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw@sha256:d0ded1dd76939b2bf4d67ef2d13247b8b160aa5666331d4a0b0e58811182cbb8}"

step() { echo; echo "== $*"; }

step "0. Secrets ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$DIR" && chmod 700 "$DIR"
  (umask 077; {
    echo "OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)"
    echo "RECRUITMENT_AI_API_KEY=$(openssl rand -hex 32)"
    echo "RECRUITMENT_CHANNEL_API_KEY=$(openssl rand -hex 32)"
    echo "STAGING_ZALO_OA_SECRET_KEY=$(openssl rand -hex 32)"
    echo "STAGING_JWT_SECRET=$(openssl rand -hex 32)"
    echo "OPENAI_API_KEY="
    echo "STAGING_DB_PASSWORD="
  } > "$ENV_FILE")
  echo "Đã tạo $ENV_FILE — điền STAGING_DB_PASSWORD (và OPENAI_API_KEY riêng của bot tuyển dụng trước khi chạy hội thoại giả lập)."
fi
# Phase 3: key kênh tin cậy — .env tạo trước Phase 3 thì bổ sung (khác key AI chung).
if ! grep -qE '^RECRUITMENT_CHANNEL_API_KEY=.+' "$ENV_FILE"; then
  echo "RECRUITMENT_CHANNEL_API_KEY=$(openssl rand -hex 32)" >> "$ENV_FILE"
fi
# P3-3: OA Secret Key GIẢ cho webhook Zalo OA tuyển dụng trên staging (OA giả
# stg-recruit-oa, không phải OA thật) — acceptance tự ký event bằng key này.
if ! grep -qE '^STAGING_ZALO_OA_SECRET_KEY=.+' "$ENV_FILE"; then
  echo "STAGING_ZALO_OA_SECRET_KEY=$(openssl rand -hex 32)" >> "$ENV_FILE"
fi
# P3-5: App Secret GIẢ (refresh token với Zalo giả) + khoá mã hoá token OA tuyển dụng.
if ! grep -qE '^STAGING_ZALO_APP_SECRET=.+' "$ENV_FILE"; then
  echo "STAGING_ZALO_APP_SECRET=$(openssl rand -hex 32)" >> "$ENV_FILE"
fi
if ! grep -qE '^STAGING_ZALO_TOKEN_KEY=.+' "$ENV_FILE"; then
  echo "STAGING_ZALO_TOKEN_KEY=$(openssl rand -base64 32)" >> "$ENV_FILE"
fi
if ! grep -qE '^STAGING_DB_PASSWORD=.+' "$ENV_FILE"; then
  echo "Điền STAGING_DB_PASSWORD trong $ENV_FILE (khớp mật khẩu DB mà staging-api dùng)." >&2
  exit 1
fi
mkdir -p "$DIR/staging-db" "$DIR/openclaw-state" "$DIR/build"
# Service account Firebase GIẢ cho staging (FcmService bắt buộc lúc khởi động):
# key RSA tự sinh, không phải key Google — không bao giờ dùng credential thật ở đây.
if [ ! -s "$DIR/staging-fake-firebase.json" ]; then
  KEY_PEM=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)
  python3 -c 'import json,sys; print(json.dumps({"type": "service_account", "project_id": "kido-staging-fake", "private_key_id": "fake", "private_key": sys.stdin.read(), "client_email": "fake@kido-staging-fake.iam.gserviceaccount.com", "client_id": "0", "token_uri": "https://oauth2.googleapis.com/token"}))' \
    <<< "$KEY_PEM" > "$DIR/staging-fake-firebase.json"
  chmod 644 "$DIR/staging-fake-firebase.json"   # container chạy user node; key giả, không phải secret
fi

step "1. Schema staging (chỉ schema, không dữ liệu)"
if [ ! -s "$DIR/staging-db/01-schema.sql" ]; then
  : "${PGPASSWORD:?Đặt PGPASSWORD của Postgres production để đọc schema}"
  pg_dump -h localhost -U postgres -s --no-owner --no-privileges sales_db > "$DIR/staging-db/01-schema.sql"
fi
if grep -qE '^(COPY|INSERT) ' "$DIR/staging-db/01-schema.sql"; then
  echo "01-schema.sql có dữ liệu — dừng." >&2; exit 1
fi

step "2. Image staging-api từ $REF"
scripts/build-staging-api.sh "$REF"

step "3. Build + test plugin kido-recruitment (Node 24 trong image OpenClaw)"
rm -rf "$DIR/build/plugin-build" && mkdir -p "$DIR/build/plugin-build"
cp -r plugin/kido-recruitment/. "$DIR/build/plugin-build/"
rm -rf "$DIR/build/plugin-build/node_modules" "$DIR/build/plugin-build/dist"
docker run --rm -u 0 -e HOME=/tmp/home -e NODE_ENV=development \
  -v "$DIR/build/plugin-build:/work" -w /work --entrypoint sh "$OPENCLAW_IMAGE" -c \
  'npm install --include=dev --no-audit --no-fund >/dev/null && npm test && npm run plugin:validate'

step "4. Staging DB + API"
"${DC[@]}" up -d staging-db staging-api

step "5. OpenClaw: onboarding (lần đầu), cấu hình khoá chặt, plugin"
chown -R 1000:1000 "$DIR/openclaw-state"
if [ ! -f "$DIR/openclaw-state/openclaw.json" ]; then
  "${DC[@]}" run --rm -T openclaw-cli onboard --non-interactive --accept-risk --skip-health \
    --mode local --auth-choice skip --secret-input-mode ref \
    --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
    --skip-channels --skip-daemon --skip-search --skip-hooks --skip-ui --skip-skills \
    --workspace /home/node/.openclaw/workspace
fi
"${DC[@]}" run --rm -T openclaw-cli plugins install --link --force --accept-capabilities \
  /opt/kido/plugins/kido-recruitment
"${DC[@]}" run --rm -T -v "$PWD/config/openclaw.batch.json:/tmp/batch.json:ro" \
  openclaw-cli config set --batch-file /tmp/batch.json

step "6. Gateway"
"${DC[@]}" up -d openclaw-gateway
"${DC[@]}" restart openclaw-gateway
for _ in $(seq 1 60); do
  "${DC[@]}" ps openclaw-gateway --format '{{.Status}}' | grep -q healthy && break
  timeout 2 tail -f /dev/null || true
done
"${DC[@]}" exec -T openclaw-gateway openclaw security audit | sed -n 1,3p

echo
echo "Xong. Kiểm tra: scripts/tool-e2e.sh — Hội thoại với LLM: scripts/simulate-conversation.sh"
