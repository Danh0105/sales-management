#!/bin/bash
# Acceptance P3-6 — điều khiển hội thoại (AI_ACTIVE / AI_PAUSED / HUMAN_TAKEOVER / CLOSED),
# tin HR qua outbox, trả lại AI, đóng, tiếp quản giữa lượt AI, đối soát outbox UNKNOWN,
# cảnh báo HR, phân quyền, audit — và P3-6.5: HR tiếp quản chặn mọi tin AI chưa dispatch
# (mục 11) — trên staging (PostgreSQL thật), OpenClaw GIẢ
# (staging/mock-openclaw.js) + Zalo GIẢ (staging/fake-zalo.js). API HR gọi bằng tài khoản
# test thật (đăng nhập /auth/login; mật khẩu ngẫu nhiên mỗi lần chạy, truyền qua stdin).
#
#   integrations/openclaw/scripts/channel-control-acceptance.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(cd ../.. && pwd)"
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
RUN_ID="$(date +%s)"
OA=stg-recruit-oa
MOCK="kido-p36-mock-$RUN_ID"; W="kido-p36-w-$RUN_ID"; FAKE="kido-p36-zalo-$RUN_ID"; S="kido-p36-s-$RUN_ID"
PASS=0
FAIL=0

sql() { "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -At -c "$1"; }
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; if [ -n "${2:-}" ]; then echo "    → $2"; fi; }
same() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "thực tế [$2], mong đợi [$3]"; fi; }
check() { if [ "$2" = t ]; then ok "$1"; else ko "$1" "${3:-}"; fi; }
node_in_api() { local js=$1; shift; "${DC[@]}" exec -T staging-api node -e "$js" "$@"; }
wait_sql() { local end=$((SECONDS + $1)); while [ $SECONDS -lt $end ]; do [ "$(sql "$2")" = t ] && return 0; timeout 0.3 tail -f /dev/null || true; done; return 1; }
wait_http() {
  for _ in $(seq 1 90); do
    node_in_api "fetch('http://localhost:$1$2').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && return 0
    timeout 1 tail -f /dev/null || true
  done
  echo "cổng $1 không lên" >&2; return 1
}
jq_get() { python3 -c "import json,sys; d=json.loads(sys.argv[1].split(' ',1)[1]); v=d; [v:=v[k] if not isinstance(v, list) else v[int(k)] for k in sys.argv[2].split('.')]; print(v if not isinstance(v,(dict,list)) else json.dumps(v))" "$1" "$2"; }
status_of() { echo "${1%% *}"; }

# --- tài khoản test (HR / ban giám đốc chỉ-xem / role ngoài tuyển dụng) -------------------
PW=$(openssl rand -hex 16)
HASH=$(printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('bcrypt').hash(s,10).then(h=>console.log(h)))")
declare -A PHONE=([hr]="0990${RUN_ID: -6}" [dir]="0991${RUN_ID: -6}" [sales]="0992${RUN_ID: -6}")
HR_ID=$(sql "insert into employee (name, phone, password, roles) values ('HR test $RUN_ID', '${PHONE[hr]}', '$HASH', '{nhansu}') returning id" | head -1)
DIR_ID=$(sql "insert into employee (name, phone, password, roles) values ('GĐ test $RUN_ID', '${PHONE[dir]}', '$HASH', '{director}') returning id" | head -1)
SALES_ID=$(sql "insert into employee (name, phone, password, roles) values ('Sales test $RUN_ID', '${PHONE[sales]}', '$HASH', '{sales}') returning id" | head -1)
# hr <ai> <METHOD> <path> [body] → "<status> <body>" (đăng nhập thật, mật khẩu qua stdin)
hr() {
  printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "
let pw='';process.stdin.on('data',d=>pw+=d).on('end',async()=>{
  const base='http://localhost:3021';
  const l=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:process.argv[1],password:pw})});
  const t=(await l.json()).access_token; if(!t){console.log('0 {\"login\":\"failed\"}');return}
  const r=await fetch(base+process.argv[3],{method:process.argv[2],headers:{'content-type':'application/json',authorization:'Bearer '+t},body:process.argv[4]||undefined});
  console.log(r.status+' '+((await r.text())||'{}'));
});" "${PHONE[$1]}" "$2" "$3" "${4:-}"
}
# ai_call <subject> <METHOD> <path> [body] — API AI bằng key KÊNH + subject (như plugin)
ai_call() {
  node_in_api "fetch('http://localhost:3021/recruitment/ai'+process.argv[3],{method:process.argv[2],headers:{'content-type':'application/json',authorization:'Bearer '+process.env.RECRUITMENT_CHANNEL_API_KEY,'x-recruitment-subject':process.argv[1]},body:process.argv[4]||undefined}).then(async r=>console.log(r.status+' '+(await r.text())))" "$1" "$2" "$3" "${4:-}"
}
send_in() { # send_in <msgId> <sender> <text> — webhook có chữ ký thật
  "${DC[@]}" exec -T -e TARGET_PORT=3021 -e "EVENT_TS=$(date +%s%3N)" -e "EVENT_TEXT=$3" staging-api \
    node - send "$RUN_ID" "$1" "$2" < staging/zalo-webhook-acceptance.js >/dev/null
}
ev() { sql "select $2 from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1'"; }
mock() { node_in_api "fetch('http://localhost:3099/__mode',{method:'POST',body:JSON.stringify($1)}).then(r=>r.text())" >/dev/null; }
mock_calls() { node_in_api "fetch('http://localhost:3099/__log').then(r=>r.json()).then(l=>console.log(l.filter(e=>(e.msgId||'').startsWith(process.argv[1])).length))" "$1"; }
fz() { # fz <đường dẫn admin Zalo giả> [object JS]
  local body="${2:-}"; [ -n "$body" ] || body='{}'
  node_in_api "fetch('http://localhost:3199$1',{method:'POST',body:JSON.stringify($body)}).then(r=>r.text())" >/dev/null
}
fz_count() { node_in_api "fetch('http://localhost:3199/__log').then(r=>r.json()).then(l=>{const h=require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,16);console.log(l.filter(e=>e.textSha===h).length)})" "$1"; }
# fz_delivery <nội dung> → "<số lần Zalo nhận 200>/<số lần khác ngoài -216>"
fz_delivery() { node_in_api "fetch('http://localhost:3199/__log').then(r=>r.json()).then(l=>{const h=require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,16);const m=l.filter(e=>e.textSha===h);console.log(m.filter(e=>String(e.result).startsWith('200')).length+'/'+m.filter(e=>!String(e.result).startsWith('200')&&e.result!=='-216').length)})" "$1"; }
ob() { sql "select $2 from recruitment_channel_outbox where id = $1"; }
alerts_for() { sql "select count(*) from recruitment_hr_alerts where type = '$1' and source_key = '$2'"; }
conv_of() { sql "select conversation_id from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1'"; }
wait_event() { wait_sql "${2:-30}" "select status = 'PROCESSED' from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1'" || true; }
ai_ob() { sql "select o.id from recruitment_channel_outbox o join recruitment_channel_events e on e.id = o.source_event_id where e.channel_account_id = '$OA' and e.provider_message_id = '$1'"; }
ob_text() { sql "select m.content from recruitment_messages m join recruitment_channel_outbox o on o.recruitment_message_id = m.id where o.id = $1"; }
conv_ver() { sql "select control_version from recruitment_conversations where id = $1"; }
audit_ctx() { sql "select count(*) || '|' || coalesce(string_agg(success::text || '|' || (context #>> '$3'), ','), '-') from activity_log where method = '$1' and path = '$2'"; } # audit_ctx <action> <path> <jsonpath {a,b}>
sender_stop() { docker stop "$S" >/dev/null; }
release_hold() { sql "select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name = 'p365-hold'" >/dev/null; }
sender_start() { docker start "$S" >/dev/null; wait_http 3023 /recruitment/ai/jobs/active; }
hr_send() { # hr_send <conv> <clientId> <text> → id outbox
  local out; out=$(hr hr POST "/recruitment/conversations/$1/messages" "{\"content\":\"$3\",\"clientMessageId\":\"$2\"}")
  jq_get "$out" outboxId
}
cleanup() {
  release_hold 2>/dev/null || true
  docker rm -f "$MOCK" "$W" "$FAKE" "$S" >/dev/null 2>&1 || true
  sql "delete from employee where id in (${HR_ID:-0}, ${DIR_ID:-0}, ${SALES_ID:-0})" >/dev/null 2>&1 || true
}
trap cleanup EXIT

