#!/bin/bash
# Acceptance P3-7.3 R1 — người vận hành loại event inbox (tin thử) khỏi xử lý nghiệp vụ, giữ audit.
# Staging (PostgreSQL thật), OpenClaw GIẢ. Request ký bằng OA secret của staging.
#
#   integrations/openclaw/scripts/channel-event-exclude-acceptance.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
RUN_ID="$(date +%s)"
R="kido-r1-recv-$RUN_ID"; W="kido-r1-w-$RUN_ID"; MOCK="kido-r1-mock-$RUN_ID"
PASS=0
FAIL=0

sql() { "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -At -c "$1"; }
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; if [ -n "${2:-}" ]; then echo "    → $2"; fi; }
same() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "thực tế [$2], mong đợi [$3]"; fi; }
node_in_api() { local js=$1; shift; "${DC[@]}" exec -T staging-api node -e "$js" "$@"; }
wait_sql() { local end=$((SECONDS + $1)); while [ $SECONDS -lt $end ]; do [ "$(sql "$2")" = t ] && return 0; timeout 0.3 tail -f /dev/null || true; done; return 1; }
wait_http() {
  for _ in $(seq 1 90); do
    node_in_api "fetch('http://localhost:$1$2').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && return 0
    timeout 1 tail -f /dev/null || true
  done
  echo "cổng $1 không lên" >&2; return 1
}
jq_get() { python3 -c "import json,sys; d=json.loads(sys.argv[1].split(' ',1)[1]); v=d; [v:=v[k] if not isinstance(v, list) else v[int(k)] for k in sys.argv[2].split('.')]; print(v if not isinstance(v,(dict,list)) else json.dumps(v, sort_keys=True))" "$1" "$2"; }
status_of() { echo "${1%% *}"; }
# send <msgId> <sender> → "<status> <body>" (ký đúng bằng OA secret staging, cùng request → byte y hệt)
send() {
  local out; out=$("${DC[@]}" exec -T -e TARGET_PORT=3031 -e EVENT_TEXT="$3" staging-api node - send "$RUN_ID" "$1" "$2" valid < staging/zalo-quarantine-acceptance.js)
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(str(d['status'])+' '+(d['body'] or '{}'))" "$out"
}
ev() { sql "select $2 from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1'"; }
mock_calls() { node_in_api "fetch('http://localhost:3099/__log').then(r=>r.json()).then(l=>console.log(l.filter(e=>(e.msgId||'').startsWith(process.argv[1])).length))" "$1"; }

PW=$(openssl rand -hex 16)
HASH=$(printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('bcrypt').hash(s,10).then(h=>console.log(h)))")
declare -A PHONE=([hr]="0995${RUN_ID: -6}" [dir]="0996${RUN_ID: -6}")
HR_ID=$(sql "insert into employee (name, phone, password, roles) values ('HR R1 $RUN_ID', '${PHONE[hr]}', '$HASH', '{nhansu}') returning id" | head -1)
DIR_ID=$(sql "insert into employee (name, phone, password, roles) values ('GĐ R1 $RUN_ID', '${PHONE[dir]}', '$HASH', '{director}') returning id" | head -1)
# hr <ai> <METHOD> <path> [json body] → "<status> <body>" (đăng nhập thật, mật khẩu qua stdin)
hr() {
  printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "
let pw='';process.stdin.on('data',d=>pw+=d).on('end',async()=>{
  const base='http://localhost:3031';
  const l=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:process.argv[1],password:pw})});
  const t=(await l.json()).access_token; if(!t){console.log('0 {\"login\":\"failed\"}');return}
  const r=await fetch(base+process.argv[3],{method:process.argv[2],headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:process.argv[4]||undefined});
  console.log(r.status+' '+((await r.text())||'{}'));
});" "${PHONE[$1]}" "$2" "$3" "${4:-}"
}
cleanup() {
  docker rm -f "$R" "$W" "$MOCK" >/dev/null 2>&1 || true
  sql "delete from employee where id in (${HR_ID:-0}, ${DIR_ID:-0})" >/dev/null 2>&1 || true
}
trap cleanup EXIT

OA=$(node_in_api "console.log(process.env.RECRUITMENT_ZALO_OA_ID)")
T0=$(sql "select now()::text")
S="r1${RUN_ID}s"; TXT1="Tin thu R1 so mot $RUN_ID"; TXT2="Tin thu R1 so hai $RUN_ID"

