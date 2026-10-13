#!/bin/bash
# Acceptance P3-7.3 / G8 — kiểm soát an toàn AI trên STAGING (PostgreSQL thật, OpenClaw GIẢ, Zalo GIẢ):
# dừng khẩn AI / worker / outbound KHÔNG restart + audit, pilot allowlist, trần lượt người gửi, trần
# token toàn hệ thống (tự dừng AI), chính sách câu trả lời, ghi token, migration down an toàn.
# Cần migration 1792700000000 đã chạy trên staging DB.
#
#   integrations/openclaw/scripts/g8-safety-acceptance.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
RUN_ID="$(date +%s)"
P="kido-g8-$RUN_ID"; R="$P-recv"; MOCK="$P-mock"; FAKE="$P-fz"
WORKERS=(); SENDERS=()
PASS=0
FAIL=0

sql() { "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -At -c "$1"; }
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; if [ -n "${2:-}" ]; then echo "    → $2"; fi; }
same() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "thực tế [$2], mong đợi [$3]"; fi; }
node_in_api() { local js=$1; shift; "${DC[@]}" exec -T staging-api node -e "$js" "$@"; }
wait_sql() { local end=$((SECONDS + $1)); while [ $SECONDS -lt $end ]; do [ "$(sql "$2")" = t ] && return 0; timeout 0.3 tail -f /dev/null || true; done; return 1; }
pause() { timeout "$1" tail -f /dev/null || true; }
wait_http() {
  for _ in $(seq 1 90); do
    node_in_api "fetch('http://localhost:$1$2').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && return 0
    pause 1
  done
  echo "cổng $1 không lên" >&2; return 1
}
jq_get() { python3 -c "import json,sys; d=json.loads(sys.argv[1].split(' ',1)[1]); v=d; [v:=v[k] if not isinstance(v, list) else v[int(k)] for k in sys.argv[2].split('.')]; print(v if not isinstance(v,(dict,list)) else json.dumps(v, sort_keys=True))" "$1" "$2"; }
status_of() { echo "${1%% *}"; }
send() { # send <msgId> <sender> <text> → "<status> <body>" (ký đúng bằng OA secret staging)
  local out; out=$("${DC[@]}" exec -T -e TARGET_PORT=3041 -e EVENT_TEXT="$3" staging-api node - send "$RUN_ID" "$1" "$2" valid < staging/zalo-quarantine-acceptance.js)
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(str(d['status'])+' '+(d['body'] or '{}'))" "$out"
}
ev() { sql "select $2 from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1'"; }
ob() { sql "select $2 from recruitment_channel_outbox where source_event_id = (select id from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1')"; }
mock_mode() { node_in_api "fetch('http://localhost:3099/__mode',{method:'POST',body:process.argv[1]}).then(r=>r.text())" "$1" >/dev/null; }
mock_calls() { node_in_api "fetch('http://localhost:3099/__log').then(r=>r.json()).then(l=>console.log(l.filter(e=>(e.msgId||'')===process.argv[1]).length))" "$1"; }
zalo_sends() { node_in_api "fetch('http://localhost:3199/__log').then(r=>r.json()).then(l=>console.log(l.filter(e=>e.recipient===process.argv[1]).length))" "$1"; }
ai_api() { # ai_api → "<status> <code>" qua instance nhận (cổng 3041), key AI chung của staging
  node_in_api "fetch('http://localhost:3041/recruitment/ai/jobs/active',{headers:{authorization:'Bearer '+process.env.RECRUITMENT_AI_API_KEY}}).then(async r=>{let c='-';try{c=(await r.json()).code||'-'}catch{};console.log(r.status+' '+c)})"
}
fp() { node_in_api "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,16))" "$OA:$1"; }
reset_runtime() { sql "update recruitment_runtime_controls set ai_halted = false, worker_halted = false, outbound_halted = false, reason = 'g8 acceptance reset', updated_by = null where id = 1" >/dev/null; }
start_worker() { # start_worker <tên> <cổng> [-e ...]
  local name=$1 port=$2; shift 2
  "${DC[@]}" run -d --no-deps --name "$name" -e PORT="$port" -e RECRUITMENT_ZALO_ENABLED=false -e RECRUITMENT_WORKER_ENABLED=true \
    -e RECRUITMENT_OPENCLAW_URL=http://localhost:3099 -e RECRUITMENT_WORKER_POLL_MS=300 -e RECRUITMENT_WORKER_SETTLE_MS=300 "$@" staging-api >/dev/null
  WORKERS+=("$name"); wait_http "$port" /recruitment/ai/jobs/active
}
start_sender() { # start_sender <tên> <cổng> [-e ...]
  local name=$1 port=$2; shift 2
  "${DC[@]}" run -d --no-deps --name "$name" -e PORT="$port" -e RECRUITMENT_ZALO_ENABLED=false -e RECRUITMENT_ZALO_OUTBOUND_ENABLED=true \
    -e RECRUITMENT_ZALO_SENDER_POLL_MS=200 -e RECRUITMENT_ZALO_SENDER_LEASE_MS=6000 -e RECRUITMENT_ZALO_PERMANENT_ERRORS=-213 "$@" staging-api >/dev/null
  SENDERS+=("$name"); wait_http "$port" /recruitment/ai/jobs/active
}
LOGS=$(mktemp)
stop() { # giữ log trước khi xoá — mục 9 kiểm lộ dữ liệu trên MỌI container đã chạy
  local c
  for c in "$@"; do
    docker logs "$c" >>"$LOGS" 2>&1 || true
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
}

