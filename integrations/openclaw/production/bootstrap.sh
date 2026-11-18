#!/bin/bash
# Dựng gateway OpenClaw PRODUCTION (G8 / A3) — chạy lại được nhiều lần, không in secret.
#
#   integrations/openclaw/production/bootstrap.sh            # chuẩn bị: plugin, skill, cấu hình (gateway không chạy)
#   integrations/openclaw/production/bootstrap.sh --verify   # + khởi động, kiểm tra, rồi DỪNG lại
#
# Không đụng 3010/3011, ufw, nginx, Docker daemon; không gọi model. Gateway chỉ được để chạy
# (`docker compose ... up -d openclaw-gateway`) sau khi 2 luật ufw trên `br-kido-prod` đã áp — README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
VERIFY=0; [ "${1:-}" = --verify ] && VERIFY=1
DIR="${KIDO_RECRUITER_PROD_DIR:-/opt/kido-recruiter-prod}"
ENV_FILE="$DIR/.env"
DC=(docker compose -f production/docker-compose.yml --env-file "$ENV_FILE")
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw@sha256:d0ded1dd76939b2bf4d67ef2d13247b8b160aa5666331d4a0b0e58811182cbb8}"
step() { echo; echo "== $*"; }
die() { echo "DỪNG: $*" >&2; exit 1; }
fp() { grep -E "^$1=" "$2" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r\n' | sha256sum | cut -c1-12; }

step "0. Secrets ($ENV_FILE) — chỉ kiểm tên + dấu vân tay"
[ "$(id -u)" = 0 ] || die "cần chạy bằng root"
[ -f "$ENV_FILE" ] || die "thiếu $ENV_FILE"
[ "$(stat -c '%a %U' "$ENV_FILE")" = "600 root" ] || die "$ENV_FILE phải là 600 root"
[ "$(stat -c '%a %U' "$DIR")" = "700 root" ] || die "$DIR phải là 700 root"
for k in OPENAI_API_KEY OPENCLAW_GATEWAY_TOKEN RECRUITMENT_CHANNEL_API_KEY; do
  grep -qE "^$k=.{32,}" "$ENV_FILE" || die "$k thiếu hoặc quá ngắn"
done
! grep -qE '^RECRUITMENT_AI_API_KEY=' "$ENV_FILE" || die "production KHÔNG đặt RECRUITMENT_AI_API_KEY (key chung không subject)"
for k in OPENAI_API_KEY OPENCLAW_GATEWAY_TOKEN RECRUITMENT_CHANNEL_API_KEY; do
  [ "$(fp $k "$ENV_FILE")" != "$(fp $k /opt/kido-recruiter/.env)" ] || die "$k trùng staging"
done
[ "$(fp OPENAI_API_KEY "$ENV_FILE")" != "$(fp OPENAI_API_KEY /var/www/sales-management/.env)" ] || die "OPENAI_API_KEY trùng key sales-management"
echo "  OK: 3 biến, 600 root, khác staging + sales (OpenAI fp $(fp OPENAI_API_KEY "$ENV_FILE"))"

step "1. Bản chụp plugin + skill + workspace của commit $(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain -- plugin skills workspace production)" ] || die "plugin/skills/workspace/production có thay đổi chưa commit"
mkdir -p "$DIR/openclaw-state" "$DIR/build"
rm -rf "$DIR/build/plugin-build" "$DIR/build/skills" "$DIR/build/workspace"
cp -r plugin/kido-recruitment/. "$DIR/build/plugin-build/"
rm -rf "$DIR/build/plugin-build/node_modules" "$DIR/build/plugin-build/dist"
cp -r skills "$DIR/build/skills"
cp -r workspace "$DIR/build/workspace"
git rev-parse HEAD > "$DIR/build/SOURCE_COMMIT"

step "2. Build + test + validate plugin (Node 24 trong image OpenClaw)"
docker run --rm -u 0 -e HOME=/tmp/home -e NODE_ENV=development \
  -v "$DIR/build/plugin-build:/work" -w /work --entrypoint sh "$OPENCLAW_IMAGE" -c \
  'npm install --include=dev --no-audit --no-fund >/dev/null && npm test 2>&1 | tail -4 && npm run plugin:validate 2>&1 | tail -2'

step "3. OpenClaw: onboarding (lần đầu), plugin, cấu hình khoá chặt"
chown -R 1000:1000 "$DIR/openclaw-state"
if [ ! -f "$DIR/openclaw-state/openclaw.json" ]; then
  "${DC[@]}" --profile cli run --rm -T openclaw-cli onboard --non-interactive --accept-risk --skip-health \
    --mode local --auth-choice skip --secret-input-mode ref \
    --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
    --skip-channels --skip-daemon --skip-search --skip-hooks --skip-ui --skip-skills \
    --workspace /home/node/.openclaw/workspace >/dev/null
fi
"${DC[@]}" --profile cli run --rm -T openclaw-cli plugins install --link --force --accept-capabilities \
  /opt/kido/plugins/kido-recruitment >/dev/null
"${DC[@]}" --profile cli run --rm -T -v "$PWD/production/openclaw.batch.json:/tmp/batch.json:ro" \
  openclaw-cli config set --batch-file /tmp/batch.json >/dev/null
for path in gateway.bind plugins.entries.kido-recruitment.config.baseUrl agents.defaults.model.primary \
            tools.profile tools.alsoAllow tools.codeMode.enabled tools.toolSearch tools.elevated.enabled browser.enabled; do
  echo "  $path = $("${DC[@]}" --profile cli run --rm -T openclaw-cli config get "$path" 2>/dev/null | tail -1)"
done

if [ "$VERIFY" = 1 ]; then
  step "4. Kiểm tra: khởi động → healthy → audit → cổng chỉ loopback → DỪNG lại"
  "${DC[@]}" up -d openclaw-gateway >/dev/null
  for _ in $(seq 1 60); do
    "${DC[@]}" ps openclaw-gateway --format '{{.Status}}' | grep -q healthy && break
    timeout 3 tail -f /dev/null || true
  done
  echo "  trạng thái: $("${DC[@]}" ps openclaw-gateway --format '{{.Status}}')"
  echo "  cổng publish: $(docker port kido-recruiter-prod-openclaw-gateway-1 | tr '\n' ' ')"
  echo "  security audit: $("${DC[@]}" exec -T openclaw-gateway openclaw security audit 2>&1 | sed -n 1,2p | tr '\n' ' ')"
  "${DC[@]}" stop openclaw-gateway >/dev/null
  echo "  đã dừng gateway (chờ duyệt ufw)."
fi
echo
echo "Xong phần chuẩn bị. Gateway KHÔNG chạy. Bước tiếp: duyệt + áp 2 luật ufw (README.md), rồi up -d."