echo "== 0. Chuẩn bị (run $RUN_ID)"
PREP=$( { echo "BEGIN;"; python3 - "$(cd ../.. && pwd)" <<'PY'
import re, sys
src = open(f'{sys.argv[1]}/src/recruitment/channels/recruitment-channel-event-operations.service.ts').read()
for i, m in enumerate(re.finditer(r'query(?:<[^`]*?>)?\(\s*`([^`]*)`', src)):
    print(f"PREPARE r1_{i} AS {m.group(1)};")
PY
echo "ROLLBACK;"; } | "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -v ON_ERROR_STOP=1 2>&1)
if echo "$PREP" | grep -q ERROR; then ko "mọi câu SQL của R1 hợp lệ trên schema thật" "$(echo "$PREP" | grep ERROR | head -3)"; else ok "mọi câu SQL của R1 hợp lệ trên schema thật ($(echo "$PREP" | grep -c '^PREPARE') câu)"; fi

"${DC[@]}" run -d --no-deps --name "$MOCK" -e MOCK_PORT=3099 -v "$PWD/staging/mock-openclaw.js:/run/kido/mock-openclaw.js:ro" \
  staging-api node /run/kido/mock-openclaw.js >/dev/null
"${DC[@]}" run -d --no-deps --name "$R" -e PORT=3031 -e RECRUITMENT_ZALO_ENABLED=true staging-api >/dev/null
wait_http 3099 /__log; wait_http 3031 /recruitment/ai/jobs/active
node_in_api "fetch('http://localhost:3099/__mode',{method:'POST',body:JSON.stringify({mode:'ok'})}).then(r=>r.text())" >/dev/null

echo "== 1. Hai tin thử của cùng một người gửi → RECEIVED (worker chưa chạy)"
R1=$(send "$S-1" "$S" "$TXT1"); R2=$(send "$S-2" "$S" "$TXT2")
same "1. webhook ký đúng → 200 ×2, 2 event RECEIVED có nội dung" \
  "$(status_of "$R1")$(status_of "$R2")|$(ev "$S-1" "status || '/' || (normalized_message_text is not null)")|$(ev "$S-2" "status || '/' || (normalized_message_text is not null)")" "200200|RECEIVED/true|RECEIVED/true"
E1=$(ev "$S-1" id); E2=$(ev "$S-2" id)
META_BEFORE=$(ev "$S-1" "external_sender_id || '|' || dedupe_key || '|' || payload_hash || '|' || received_at::text || '|' || coalesce(provider_created_at::text,'-')")

echo "== 2. Loại tin thử #1 (HR vận hành)"
RES=$(hr hr POST "/recruitment/operations/events/$E1/exclude" '{"reason":"TEST_MESSAGE"}')
same "2. HR → 200: IGNORED, failureCode TEST_MESSAGE, hết nội dung, idempotent=false" \
  "$(status_of "$RES")|$(jq_get "$RES" status)|$(jq_get "$RES" failureCode)|$(jq_get "$RES" hasText)|$(jq_get "$RES" idempotent)" "200|IGNORED|TEST_MESSAGE|False|False"
same "2. DB: IGNORED + TEST_MESSAGE, nội dung NULL, text_redacted_at + processed_at có, không lease/lịch thử" \
  "$(ev "$S-1" "status || '/' || failure_code || '/' || (normalized_message_text is null) || '/' || (text_redacted_at is not null) || '/' || (processed_at is not null) || '/' || (lease_until is null and next_attempt_at is null)")" \
  "IGNORED/TEST_MESSAGE/true/true/true/true"
same "2. metadata giữ nguyên để audit (người gửi, dedupe key, payload hash, thời điểm)" \
  "$(ev "$S-1" "external_sender_id || '|' || dedupe_key || '|' || payload_hash || '|' || received_at::text || '|' || coalesce(provider_created_at::text,'-')")" "$META_BEFORE"
same "2. tin #2 không bị đụng (vẫn RECEIVED, còn nội dung)" "$(ev "$S-2" "status || '/' || (normalized_message_text is not null)")" "RECEIVED/true"
RES=$(hr hr POST "/recruitment/operations/events/$E1/exclude" '{"reason":"TEST_MESSAGE"}')
same "2. gọi lại cùng lý do → 200 idempotent=true" "$(status_of "$RES")|$(jq_get "$RES" idempotent)" "200|True"
same "2. audit CHANNEL_EVENT_EXCLUDE: đúng 1 dòng, đúng HR, context không chứa nội dung" \
  "$(sql "select count(*) || '/' || bool_and(\"actorId\" = $HR_ID) || '/' || bool_and(context::text not like '%R1 so%' and context->>'reason' = 'TEST_MESSAGE' and (context->>'textRemoved')::boolean) from activity_log where method = 'CHANNEL_EVENT_EXCLUDE' and \"createdAt\" >= '$T0'")" "1/true/true"

echo "== 3. Phân quyền / đầu vào"
same "3. ban giám đốc (chỉ xem) loại event → 403" "$(status_of "$(hr dir POST "/recruitment/operations/events/$E2/exclude" '{"reason":"TEST_MESSAGE"}')")" 403
same "3. lý do không định nghĩa → 400, không đổi gì" "$(status_of "$(hr hr POST "/recruitment/operations/events/$E2/exclude" '{"reason":"SPAM"}')")|$(ev "$S-2" status)" "400|RECEIVED"
same "3. event không tồn tại → 404 CHANNEL_EVENT_NOT_FOUND" "$(RES=$(hr hr POST /recruitment/operations/events/999999999/exclude '{"reason":"TEST_MESSAGE"}'); echo "$(status_of "$RES")/$(jq_get "$RES" code)")" "404/CHANNEL_EVENT_NOT_FOUND"

echo "== 4. Chống trùng: Zalo gửi lại tin đã loại"
RES=$(send "$S-1" "$S" "$TXT1")
same "4. gửi lại đúng request → 200 duplicate=true; vẫn 1 event, vẫn IGNORED, không nội dung" \
  "$(status_of "$RES")|$(jq_get "$RES" duplicate)|$(sql "select count(*) from recruitment_channel_events where provider_message_id = '$S-1'")|$(ev "$S-1" "status || '/' || (normalized_message_text is null)")" "200|True|1|IGNORED/true"

echo "== 5. Worker bỏ qua tin đã loại, vẫn xử lý tin sau của cùng người gửi"
"${DC[@]}" run -d --no-deps --name "$W" -e PORT=3032 -e RECRUITMENT_ZALO_ENABLED=false -e RECRUITMENT_WORKER_ENABLED=true \
  -e RECRUITMENT_OPENCLAW_URL=http://localhost:3099 -e RECRUITMENT_WORKER_POLL_MS=300 -e RECRUITMENT_WORKER_SETTLE_MS=500 staging-api >/dev/null
wait_http 3032 /recruitment/ai/jobs/active
wait_sql 60 "select status = 'PROCESSED' from recruitment_channel_events where id = $E2" || true
same "5. tin #2 → PROCESSED (OpenClaw 1 lần); tin #1 vẫn IGNORED/TEST_MESSAGE (OpenClaw 0 lần)" \
  "$(ev "$S-2" status)|$(mock_calls "$S-2")|$(ev "$S-1" "status || '/' || failure_code")|$(mock_calls "$S-1")" "PROCESSED|1|IGNORED/TEST_MESSAGE|0"
same "5. không cảnh báo HR nào cho tin đã loại" "$(sql "select count(*) from recruitment_hr_alerts where event_id = $E1")" 0
same "5. tin #1 không tạo hội thoại / tin canonical" "$(ev "$S-1" "coalesce(conversation_id::text, '-')")" "-"
RES=$(hr hr POST "/recruitment/operations/events/$E2/exclude" '{"reason":"TEST_MESSAGE"}')
same "5. loại event đã PROCESSED → 409 CHANNEL_EVENT_NOT_EXCLUDABLE, không đổi" "$(status_of "$RES")/$(jq_get "$RES" code)|$(ev "$S-2" status)" "409/CHANNEL_EVENT_NOT_EXCLUDABLE|PROCESSED"

echo "== 6. Thống kê + log"
RES=$(hr dir GET /recruitment/operations/events/stats)
same "6. thống kê (nhóm xem đọc được): có IGNORED/TEST_MESSAGE ≥ 1, không nội dung tin" \
  "$(status_of "$RES")|$(python3 -c "import json,sys; d=json.loads(sys.argv[1].split(' ',1)[1]); print(sum(r['count'] for r in d['byStatus'] if r['status']=='IGNORED' and r['failureCode']=='TEST_MESSAGE')>=1)" "$RES")|$(echo "$RES" | grep -c 'R1 so' || true)" "200|True|0"
LEAK=$( { docker logs "$R" 2>&1; docker logs "$W" 2>&1; } | grep -cF -e "R1 so mot" -e "R1 so hai" -e "$S" || true)
same "6. log receiver/worker: 0 nội dung tin, 0 id người gửi" "$LEAK" 0

echo "  $(scripts/outbox-fixture-cleanup.sh "P3-7.3 R1 acceptance run $RUN_ID: dọn outbox do worker tạo")"
echo "== Kết quả: $PASS đạt, $FAIL lỗi (run $RUN_ID)"
[ "$FAIL" -eq 0 ]