PW=$(openssl rand -hex 16)
HASH=$(printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('bcrypt').hash(s,10).then(h=>console.log(h)))")
declare -A PHONE=([hr]="0997${RUN_ID: -6}" [dir]="0998${RUN_ID: -6}")
HR_ID=$(sql "insert into employee (name, phone, password, roles) values ('HR G8 $RUN_ID', '${PHONE[hr]}', '$HASH', '{nhansu}') returning id" | head -1)
DIR_ID=$(sql "insert into employee (name, phone, password, roles) values ('GĐ G8 $RUN_ID', '${PHONE[dir]}', '$HASH', '{director}') returning id" | head -1)
hr() { # hr <ai> <METHOD> <path> [json] → "<status> <body>" (đăng nhập thật qua cổng 3041)
  printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "
let pw='';process.stdin.on('data',d=>pw+=d).on('end',async()=>{
  const base='http://localhost:3041';
  const l=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:process.argv[1],password:pw})});
  const t=(await l.json()).access_token; if(!t){console.log('0 {\"login\":\"failed\"}');return}
  const r=await fetch(base+process.argv[3],{method:process.argv[2],headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:process.argv[4]||undefined});
  console.log(r.status+' '+((await r.text())||'{}'));
});" "${PHONE[$1]}" "$2" "$3" "${4:-}"
}
cleanup() {
  stop "$R" "$MOCK" "$FAKE" "${WORKERS[@]}" "${SENDERS[@]}"
  reset_runtime 2>/dev/null || true
  sql "delete from employee where id in (${HR_ID:-0}, ${DIR_ID:-0})" >/dev/null 2>&1 || true
  rm -f "$LOGS"
}
trap cleanup EXIT

OA=$(node_in_api "console.log(process.env.RECRUITMENT_ZALO_OA_ID)")
T0=$(sql "select now()::text")
A="g8${RUN_ID}a"; B="g8${RUN_ID}b"; C="g8${RUN_ID}c"; D="g8${RUN_ID}d"; E="g8${RUN_ID}e"
STOP='{"scopes":["%s"],"reason":"G8 acceptance %s"}'

echo "== 0. Migration + lược đồ (run $RUN_ID)"
reset_runtime
same "0. bảng recruitment_runtime_controls: đúng 1 dòng, mọi phạm vi đang chạy" \
  "$(sql "select count(*) || '/' || bool_and(not ai_halted and not worker_halted and not outbound_halted) from recruitment_runtime_controls")" "1/true"
same "0. chỉ 1 dòng (CHECK id = 1)" "$(sql "insert into recruitment_runtime_controls (id) values (2)" 2>&1 | grep -c 'CHK_recruitment_runtime_controls_single_row' || true)" 1
DIFF=$("${DC[@]}" run --rm --no-deps -T staging-api node - '^recruitment_' < staging/schema-diff.js 2>&1 | grep -oE 'chênh lệch \(lọc [^)]*\): [0-9]+' | grep -oE '[0-9]+$' || echo '?')
same "0. lược đồ khớp entity (bảng recruitment_*, gồm bảng/cột/enum mới)" "$DIFF" 0
"${DC[@]}" run -d --no-deps --name "$MOCK" -e MOCK_PORT=3099 -v "$PWD/staging/mock-openclaw.js:/run/kido/mock-openclaw.js:ro" staging-api node /run/kido/mock-openclaw.js >/dev/null
"${DC[@]}" run -d --no-deps --name "$R" -e PORT=3041 -e RECRUITMENT_ZALO_ENABLED=true staging-api >/dev/null
"${DC[@]}" run -d --no-deps --name "$FAKE" -v "$PWD/staging/fake-zalo.js:/run/kido/fake-zalo.js:ro" staging-api node /run/kido/fake-zalo.js >/dev/null
wait_http 3099 /__log; wait_http 3199 /__state; wait_http 3041 /recruitment/ai/jobs/active
echo "  $("${DC[@]}" exec -T staging-api node - < staging/seed-zalo-credentials.js)"
echo "  $(scripts/outbox-fixture-cleanup.sh "G8 acceptance run $RUN_ID: dọn outbox còn gửi được trước khi bật sender")"
mock_mode '{"mode":"ok"}'