T0=$(sql "select now()::text")
TEACHER_BEFORE="$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || access_token || refresh_token, ',' order by id)), '-') from zalo_tokens")"

echo "== 0. Chuẩn bị (run $RUN_ID)"
PREP=$( { echo "BEGIN;"; python3 - "$REPO" <<'PY'
import re, sys
root = sys.argv[1]
files = ['recruitment-channel-event.queue.ts', 'recruitment-zalo-webhook.service.ts', 'recruitment-channel-outbox.queue.ts',
         'recruitment-zalo-credential.store.ts', 'recruitment-zalo-sender.service.ts', 'recruitment-hr-alert.service.ts',
         'recruitment-conversation-control.service.ts', 'recruitment-outbox-operations.service.ts']
for n, f in enumerate(files):
    src = open(f'{root}/src/recruitment/channels/{f}').read()
    consts = {k: v for k, v in re.findall(r"const (\w+) = `([^`]*)`;", src)}
    consts.update({k: v for k, v in re.findall(r"const (\w+) = (\d+);", src)})
    for i, m in enumerate(re.finditer(r'(?:query\(\s*|sql:\s*)`([^`]*)`', src)):
        sql = m.group(1).replace('${EVENT_TEXT_RETENTION_DAYS}', '7').replace('${OUTBOX_TEXT_RETENTION_DAYS}', '7')
        sql = re.sub(r"\$\{lock \? 'FOR UPDATE OF c' : ''\}", 'FOR UPDATE OF c', sql)
        sql = re.sub(r"\$\{where.length \? [^}]*\}", '', sql)
        sql = re.sub(r"\$\$\{params.length\}", '$1', sql)
        for k, v in consts.items(): sql = sql.replace('${' + k + '}', v)
        if '${' in sql: continue  # WHERE dựng động (list) — không PREPARE tĩnh được
        print(f"PREPARE q{n}_{i} AS {sql};")
PY
echo "ROLLBACK;"; } | "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -v ON_ERROR_STOP=1 2>&1)
check "mọi câu SQL của webhook/worker/outbox/sender/cảnh báo/điều khiển/đối soát hợp lệ trên schema thật ($(echo "$PREP" | grep -c '^PREPARE') câu)" \
  "$(echo "$PREP" | grep -q ERROR && echo f || echo t)" "$(echo "$PREP" | grep ERROR | head -3)"
echo "  $(scripts/outbox-fixture-cleanup.sh "P3-6 acceptance run $RUN_ID: dọn outbox còn gửi được trước khi bật sender")"
"${DC[@]}" run -d --no-deps --name "$MOCK" -e MOCK_PORT=3099 -v "$PWD/staging/mock-openclaw.js:/run/kido/mock-openclaw.js:ro" \
  staging-api node /run/kido/mock-openclaw.js >/dev/null
"${DC[@]}" run -d --no-deps --name "$FAKE" -v "$PWD/staging/fake-zalo.js:/run/kido/fake-zalo.js:ro" staging-api node /run/kido/fake-zalo.js >/dev/null
wait_http 3099 /__log; wait_http 3199 /__state
echo "  $("${DC[@]}" exec -T staging-api node - < staging/seed-zalo-credentials.js)"
"${DC[@]}" run -d --no-deps --name "$W" -e PORT=3022 -e RECRUITMENT_WORKER_ENABLED=true \
  -e RECRUITMENT_OPENCLAW_URL=http://localhost:3099 -e RECRUITMENT_OPENCLAW_TIMEOUT_MS=20000 \
  -e RECRUITMENT_WORKER_POLL_MS=300 -e RECRUITMENT_WORKER_SETTLE_MS=500 -e RECRUITMENT_WORKER_LEASE_MS=8000 \
  -e RECRUITMENT_WORKER_RETRY_BASE_MS=1500 -e RECRUITMENT_WORKER_RETRY_MAX_MS=2000 -e RECRUITMENT_WORKER_JANITOR_MS=1000 \
  staging-api >/dev/null
"${DC[@]}" run -d --no-deps --name "$S" -e PORT=3023 -e RECRUITMENT_ZALO_OUTBOUND_ENABLED=true \
  -e RECRUITMENT_ZALO_SENDER_POLL_MS=200 -e RECRUITMENT_ZALO_SENDER_LEASE_MS=6000 \
  -e RECRUITMENT_ZALO_SENDER_RETRY_BASE_MS=1500 -e RECRUITMENT_ZALO_SENDER_RETRY_MAX_MS=2000 \
  -e RECRUITMENT_ZALO_CONNECT_TIMEOUT_MS=1000 -e RECRUITMENT_ZALO_RESPONSE_TIMEOUT_MS=3000 staging-api >/dev/null
wait_http 3022 /recruitment/ai/jobs/active; wait_http 3023 /recruitment/ai/jobs/active
mock "{mode:'ok'}"
JOB=$(sql "select id from recruitment_jobs where code = 'SALES-CM-01'")

echo "== 1. Handoff mở → AI_PAUSED: tin đến vẫn lưu, OpenClaw = 0, cảnh báo HR"
A="c${RUN_ID}a"; SUB_A="zalo:$OA:$A"
send_in "p36-$RUN_ID-a1" "$A" "Chào bạn, mình muốn hỏi việc làm"
wait_event "p36-$RUN_ID-a1"
CONV_A=$(conv_of "p36-$RUN_ID-a1")
CAND_A=$(sql "select candidate_id from recruitment_conversations where id = $CONV_A")
APP_A=$(jq_get "$(ai_call "$SUB_A" POST /applications/find-or-create "{\"candidateId\":$CAND_A,\"jobId\":$JOB}")" application.id)
HANDOFF=$(ai_call "$SUB_A" POST "/applications/$APP_A/handoff" '{"reason":"CANDIDATE_REQUESTED_HUMAN","summary":"Ứng viên muốn nói chuyện với nhân sự"}')
same "tạo handoff CANDIDATE_REQUESTED_HUMAN qua API AI (như skill gọi)" "$(status_of "$HANDOFF")" 200
HANDOFF_ID=$(sql "select id from recruitment_handoffs where candidate_id = $CAND_A and status = 'OPEN' order by id desc limit 1")
C=$(hr hr GET "/recruitment/conversations/$CONV_A/control")
same "1. handoff mở → trạng thái hiệu lực AI_PAUSED (HANDOFF_OPEN)" "$(jq_get "$C" state)|$(jq_get "$C" pausedBy)" 'AI_PAUSED|["HANDOFF_OPEN", "APPLICATION_PAUSED"]'
send_in "p36-$RUN_ID-a2" "$A" "Tôi muốn gặp nhân sự"
send_in "p36-$RUN_ID-a3" "$A" "Bao giờ nhân sự gọi lại ạ"
wait_event "p36-$RUN_ID-a3"
same "1. tin đến lúc AI_PAUSED: PROCESSED (SKIPPED_AI_PAUSED), lưu vào hội thoại canonical, không outbox" \
  "$(ev "p36-$RUN_ID-a2" "status || '/' || ai_decision")|$(sql "select count(*) from recruitment_messages where conversation_id = $CONV_A and external_message_id in ('p36-$RUN_ID-a2','p36-$RUN_ID-a3') and direction = 'INBOUND'")|$(sql "select count(*) from recruitment_channel_outbox o join recruitment_channel_events e on e.id = o.source_event_id where e.provider_message_id in ('p36-$RUN_ID-a2','p36-$RUN_ID-a3')")" \
  "PROCESSED/SKIPPED_AI_PAUSED|2|0"
same "1. OpenClaw không được gọi cho tin lúc AI_PAUSED" "$(mock_calls "p36-$RUN_ID-a2")/$(mock_calls "p36-$RUN_ID-a3")" "0/0"
wait_sql 15 "select count(*) = 1 from recruitment_hr_alerts where type = 'CANDIDATE_REQUESTED_HUMAN' and source_key = 'handoff:$HANDOFF_ID'" || true
timeout 3 tail -f /dev/null || true
same "13. cảnh báo HR: đúng 1 CANDIDATE_REQUESTED_HUMAN cho handoff (quét nhiều lần), đúng 1 tin-chờ cho 2 tin cùng giai đoạn" \
  "$(alerts_for CANDIDATE_REQUESTED_HUMAN "handoff:$HANDOFF_ID")|$(alerts_for CANDIDATE_MESSAGE_WAITING "conversation:$CONV_A:v1")" "1|1"

echo "== 2. HR tiếp quản → HUMAN_TAKEOVER"
T=$(hr hr POST "/recruitment/conversations/$CONV_A/takeover")
same "2. takeover → HUMAN_TAKEOVER, version 2" "$(status_of "$T")|$(jq_get "$T" state)|$(jq_get "$T" version)|$(jq_get "$T" changed)" "200|HUMAN_TAKEOVER|2|True"
T=$(hr hr POST "/recruitment/conversations/$CONV_A/takeover")
same "12. takeover lần 2 → idempotent (không tăng version)" "$(jq_get "$T" version)|$(jq_get "$T" changed)" "2|False"
same "audit takeover ghi đúng nhân viên HR (không phải AI)" \
  "$(sql "select count(*) || '/' || min(\"actorId\") from activity_log where method = 'CONVERSATION_TAKEOVER' and path = '/recruitment-conversations/$CONV_A'")" "1/$HR_ID"

echo "== 3. HR gửi tin → canonical HR + đúng 1 outbox → Zalo; AI = 0"
T_HR="Chào bạn, mình là nhân sự KIDO, mình sẽ gọi bạn chiều nay nhé - $RUN_ID"
R=$(hr hr POST "/recruitment/conversations/$CONV_A/messages" "{\"content\":\"$T_HR\",\"clientMessageId\":\"hr-$RUN_ID-1\"}")
MSG_HR=$(jq_get "$R" messageId); OB_HR=$(jq_get "$R" outboxId)
same "3. tin HR: canonical sender HR, tác giả = nhân viên, đúng 1 outbox HR_MESSAGE" \
  "$(status_of "$R")|$(sql "select sender_type || '/' || direction || '/' || author_employee_id from recruitment_messages where id = $MSG_HR")|$(sql "select count(*) || '/' || min(source_type::text) from recruitment_channel_outbox where recruitment_message_id = $MSG_HR")" \
  "200|HR/OUTBOUND/$HR_ID|1/HR_MESSAGE"
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $OB_HR" || true
same "3. sender gửi tin HR ra Zalo đúng 1 lần, xoá bản sao" "$(ob "$OB_HR" "status || '/' || (message_text is null)")|$(fz_count "$T_HR")" "SENT/true|1"
R2=$(hr hr POST "/recruitment/conversations/$CONV_A/messages" "{\"content\":\"$T_HR\",\"clientMessageId\":\"hr-$RUN_ID-1\"}")
timeout 3 tail -f /dev/null || true
same "12. gửi lại cùng clientMessageId → idempotent: cùng tin/outbox, Zalo vẫn 1 lần" \
  "$(jq_get "$R2" idempotent)|$(jq_get "$R2" messageId)|$(sql "select count(*) from recruitment_messages where conversation_id = $CONV_A and external_message_id = 'hr:hr-$RUN_ID-1'")|$(fz_count "$T_HR")" "True|$MSG_HR|1|1"
send_in "p36-$RUN_ID-a4" "$A" "Dạ em cảm ơn chị"
wait_event "p36-$RUN_ID-a4"
same "3. ứng viên nhắn lúc HUMAN_TAKEOVER → SKIPPED_HUMAN_TAKEOVER, OpenClaw = 0" "$(ev "p36-$RUN_ID-a4" ai_decision)|$(mock_calls "p36-$RUN_ID-a4")" "SKIPPED_HUMAN_TAKEOVER|0"

echo "== 4. Trả lại AI → AI_ACTIVE; lượt kế tiếp gọi OpenClaw kèm tín hiệu làm mới context"
R=$(hr hr POST "/recruitment/conversations/$CONV_A/resume-ai" '{"note":"Đã gọi điện cho ứng viên"}')
same "4. resume-ai → AI_ACTIVE, version 3, cờ nhắc làm mới context; handoff → RETURNED_TO_AI; hồ sơ hết pause" \
  "$(jq_get "$R" state)|$(jq_get "$R" version)|$(jq_get "$R" resumeSignalPending)|$(sql "select status from recruitment_handoffs where id = $HANDOFF_ID")|$(sql "select ai_paused from recruitment_applications where id = $APP_A")" \
  "AI_ACTIVE|3|True|RETURNED_TO_AI|f"
send_in "p36-$RUN_ID-a5" "$A" "Em muốn hỏi thêm về lịch phỏng vấn"
wait_event "p36-$RUN_ID-a5"
send_in "p36-$RUN_ID-a6" "$A" "Cảm ơn bạn"
wait_event "p36-$RUN_ID-a6"
same "4. tin sau resume → OpenClaw được gọi (AI_REPLIED); lượt đầu kèm tín hiệu, lượt sau không; cờ đã xoá" \
  "$(ev "p36-$RUN_ID-a5" ai_decision)|$(node_in_api "fetch('http://localhost:3099/__log').then(r=>r.json()).then(l=>console.log(l.filter(e=>['p36-$RUN_ID-a5','p36-$RUN_ID-a6'].includes(e.msgId)).map(e=>e.msgId.slice(-2)+':'+e.resumeSignal).join(',')))")|$(sql "select resume_signal_pending from recruitment_conversations where id = $CONV_A")" \
  "AI_REPLIED|a5:true,a6:false|f"

echo "== 5. Đóng hội thoại → CLOSED: không AI, HR không gửi được"
R=$(hr hr POST "/recruitment/conversations/$CONV_A/close")
same "5. close → CLOSED (version 4); close lần 2 idempotent" "$(jq_get "$R" state)|$(jq_get "$R" version)|$(jq_get "$(hr hr POST "/recruitment/conversations/$CONV_A/close")" changed)" "CLOSED|4|False"
send_in "p36-$RUN_ID-a7" "$A" "Còn ai ở đó không"
wait_event "p36-$RUN_ID-a7"
same "5. tin đến lúc CLOSED → SKIPPED_CLOSED, OpenClaw = 0; HR gửi → 409 CONVERSATION_CLOSED" \
  "$(ev "p36-$RUN_ID-a7" ai_decision)|$(mock_calls "p36-$RUN_ID-a7")|$(R=$(hr hr POST "/recruitment/conversations/$CONV_A/messages" "{\"content\":\"x\",\"clientMessageId\":\"hr-$RUN_ID-closed\"}"); echo "$(status_of "$R")/$(jq_get "$R" code)")" \
  "SKIPPED_CLOSED|0|409/CONVERSATION_CLOSED"

echo "== 6. HR tiếp quản đúng lúc OpenClaw đang chạy → câu trả lời AI bị bỏ"
B="c${RUN_ID}b"
send_in "p36-$RUN_ID-b1" "$B" "Chào bạn"
wait_event "p36-$RUN_ID-b1"
CONV_B=$(conv_of "p36-$RUN_ID-b1")
mock "{mode:'ok',delayMs:6000,times:1,then:{mode:'ok'}}"
send_in "p36-$RUN_ID-b2" "$B" "Mình muốn ứng tuyển"
for _ in $(seq 1 40); do [ "$(mock_calls "p36-$RUN_ID-b2")" = 1 ] && break; timeout 0.3 tail -f /dev/null || true; done
same "6. lượt AI đang chạy (OpenClaw đã nhận request)" "$(ev "p36-$RUN_ID-b2" status)|$(mock_calls "p36-$RUN_ID-b2")" "PROCESSING|1"
hr hr POST "/recruitment/conversations/$CONV_B/takeover" >/dev/null
wait_event "p36-$RUN_ID-b2" 30
REPLY_B2="Mock đã nhận tin p36-$RUN_ID-b2 (19 ký tự)."
timeout 4 tail -f /dev/null || true
same "6. OpenClaw trả lời SAU takeover → DISCARDED_CONTROL_CHANGED, không outbox, tin AI đánh dấu không gửi, Zalo không nhận" \
  "$(ev "p36-$RUN_ID-b2" ai_decision)|$(sql "select count(*) from recruitment_channel_outbox o join recruitment_channel_events e on e.id = o.source_event_id where e.provider_message_id = 'p36-$RUN_ID-b2'")|$(sql "select metadata->>'delivery' from recruitment_messages where external_message_id = 'p36-$RUN_ID-b2-reply'")|$(fz_count "$REPLY_B2")" \
  "DISCARDED_CONTROL_CHANGED|0|DISCARDED_CONTROL_CHANGED|0"

echo "== 7. Đối soát outbox UNKNOWN (chỉ bằng thao tác tường minh)"
CC="c${RUN_ID}c"
send_in "p36-$RUN_ID-c1" "$CC" "Chào"
wait_event "p36-$RUN_ID-c1"
CONV_C=$(conv_of "p36-$RUN_ID-c1")
hr hr POST "/recruitment/conversations/$CONV_C/takeover" >/dev/null
wait_sql 15 "select count(*) = 0 from recruitment_channel_outbox where external_recipient_id = '$CC' and status <> 'SENT'" || true
fz /__mode "{mode:'hang',times:1,then:{mode:'ok'}}"
U1_T="Tin U1 run $RUN_ID"; U2_T="Tin U2 run $RUN_ID"
U1=$(hr_send "$CONV_C" "u1-$RUN_ID-x" "$U1_T"); U2=$(hr_send "$CONV_C" "u2-$RUN_ID-x" "$U2_T")
wait_sql 20 "select status = 'UNKNOWN' from recruitment_channel_outbox where id = $U1" || true
timeout 5 tail -f /dev/null || true
same "7. UNKNOWN chặn hàng của người nhận: U1 UNKNOWN, U2 vẫn PENDING, Zalo chưa nhận U2" "$(ob "$U1" status)|$(ob "$U2" status)|$(fz_count "$U2_T")" "UNKNOWN|PENDING|0"
wait_sql 10 "select count(*) = 1 from recruitment_hr_alerts where type = 'OUTBOUND_UNKNOWN' and source_key = 'outbox:$U1'" || true
R=$(hr dir POST "/recruitment/operations/outbox/$U1/mark-sent" '{}')
same "11. ban giám đốc (chỉ xem) đối soát → 403, dòng vẫn UNKNOWN" "$(status_of "$R")|$(ob "$U1" status)" "403|UNKNOWN"
R=$(hr hr POST "/recruitment/operations/outbox/$U1/mark-sent" '{}')
same "8. MARK_AS_SENT → SENT, xoá bản sao, người đối soát = HR; KHÔNG mở kết nối (Zalo vẫn 1 request cho U1)" \
  "$(status_of "$R")|$(ob "$U1" "status || '/' || (message_text is null) || '/' || resolution || '/' || resolved_by")|$(fz_count "$U1_T")" "200|SENT/true/MARK_SENT/$HR_ID|1"
wait_sql 15 "select status = 'SENT' from recruitment_channel_outbox where id = $U2" || true
same "8. hàng được mở: U2 gửi tiếp" "$(ob "$U2" status)|$(fz_count "$U2_T")" "SENT|1"
R=$(hr hr POST "/recruitment/operations/outbox/$U1/mark-sent" '{}')
same "12. mark-sent lần 2 → idempotent; cảnh báo OUTBOUND_UNKNOWN đã đóng bởi chính HR đó" \
  "$(jq_get "$R" idempotent)|$(sql "select status || '/' || acknowledged_by from recruitment_hr_alerts where type = 'OUTBOUND_UNKNOWN' and source_key = 'outbox:$U1'")" "True|ACKNOWLEDGED/$HR_ID"
fz /__mode "{mode:'hang',times:1,then:{mode:'ok'}}"
U3_T="Tin U3 run $RUN_ID"
U3=$(hr_send "$CONV_C" "u3-$RUN_ID-x" "$U3_T")
wait_sql 20 "select status = 'UNKNOWN' from recruitment_channel_outbox where id = $U3" || true
timeout 6 tail -f /dev/null || true
same "9. UNKNOWN không tự gửi lại (sau 6s Zalo vẫn 1 request)" "$(ob "$U3" status)|$(fz_count "$U3_T")" "UNKNOWN|1"
R=$(hr hr POST "/recruitment/operations/outbox/$U3/retry" '{}')
same "9. RETRY thiếu xác nhận rủi ro trùng → 400, vẫn UNKNOWN" "$(status_of "$R")|$(jq_get "$R" code)|$(ob "$U3" status)" "400|CONFIRMATION_REQUIRED|UNKNOWN"
R=$(hr hr POST "/recruitment/operations/outbox/$U3/retry" '{"confirmDuplicateRisk":true}')
wait_sql 15 "select status = 'SENT' from recruitment_channel_outbox where id = $U3" || true
same "9. RETRY có xác nhận → gửi lại một lần (Zalo: treo + 200), audit ghi người yêu cầu" \
  "$(status_of "$R")|$(ob "$U3" "status || '/' || resolution")|$(fz_count "$U3_T")|$(sql "select count(*) || '/' || min(\"actorId\") from activity_log where method = 'OUTBOX_RETRY' and path = '/recruitment-channel-outbox/$U3'")" \
  "200|SENT/RETRY|2|1/$HR_ID"
R=$(hr hr POST "/recruitment/operations/outbox/$U3/retry" '{"confirmDuplicateRisk":true}')
timeout 3 tail -f /dev/null || true
same "12. RETRY lần 2 → idempotent, không gửi thêm" "$(jq_get "$R" idempotent)|$(fz_count "$U3_T")" "True|2"
fz /__mode "{mode:'hang',times:1,then:{mode:'ok'}}"
U4_T="Tin U4 run $RUN_ID"; U5_T="Tin U5 run $RUN_ID"
U4=$(hr_send "$CONV_C" "u4-$RUN_ID-x" "$U4_T"); U5=$(hr_send "$CONV_C" "u5-$RUN_ID-x" "$U5_T")
wait_sql 20 "select status = 'UNKNOWN' from recruitment_channel_outbox where id = $U4" || true
R=$(hr hr POST "/recruitment/operations/outbox/$U4/dead-letter")
wait_sql 15 "select status = 'SENT' from recruitment_channel_outbox where id = $U5" || true
same "10. DEAD_LETTER → hàng tiếp tục (U5 gửi), tin canonical U4 vẫn còn" \
  "$(status_of "$R")|$(ob "$U4" "status || '/' || resolution")|$(ob "$U5" status)|$(sql "select count(*) from recruitment_messages where id = (select recruitment_message_id from recruitment_channel_outbox where id = $U4)")" \
  "200|DEAD_LETTER/DEAD_LETTER|SENT|1"

echo "== 8. Phân quyền"
same "11. role ngoài tuyển dụng (sales) → 403 cả khi đọc" "$(status_of "$(hr sales GET "/recruitment/conversations/$CONV_B/control")")" 403
same "11. ban giám đốc đọc được, KHÔNG tiếp quản/đóng/gửi/trả AI được; trạng thái không đổi" \
  "$(status_of "$(hr dir GET "/recruitment/conversations/$CONV_B/control")")|$(status_of "$(hr dir POST "/recruitment/conversations/$CONV_B/resume-ai" '{}')")|$(status_of "$(hr dir POST "/recruitment/conversations/$CONV_B/close")")|$(status_of "$(hr dir POST "/recruitment/conversations/$CONV_B/messages" "{\"content\":\"x\",\"clientMessageId\":\"dir-$RUN_ID-1\"}")")|$(sql "select control_mode || '/' || control_version from recruitment_conversations where id = $CONV_B")" \
  "200|403|403|403|HUMAN_TAKEOVER/2"

echo "== 9. Cảnh báo HR"
ALERT=$(sql "select id from recruitment_hr_alerts where type = 'CANDIDATE_REQUESTED_HUMAN' and source_key = 'handoff:$HANDOFF_ID'")
same "11. ban giám đốc xác nhận cảnh báo → 403" "$(status_of "$(hr dir POST "/recruitment/operations/alerts/$ALERT/acknowledge")")|$(sql "select status from recruitment_hr_alerts where id = $ALERT")" "403|OPEN"
R=$(hr hr POST "/recruitment/operations/alerts/$ALERT/acknowledge")
ACK1="$(sql "select status || '/' || acknowledged_by || '/' || acknowledged_at from recruitment_hr_alerts where id = $ALERT")"
R2=$(hr hr POST "/recruitment/operations/alerts/$ALERT/acknowledge")
same "14. acknowledge → đúng nhân viên + thời điểm; lần 2 idempotent, không ghi đè" \
  "$(status_of "$R")|$(echo "$ACK1" | cut -d/ -f1-2)|$(jq_get "$R2" idempotent)|$(sql "select status || '/' || acknowledged_by || '/' || acknowledged_at from recruitment_hr_alerts where id = $ALERT")" \
  "200|ACKNOWLEDGED/$HR_ID|True|$ACK1"
D="c${RUN_ID}d"
send_in "p36-$RUN_ID-d1" "$D" "Chào"
wait_event "p36-$RUN_ID-d1"
mock "{mode:'errortext',times:3,then:{mode:'ok'}}"
send_in "p36-$RUN_ID-d2" "$D" "Lương bao nhiêu"
wait_sql 30 "select failure_code is not null from recruitment_channel_events where provider_message_id = 'p36-$RUN_ID-d2'" || true
EV_D2=$(ev "p36-$RUN_ID-d2" id)
wait_sql 10 "select count(*) = 1 from recruitment_hr_alerts where type = 'CHANNEL_EVENT_DEAD_LETTER' and source_key = 'event:$EV_D2'" || true
timeout 3 tail -f /dev/null || true
same "15. tin dead-letter (lỗi AI 3 lần) → đúng 1 cảnh báo CHANNEL_EVENT_DEAD_LETTER" "$(ev "p36-$RUN_ID-d2" "status || '/' || failure_code")|$(alerts_for CHANNEL_EVENT_DEAD_LETTER "event:$EV_D2")" "FAILED/AGENT_ERROR_TEXT|1"
E="c${RUN_ID}e"
mock "{mode:'quota',times:3,then:{mode:'ok'}}"
send_in "p36-$RUN_ID-e1" "$E" "Chào"
wait_sql 30 "select count(*) >= 1 from recruitment_hr_alerts where type = 'REPEATED_AI_FAILURE' and source_key like 'ai:$OA:%' and created_at >= '$T0'" || true
wait_event "p36-$RUN_ID-e1" 30
same "OpenAI hết quota lặp lại (≥3 lần) → cảnh báo REPEATED_AI_FAILURE (gộp theo OA/giờ); tin vẫn xử lý được sau đó" \
  "$(sql "select count(*) >= 1 from recruitment_hr_alerts where type = 'REPEATED_AI_FAILURE' and source_key like 'ai:$OA:%'")|$(ev "p36-$RUN_ID-e1" "status || '/' || attempt_count")" "t|PROCESSED/4"
VER=$(sql "select version from recruitment_zalo_credentials where oa_id = '$OA'")
fz /__oauth-mode "{mode:'hang'}"
fz /__expire
U7_T="Tin U7 run $RUN_ID"
U7=$(hr_send "$CONV_C" "u7-$RUN_ID-x" "$U7_T")
wait_sql 30 "select count(*) = 1 from recruitment_hr_alerts where type = 'REFRESH_OUTCOME_UNKNOWN' and source_key = 'credential:$OA:v$VER'" || true
timeout 5 tail -f /dev/null || true
same "16. refresh token không rõ kết quả → đúng 1 cảnh báo CRITICAL (dù thử lại nhiều lần); tin chưa gửi, chờ thử lại" \
  "$(sql "select count(*) || '/' || min(severity::text) from recruitment_hr_alerts where type = 'REFRESH_OUTCOME_UNKNOWN' and source_key = 'credential:$OA:v$VER'")|$(ob "$U7" "status || '/' || last_error_code")" \
  "1/CRITICAL|RETRY/REFRESH_OUTCOME_UNKNOWN"
fz /__oauth-mode "{mode:'ok'}"
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $U7" || true
same "16. OAuth hồi phục → refresh xong → tin giao đúng 1 lần (các lần trước chỉ bị Zalo từ chối -216 vì token cũ)" \
  "$(ob "$U7" status)|$(fz_delivery "$U7_T")" "SENT|1/0"

echo "== 11. P3-6.5 — HR tiếp quản chặn mọi tin AI chưa dispatch"
# (a) AI reply PENDING → takeover → sender: 0 request; HR_MESSAGE sau đó vẫn gửi
F="c${RUN_ID}f"
send_in "p365-$RUN_ID-f1" "$F" "Chào bạn"
wait_event "p365-$RUN_ID-f1"
CONV_F=$(conv_of "p365-$RUN_ID-f1")
wait_sql 20 "select count(*) = 1 and bool_and(o.status = 'SENT') from recruitment_channel_outbox o where o.external_recipient_id = '$F'" || true
sender_stop
send_in "p365-$RUN_ID-f2" "$F" "Mình muốn ứng tuyển vị trí bán hàng"
wait_event "p365-$RUN_ID-f2"
OB_F2=$(ai_ob "p365-$RUN_ID-f2"); F2_T=$(ob_text "$OB_F2")
same "P3-6.5 a. tin AI nằm PENDING (sender dừng), version lúc xếp hàng = version hội thoại" "$(ob "$OB_F2" "status || '/' || control_version")" "PENDING/$(conv_ver "$CONV_F")"
T=$(hr hr POST "/recruitment/conversations/$CONV_F/takeover")
same "P3-6.5 a. takeover báo tin AI chưa dispatch sẽ bị chặn, không có tin nào đã đi" "$(jq_get "$T" aiOutbound.willBeSuppressed)|$(jq_get "$T" aiOutbound.alreadyDispatched)" "[$OB_F2]|[]"
T_HR_F="Nhân sự KIDO đây, mình hỗ trợ bạn tiếp nhé run $RUN_ID"
OB_HR_F=$(hr_send "$CONV_F" "hrf-$RUN_ID-1" "$T_HR_F")
sender_start
wait_sql 30 "select status = 'SENT' from recruitment_channel_outbox where id = $OB_HR_F" || true
same "P3-6.5 a. PENDING → takeover → sender: SUPPRESSED (CONTROL_HUMAN_TAKEOVER), bản sao xoá, chưa từng dispatch, Zalo 0 request" \
  "$(ob "$OB_F2" "status || '/' || last_error_code || '/' || (message_text is null) || '/' || (dispatched_at is null)")|$(fz_count "$F2_T")" "SUPPRESSED/CONTROL_HUMAN_TAKEOVER/true/true|0"
same "P3-6.5 a. tin AI canonical vẫn còn, đánh dấu không gửi; audit CHANNEL_OUTBOX_SUPPRESSED (chính sách, network=false)" \
  "$(sql "select metadata->>'delivery' from recruitment_messages m join recruitment_channel_outbox o on o.recruitment_message_id = m.id where o.id = $OB_F2")|$(audit_ctx CHANNEL_OUTBOX_SUPPRESSED "/recruitment-channel-outbox/$OB_F2" '{network}')" \
  "SUPPRESSED_CONTROL_CHANGED|1|true|false"
same "P3-6.5 d. HR_MESSAGE lúc HUMAN_TAKEOVER → gửi bình thường (tin AI bị chặn không chặn hàng)" "$(ob "$OB_HR_F" status)|$(fz_count "$T_HR_F")" "SENT|1"

# (e) trả lại AI → tin AI mới gửi bình thường; tin cũ vẫn bị chặn
R=$(hr hr POST "/recruitment/conversations/$CONV_F/resume-ai" '{}')
send_in "p365-$RUN_ID-f3" "$F" "Vâng, mình hỏi tiếp về ca làm"
wait_event "p365-$RUN_ID-f3"
OB_F3=$(ai_ob "p365-$RUN_ID-f3")
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $OB_F3" || true
same "P3-6.5 e. resume AI → tin AI mới (version mới) gửi đúng 1 lần; tin AI cũ vẫn SUPPRESSED, 0 request" \
  "$(jq_get "$R" state)|$(ob "$OB_F3" "status || '/' || control_version")|$(fz_count "$(ob_text "$OB_F3")")|$(ob "$OB_F2" status)|$(fz_count "$F2_T")" \
  "AI_ACTIVE|SENT/$(conv_ver "$CONV_F")|1|SUPPRESSED|0"

# (f) takeover rồi trả lại AI TRƯỚC khi sender chạy → version đổi → vẫn chặn
sender_stop
send_in "p365-$RUN_ID-f4" "$F" "Lương khởi điểm thế nào ạ"
wait_event "p365-$RUN_ID-f4"
OB_F4=$(ai_ob "p365-$RUN_ID-f4"); V_F4=$(ob "$OB_F4" control_version)
hr hr POST "/recruitment/conversations/$CONV_F/takeover" >/dev/null
hr hr POST "/recruitment/conversations/$CONV_F/resume-ai" '{}' >/dev/null
sender_start
wait_sql 30 "select status <> 'PENDING' from recruitment_channel_outbox where id = $OB_F4" || true
same "P3-6.5 f. hội thoại lại AI_ACTIVE nhưng version đổi ($V_F4 → $(conv_ver "$CONV_F")) → SUPPRESSED (CONTROL_VERSION_CHANGED), 0 request" \
  "$(ob "$OB_F4" "status || '/' || last_error_code")|$(fz_count "$(ob_text "$OB_F4")")" "SUPPRESSED/CONTROL_VERSION_CHANGED|0"

# (b) SENDING, chưa dispatch → takeover → chặn. Token sắp hết hạn → sender refresh TRƯỚC
#     dispatch; một phiên psql giữ khoá dòng credential (refresh cần FOR UPDATE) nên
#     sender đứng ngay trước cửa kiểm — không phụ thuộc timeout, không làm lệch chuỗi token.
G="c${RUN_ID}g"
send_in "p365-$RUN_ID-g1" "$G" "Chào bạn"
wait_event "p365-$RUN_ID-g1"
CONV_G=$(conv_of "p365-$RUN_ID-g1")
wait_sql 20 "select count(*) = 1 and bool_and(status = 'SENT') from recruitment_channel_outbox where external_recipient_id = '$G'" || true
sql "update recruitment_zalo_credentials set access_expires_at = now() where oa_id = '$OA'" >/dev/null
"${DC[@]}" exec -T -e PGAPPNAME=p365-hold staging-db psql -U postgres -d sales_db_staging \
  -c "BEGIN; SELECT 1 FROM recruitment_zalo_credentials WHERE oa_id = '$OA' FOR UPDATE; SELECT pg_sleep(30); COMMIT;" >/dev/null 2>&1 &
HOLD=$!
wait_sql 10 "select count(*) = 1 from pg_stat_activity where application_name = 'p365-hold' and state = 'active'" || true
send_in "p365-$RUN_ID-g2" "$G" "Mình muốn hỏi lịch phỏng vấn"
wait_sql 20 "select o.status = 'SENDING' from recruitment_channel_outbox o join recruitment_channel_events e on e.id = o.source_event_id where e.provider_message_id = 'p365-$RUN_ID-g2'" || true
OB_G2=$(ai_ob "p365-$RUN_ID-g2")
AT_TAKEOVER=$(ob "$OB_G2" "status || '/' || (dispatched_at is null)")
T=$(hr hr POST "/recruitment/conversations/$CONV_G/takeover")
release_hold; wait "$HOLD" 2>/dev/null || true
wait_sql 20 "select status not in ('PENDING', 'SENDING') from recruitment_channel_outbox where id = $OB_G2" || true
same "P3-6.5 b. SENDING chưa dispatch (đang refresh token) → takeover → SUPPRESSED, Zalo 0 request" \
  "$AT_TAKEOVER|$(jq_get "$T" aiOutbound.willBeSuppressed)|$(ob "$OB_G2" "status || '/' || last_error_code || '/' || (dispatched_at is null)")|$(fz_count "$(ob_text "$OB_G2")")" \
  "SENDING/true|[$OB_G2]|SUPPRESSED/CONTROL_HUMAN_TAKEOVER/true|0"

# (c) đã dispatch → takeover → không huỷ giả, không gửi lại giả; audit ghi rõ
H="c${RUN_ID}h"
send_in "p365-$RUN_ID-h1" "$H" "Chào bạn"
wait_event "p365-$RUN_ID-h1"
CONV_H=$(conv_of "p365-$RUN_ID-h1")
wait_sql 20 "select count(*) = 1 and bool_and(status = 'SENT') from recruitment_channel_outbox where external_recipient_id = '$H'" || true
fz /__mode "{mode:'hang',times:1,then:{mode:'ok'}}"
send_in "p365-$RUN_ID-h2" "$H" "Công ty ở quận nào ạ"
wait_sql 20 "select o.dispatched_at is not null from recruitment_channel_outbox o join recruitment_channel_events e on e.id = o.source_event_id where e.provider_message_id = 'p365-$RUN_ID-h2'" || true
OB_H2=$(ai_ob "p365-$RUN_ID-h2"); H2_T=$(ob_text "$OB_H2")
T=$(hr hr POST "/recruitment/conversations/$CONV_H/takeover")
wait_sql 20 "select status = 'UNKNOWN' from recruitment_channel_outbox where id = $OB_H2" || true
timeout 3 tail -f /dev/null || true
same "P3-6.5 c. đã dispatch → takeover: báo 'đã đi, không thu hồi được'; dòng giữ kết quả thật (UNKNOWN), không SUPPRESSED, Zalo đúng 1 request" \
  "$(jq_get "$T" aiOutbound.alreadyDispatched)|$(jq_get "$T" aiOutbound.willBeSuppressed)|$(ob "$OB_H2" "status || '/' || (dispatched_at is not null)")|$(fz_count "$H2_T")" \
  "[$OB_H2]|[]|UNKNOWN/true|1"
same "P3-6.5 c. audit CONVERSATION_TAKEOVER ghi tin AI đã đi trước khi tiếp quản" \
  "$(audit_ctx CONVERSATION_TAKEOVER "/recruitment-conversations/$CONV_H" '{aiOutbound,alreadyDispatched}')|$(audit_ctx CONVERSATION_TAKEOVER "/recruitment-conversations/$CONV_H" '{aiOutbound,willBeSuppressed}')" "1|true|[$OB_H2]|1|true|[]"
R=$(hr hr POST "/recruitment/operations/outbox/$OB_H2/retry" '{"confirmDuplicateRisk":true}')
wait_sql 20 "select status not in ('PENDING', 'SENDING', 'UNKNOWN') from recruitment_channel_outbox where id = $OB_H2" || true
same "P3-6.5 c. vận hành RETRY tin AI đó lúc HUMAN_TAKEOVER → cửa kiểm vẫn chặn: SUPPRESSED, Zalo vẫn 1 request" \
  "$(status_of "$R")|$(ob "$OB_H2" "status || '/' || last_error_code")|$(fz_count "$H2_T")" "200|SUPPRESSED/CONTROL_HUMAN_TAKEOVER|1"
same "P3-6.5 tin bị chặn không gây cảnh báo HR (đúng chính sách, không phải lỗi gửi)" \
  "$(sql "select count(*) from recruitment_hr_alerts where outbox_id in ($OB_F2, $OB_F4, $OB_G2) and created_at >= '$T0'")" 0

echo "== 10. Audit / log / OA giáo viên"
LEAK_SQL="select count(*) from activity_log where \"createdAt\" >= '$T0' and (coalesce(body::text,'') || coalesce(context::text,'') || coalesce(\"beforeData\"::text,'') || coalesce(\"afterData\"::text,'') || coalesce(changes::text,'')) ~ '(run $RUN_ID|chiều nay nhé|Mock đã nhận|Tôi muốn gặp|cảm ơn chị)'"
same "17. activity_log của run: không nội dung tin HR/ứng viên/AI" "$(sql "$LEAK_SQL")" 0
same "17. request gửi tin HR (kể cả bị 409) vẫn có dấu vết ai/khi nào, nhưng body đã ẩn" \
  "$(sql "select count(*) >= 3 and bool_and(body::text like '%_redacted%' and \"actorId\" = $HR_ID) from activity_log where path = '/recruitment/conversations/$CONV_A/messages'")" t
same "17. cảnh báo HR chỉ chứa metadata (không nội dung tin)" \
  "$(sql "select count(*) from recruitment_hr_alerts where created_at >= '$T0' and details::text ~ '(run $RUN_ID|Mock đã nhận|Tôi muốn gặp)'")" 0
LEAK=$( { docker logs "$W" 2>&1; docker logs "$S" 2>&1; } | grep -cF -f <(printf '%s\n' "$A" "$B" "$CC" "$F" "$G" "$H" "Tôi muốn gặp" "run $RUN_ID"; sed -n 's/^STAGING_ZALO_APP_SECRET=//p;s/^OPENCLAW_GATEWAY_TOKEN=//p' "$ENV_FILE") || true)
same "17. log worker/sender: 0 id người gửi, 0 nội dung, 0 secret" "$LEAK" 0
same "18. token OA giáo viên không đổi" "$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || access_token || refresh_token, ',' order by id)), '-') from zalo_tokens")" "$TEACHER_BEFORE"
if git -C "$REPO" diff --quiet master HEAD -- src/zalo-oa src/zalo-token src/notify-zalo src/main.ts; then ok "18. code OA giáo viên không đổi so với master"; else ko "18. code OA giáo viên không đổi so với master"; fi
JEST=$(cd "$REPO" && npx jest src/zalo-oa 2>&1 | grep -E '^Tests:' || true)
if echo "$JEST" | grep -qE 'Tests: +[0-9]+ passed, [0-9]+ total' && ! echo "$JEST" | grep -q failed; then ok "18. unit test OA giáo viên: $JEST"; else ko "18. unit test OA giáo viên" "$JEST"; fi

echo "  $(scripts/outbox-fixture-cleanup.sh "P3-6 acceptance run $RUN_ID: kết thúc, dọn dòng còn gửi được")"
echo "== Kết quả: $PASS đạt, $FAIL lỗi (run $RUN_ID)"
[ "$FAIL" -eq 0 ]