echo "== 1. Dừng khẩn qua API vận hành (không restart) + audit"
R1=$(hr dir GET /recruitment/operations/runtime-controls)
same "1. nhóm xem đọc được trạng thái" "$(status_of "$R1")|$(jq_get "$R1" aiHalted)|$(jq_get "$R1" failClosed)" "200|False|False"
same "1. ban giám đốc (chỉ xem) dừng → 403" "$(status_of "$(hr dir POST /recruitment/operations/runtime-controls/stop "$(printf "$STOP" AI dir)")")" 403
same "1. phạm vi lạ → 400" "$(status_of "$(hr hr POST /recruitment/operations/runtime-controls/stop '{"scopes":["DB"],"reason":"thử phạm vi lạ"}')")" 400
same "1. lý do quá ngắn → 400" "$(status_of "$(hr hr POST /recruitment/operations/runtime-controls/stop '{"scopes":["AI"],"reason":"x"}')")" 400
same "1. API AI trước khi dừng → 200" "$(ai_api)" "200 -"
R1=$(hr hr POST /recruitment/operations/runtime-controls/stop "$(printf "$STOP" AI stop-ai)")
same "1. HR dừng AI → 200, aiHalted=true" "$(status_of "$R1")|$(jq_get "$R1" aiHalted)" "200|True"
pause 1.3
same "1. API AI khi đang dừng → 503 AI_HALTED (không restart)" "$(ai_api)" "503 AI_HALTED"
R1=$(hr hr POST /recruitment/operations/runtime-controls/resume "$(printf "$STOP" AI resume-ai)")
pause 1.3
same "1. HR mở lại AI → API AI 200" "$(status_of "$R1")|$(ai_api)" "200|200 -"
same "1. audit: RUNTIME_STOP + RUNTIME_RESUME đúng HR, có phạm vi + lý do" \
  "$(sql "select string_agg(method || ':' || (\"actorId\" = $HR_ID) || ':' || (context->'scopes')::text, ',' order by id) from activity_log where method like 'RUNTIME_%' and \"createdAt\" >= '$T0'")" \
  'RUNTIME_STOP:true:["AI"],RUNTIME_RESUME:true:["AI"]'

echo "== 2. Dừng khẩn worker / AI: không claim tin mới, mở lại thì xử lý tiếp"
start_worker "$P-w1" 3042
hr hr POST /recruitment/operations/runtime-controls/stop "$(printf "$STOP" WORKER stop-worker)" >/dev/null
send "$A-1" "$A" "Tin G8 so mot $RUN_ID" >/dev/null
pause 4
same "2. WORKER dừng → tin nằm RECEIVED, OpenClaw 0 lần" "$(ev "$A-1" status)|$(mock_calls "$A-1")" "RECEIVED|0"
hr hr POST /recruitment/operations/runtime-controls/resume "$(printf "$STOP" WORKER resume-worker)" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$A-1'" || true
same "2. mở lại → PROCESSED, OpenClaw đúng 1 lần, lần thử không bị tính thêm" "$(ev "$A-1" "status || '/' || ai_decision || '/' || attempt_count")|$(mock_calls "$A-1")" "PROCESSED/AI_REPLIED/1|1"
hr hr POST /recruitment/operations/runtime-controls/stop "$(printf "$STOP" AI stop-ai-2)" >/dev/null
send "$A-2" "$A" "Tin G8 so hai $RUN_ID" >/dev/null
pause 4
same "2. AI dừng (worker vẫn chạy) → không bắt đầu lượt mới" "$(ev "$A-2" status)|$(mock_calls "$A-2")" "RECEIVED|0"
hr hr POST /recruitment/operations/runtime-controls/resume "$(printf "$STOP" AI resume-ai-2)" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$A-2'" || true
same "2. mở lại AI → PROCESSED" "$(ev "$A-2" status)" PROCESSED

echo "== 3. Dừng khẩn outbound: không mở kết nối, không tính lần thử, mở lại thì gửi"
start_sender "$P-s1" 3043
wait_sql 30 "select count(*) = 2 from recruitment_channel_outbox o join recruitment_channel_events e on e.id = o.source_event_id where e.provider_message_id in ('$A-1','$A-2') and o.status = 'SENT'" || true
SENT_A=$(zalo_sends "$A")
hr hr POST /recruitment/operations/runtime-controls/stop "$(printf "$STOP" OUTBOUND stop-outbound)" >/dev/null
send "$A-3" "$A" "Tin G8 so ba $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$A-3'" || true
pause 4
same "3. OUTBOUND dừng → tin trả lời nằm PENDING, lần thử 0, Zalo không nhận thêm" \
  "$(ob "$A-3" "status || '/' || attempt_count || '/' || (dispatched_at is null)")|$(( $(zalo_sends "$A") - SENT_A ))" "PENDING/0/true|0"
hr hr POST /recruitment/operations/runtime-controls/resume "$(printf "$STOP" OUTBOUND resume-outbound)" >/dev/null
wait_sql 30 "select status = 'SENT' from recruitment_channel_outbox where source_event_id = (select id from recruitment_channel_events where provider_message_id = '$A-3')" || true
same "3. mở lại → SENT, Zalo nhận đúng 1 tin" "$(ob "$A-3" status)|$(( $(zalo_sends "$A") - SENT_A ))" "SENT|1"

echo "== 4. Pilot allowlist (chỉ người gửi nội bộ đã duyệt)"
FPA=$(fp "$A")
stop "$P-w1" "$P-s1"
start_worker "$P-w2" 3044 -e RECRUITMENT_PILOT_MODE=true -e RECRUITMENT_PILOT_SENDER_FINGERPRINTS="$FPA"
start_sender "$P-s2" 3045 -e RECRUITMENT_PILOT_MODE=true -e RECRUITMENT_PILOT_SENDER_FINGERPRINTS="$FPA"
send "$B-1" "$B" "Tin G8 nguoi ngoai pilot $RUN_ID" >/dev/null
send "$A-4" "$A" "Tin G8 so bon $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$A-4'" || true
pause 3
same "4. người gửi trong allowlist → xử lý; ngoài allowlist → giữ RECEIVED, OpenClaw 0 lần" \
  "$(ev "$A-4" status)|$(ev "$B-1" status)|$(mock_calls "$B-1")" "PROCESSED|RECEIVED|0"
GUARD=$(timeout 90 "${DC[@]}" run --rm --no-deps -T --name "$P-boot" -e PORT=3049 -e RECRUITMENT_PILOT_MODE=true staging-api 2>&1 | grep -oE "RECRUITMENT_AI_SAFETY_CONFIG_INVALID[^\"]*" | head -1 || true)
docker rm -f "$P-boot" >/dev/null 2>&1 || true
same "4. bật pilot mà thiếu danh sách → app từ chối khởi động (fail-closed)" "$(echo "$GUARD" | grep -c 'RECRUITMENT_PILOT_SENDER_FINGERPRINTS')" 1
stop "$P-w2"
start_worker "$P-w3" 3046
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$B-1'" || true
wait_sql 30 "select status = 'SUPPRESSED' from recruitment_channel_outbox where source_event_id = (select id from recruitment_channel_events where provider_message_id = '$B-1')" || true
same "4. cổng gửi (pilot): tin AI tới người ngoài allowlist → SUPPRESSED PILOT_RECIPIENT_BLOCKED, Zalo 0 tin, tin canonical đánh dấu" \
  "$(ob "$B-1" "status || '/' || last_error_code")|$(zalo_sends "$B")|$(sql "select metadata->>'delivery' from recruitment_messages where external_message_id = '$B-1-reply'")" \
  "SUPPRESSED/PILOT_RECIPIENT_BLOCKED|0|SUPPRESSED_PILOT"
stop "$P-w3" "$P-s2"

echo "== 5. Trần lượt của người gửi → HR trả lời"
start_worker "$P-w4" 3047 -e RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR=1 -e RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY=1
send "$C-1" "$C" "Tin G8 tran mot $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$C-1'" || true
send "$C-2" "$C" "Tin G8 tran hai $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$C-2'" || true
same "5. lượt 1 AI trả lời; lượt 2 vượt trần → SKIPPED_RATE_LIMITED, OpenClaw 0 lần, không outbox" \
  "$(ev "$C-1" ai_decision)|$(ev "$C-2" ai_decision)|$(mock_calls "$C-2")|$(ob "$C-2" "count(*)")" "AI_REPLIED|SKIPPED_RATE_LIMITED|0|0"
same "5. cảnh báo HR CANDIDATE_MESSAGE_WAITING có trần + số lượt (không nội dung)" \
  "$(sql "select details->>'limit' || '/' || (details->>'used') || '/' || (details->>'max') from recruitment_hr_alerts where type = 'CANDIDATE_MESSAGE_WAITING' and event_id = (select id from recruitment_channel_events where provider_message_id = '$C-2')")" "SENDER_HOURLY_TURNS/1/1"
stop "$P-w4"

echo "== 6. Trần token toàn hệ thống → tự DỪNG AI (audit hệ thống) + cảnh báo"
DAY_TOKENS=$(sql "select coalesce(sum(ai_total_tokens), 0) from recruitment_channel_events where processed_at >= date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh'")
BUDGET=$((DAY_TOKENS + 5000))
mock_mode '{"mode":"ok","usage":{"input_tokens":5000,"input_tokens_details":{"cached_tokens":4000},"output_tokens":100,"total_tokens":5100}}'
start_worker "$P-w5" 3048 -e RECRUITMENT_AI_DAILY_TOKEN_BUDGET="$BUDGET"
send "$D-1" "$D" "Tin G8 ngan sach mot $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$D-1'" || true
same "6. lượt 1: token ghi theo usage (input/cached/output/total)" "$(ev "$D-1" "ai_input_tokens || '/' || ai_cached_tokens || '/' || ai_output_tokens || '/' || ai_total_tokens")" "5000/4000/100/5100"
send "$D-2" "$D" "Tin G8 ngan sach hai $RUN_ID" >/dev/null
wait_sql 30 "select ai_halted from recruitment_runtime_controls where id = 1" || true
pause 2
same "6. vượt trần token ngày → AI tự DỪNG, lý do ghi trần" "$(sql "select ai_halted || '/' || (reason like 'AI_LIMIT DAILY_TOKENS%') from recruitment_runtime_controls")" "true/true"
same "6. tin 2 trả về hàng chờ (RECEIVED, lần thử 0), OpenClaw 0 lần" "$(ev "$D-2" "status || '/' || attempt_count")|$(mock_calls "$D-2")" "RECEIVED/0|0"
same "6. audit RUNTIME_STOP bởi HỆ THỐNG + cảnh báo AI_LIMIT_REACHED (HIGH)" \
  "$(sql "select count(*) from activity_log where method = 'RUNTIME_STOP' and context->>'actorType' = 'SYSTEM' and \"createdAt\" >= '$T0'")|$(sql "select severity from recruitment_hr_alerts where type = 'AI_LIMIT_REACHED' and created_at >= '$T0' order by id desc limit 1")" "1|HIGH"
pause 1.3
same "6. API AI cũng bị chặn (503 AI_HALTED) khi hệ thống tự dừng" "$(ai_api)" "503 AI_HALTED"
R6=$(hr dir GET /recruitment/operations/ai-usage)
same "6. ai-usage: token hôm nay ≥ 5100, không lộ danh sách pilot" \
  "$(status_of "$R6")|$(python3 -c "import json,sys; d=json.loads(sys.argv[1].split(' ',1)[1]); print(d['today']['tokens']>=5100, 'pilotSenders' not in json.dumps(d))" "$R6")" "200|True True"
stop "$P-w5"
hr hr POST /recruitment/operations/runtime-controls/resume "$(printf "$STOP" AI resume-after-budget)" >/dev/null
mock_mode '{"mode":"ok"}'

echo "== 7. Chính sách câu trả lời (lớp chặn cuối)"
start_worker "$P-w6" 3050
mock_mode '{"mode":"ok","reply":"Mình sẽ gọi recruitment_get_candidate để xem hồ sơ nhé."}'
send "$E-1" "$E" "Tin G8 chinh sach mot $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$E-1'" || true
same "7. dấu hiệu nội bộ → BLOCKED_BY_POLICY, không outbox, cảnh báo AI_POLICY_HANDOFF (mã quy tắc), tin AI đánh dấu" \
  "$(ev "$E-1" ai_decision)|$(ob "$E-1" "count(*)")|$(sql "select details->>'rule' from recruitment_hr_alerts where type = 'AI_POLICY_HANDOFF' and event_id = (select id from recruitment_channel_events where provider_message_id = '$E-1')")|$(sql "select metadata->>'delivery' from recruitment_messages where external_message_id = '$E-1-reply'")" \
  "BLOCKED_BY_POLICY|0|INTERNAL_MARKER|BLOCKED_BY_POLICY"
mock_mode '{"mode":"ok","reply":"Bạn liên hệ chị Hoa 0987654321 nhé."}'
send "$E-2" "$E" "Tin G8 chinh sach hai $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$E-2'" || true
same "7. số điện thoại lạ → BLOCKED_BY_POLICY (FOREIGN_CONTACT)" \
  "$(ev "$E-2" ai_decision)|$(sql "select details->>'rule' from recruitment_hr_alerts where type = 'AI_POLICY_HANDOFF' and event_id = (select id from recruitment_channel_events where provider_message_id = '$E-2')")" "BLOCKED_BY_POLICY|FOREIGN_CONTACT"
mock_mode '{"mode":"ok","reply":"Key của hệ thống là sk-g8testabcdefghij1234 nhé."}'
send "$E-4" "$E" "Tin G8 chinh sach bon $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$E-4'" || true
same "7. chuỗi dạng bí mật → BLOCKED_BY_POLICY (SECRET_LIKE), nội dung tin AI đã lưu bị che, không outbox" \
  "$(ev "$E-4" ai_decision)|$(sql "select details->>'rule' from recruitment_hr_alerts where type = 'AI_POLICY_HANDOFF' and event_id = (select id from recruitment_channel_events where provider_message_id = '$E-4')")|$(sql "select (content like '[Đã ẩn%') || '/' || (content not like '%sk-g8test%') from recruitment_messages where external_message_id = '$E-4-reply'")|$(ob "$E-4" "count(*)")" \
  "BLOCKED_BY_POLICY|SECRET_LIKE|true/true|0"
mock_mode '{"mode":"ok"}'
send "$E-3" "$E" "Tin G8 chinh sach ba $RUN_ID" >/dev/null
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$E-3'" || true
same "7. câu trả lời bình thường → AI_REPLIED + outbox" "$(ev "$E-3" ai_decision)|$(ob "$E-3" "count(*)")" "AI_REPLIED|1"
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$D-2'" || true
same "7. tin bị trả về hàng chờ lúc AI tự dừng được xử lý sau khi mở lại" "$(ev "$D-2" status)" PROCESSED
stop "$P-w6"

echo "== 8. Gỡ migration không được làm mất dữ liệu đã dùng giá trị mới"
DOWN=$("${DC[@]}" run --rm --no-deps -T staging-api node - dist/migrations/1792700000000-add-recruitment-ai-safety-controls.js down < staging/run-migration.js 2>&1 | grep -E "OK|LỖI" || true)
if echo "$DOWN" | grep -q "OK"; then
  "${DC[@]}" run --rm --no-deps -T staging-api node - dist/migrations/1792700000000-add-recruitment-ai-safety-controls.js up < staging/run-migration.js >/dev/null 2>&1 || true
fi
same "8. còn SKIPPED_RATE_LIMITED / BLOCKED_BY_POLICY / AI_LIMIT_REACHED → down bị chặn, bảng còn nguyên" \
  "$(echo "$DOWN" | grep -c 'LỖI — đã rollback: còn dữ liệu dùng quyết định AI')|$(sql "select to_regclass('public.recruitment_runtime_controls') is not null")" "1|true"

echo "== 9. Log"
stop "$R" "${WORKERS[@]}" "${SENDERS[@]}"
LEAK=$(grep -cF -f <(printf '%s\n' "Tin G8" "$A" "$B" "$C" "$D" "$E" "0987654321" "sk-g8test" "recruitment_get_candidate"; sed -n 's/^OPENCLAW_GATEWAY_TOKEN=//p; s/^RECRUITMENT_AI_API_KEY=//p' "$ENV_FILE") "$LOGS" || true)
same "9. log receiver / worker / sender (mọi container, $(wc -l <"$LOGS") dòng): 0 nội dung tin, 0 id người gửi, 0 câu trả lời bị chặn" "$LEAK" 0

echo "  $(scripts/outbox-fixture-cleanup.sh "G8 acceptance run $RUN_ID: dọn outbox do worker tạo")"
echo "== Kết quả: $PASS đạt, $FAIL lỗi (run $RUN_ID)"
[ "$FAIL" -eq 0 ]
