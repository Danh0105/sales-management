#!/bin/bash
# Acceptance P3-7.2A — webhook Zalo OA tuyển dụng ở CHẾ ĐỘ CÁCH LY (chưa có OA secret key): ghi bền
# bản mã trước khi trả 200, không xử lý gì; xác minh hồi tố khi có key. Staging (PostgreSQL thật),
# OpenClaw GIẢ. Request ký bằng OA secret của staging = "khoá sẽ có sau".
#
#   integrations/openclaw/scripts/zalo-quarantine-acceptance.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(cd ../.. && pwd)"
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
RUN_ID="$(date +%s)"
TEACHER_BASELINE="${TEACHER_BASELINE:-production-20261009-zalo-hardening}"
Q="kido-p372a-q-$RUN_ID"; N="kido-p372a-n-$RUN_ID"; C="kido-p372a-cap-$RUN_ID"; W="kido-p372a-w-$RUN_ID"; MOCK="kido-p372a-mock-$RUN_ID"
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
# qsend <cổng> <msgId> <sender> <valid|bad|none> [ENV=... thêm] → "<status> <body>"
qsend() {
  local port=$1 msg=$2 sender=$3 sig=$4; shift 4
  local out; out=$("${DC[@]}" exec -T -e TARGET_PORT="$port" "$@" staging-api node - send "$RUN_ID" "$msg" "$sender" "$sig" < staging/zalo-quarantine-acceptance.js)
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(str(d['status'])+' '+(d['body'] or '{}'))" "$out"
}
qrow() { sql "select $2 from recruitment_channel_quarantine where payload_hash = (select payload_hash from recruitment_channel_quarantine where id = $1)"; }
qid_of() { sql "select max(id) from recruitment_channel_quarantine where received_at >= '$T0' and event_type = 'user_send_text' and id > ${2:-0}"; }
ev_of() { sql "select $2 from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1'"; }
mock_calls() { node_in_api "fetch('http://localhost:3099/__log').then(r=>r.json()).then(l=>console.log(l.filter(e=>(e.msgId||'').startsWith(process.argv[1])).length))" "$1"; }

# --- tài khoản test (HR có quyền vận hành / ban giám đốc chỉ xem) -------------------------
PW=$(openssl rand -hex 16)
HASH=$(printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('bcrypt').hash(s,10).then(h=>console.log(h)))")
declare -A PHONE=([hr]="0993${RUN_ID: -6}" [dir]="0994${RUN_ID: -6}")
HR_ID=$(sql "insert into employee (name, phone, password, roles) values ('HR test $RUN_ID', '${PHONE[hr]}', '$HASH', '{nhansu}') returning id" | head -1)
DIR_ID=$(sql "insert into employee (name, phone, password, roles) values ('GĐ test $RUN_ID', '${PHONE[dir]}', '$HASH', '{director}') returning id" | head -1)
# hr <ai> <cổng> <METHOD> <path> → "<status> <body>" (đăng nhập thật, mật khẩu qua stdin)
hr() {
  printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "
let pw='';process.stdin.on('data',d=>pw+=d).on('end',async()=>{
  const base='http://localhost:'+process.argv[2];
  const l=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:process.argv[1],password:pw})});
  const t=(await l.json()).access_token; if(!t){console.log('0 {\"login\":\"failed\"}');return}
  const r=await fetch(base+process.argv[4],{method:process.argv[3],headers:{authorization:'Bearer '+t}});
  console.log(r.status+' '+((await r.text())||'{}'));
});" "${PHONE[$1]}" "$2" "$3" "$4"
}
cleanup() {
  docker rm -f "$Q" "$N" "$C" "$W" "$MOCK" >/dev/null 2>&1 || true
  sql "alter table if exists recruitment_channel_quarantine_x rename to recruitment_channel_quarantine" >/dev/null 2>&1 || true
  sql "delete from employee where id in (${HR_ID:-0}, ${DIR_ID:-0})" >/dev/null 2>&1 || true
}
trap cleanup EXIT

OA=$(node_in_api "console.log(process.env.RECRUITMENT_ZALO_OA_ID)")
T0=$(sql "select now()::text")
TEACHER_BEFORE="$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || access_token || refresh_token, ',' order by id)), '-') from zalo_tokens")"
A="q${RUN_ID}a"; B="q${RUN_ID}b"; X="q${RUN_ID}x"; E="q${RUN_ID}e"; F="q${RUN_ID}f"
TXT_A="Em tên Ngọc, muốn ứng tuyển tư vấn run $RUN_ID"

echo "== 0. Chuẩn bị (run $RUN_ID)"
PREP=$( { echo "BEGIN;"; python3 - "$REPO" <<'PY'
import re, sys
root = sys.argv[1]
for n, f in enumerate(['recruitment-zalo-quarantine.service.ts', 'zalo-channel-event.store.ts']):
    src = open(f'{root}/src/recruitment/channels/{f}').read()
    for i, m in enumerate(re.finditer(r'query(?:<[^`]*?>)?\(\s*`([^`]*)`', src)):
        sql = m.group(1).replace('${QUARANTINE_RETENTION_HOURS}', '72').replace('${VERIFY_BATCH}', '100')
        if '${' in sql: continue
        print(f"PREPARE q{n}_{i} AS {sql};")
PY
echo "ROLLBACK;"; } | "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -v ON_ERROR_STOP=1 2>&1)
if echo "$PREP" | grep -q ERROR; then ko "mọi câu SQL của quarantine hợp lệ trên schema thật" "$(echo "$PREP" | grep ERROR | head -3)"; else ok "mọi câu SQL của quarantine + đường ghi inbox hợp lệ trên schema thật ($(echo "$PREP" | grep -c '^PREPARE') câu)"; fi

guard() { # guard [-e ...] → lỗi khởi động (instance phải TỪ CHỐI khởi động)
  timeout 120 "${DC[@]}" run --rm --no-deps -e PORT=3029 -e RECRUITMENT_ZALO_ENABLED=true -e RECRUITMENT_ZALO_WEBHOOK_QUARANTINE=true "$@" staging-api 2>&1 | grep -oE "RECRUITMENT_ZALO_CONFIG_INVALID[^\"]*" | head -1 || true
}
G1=$(guard)
same "1. quarantine + ĐÃ có OA secret key → app từ chối khởi động (không chạy song song với kiểm chữ ký)" \
  "$(echo "$G1" | grep -c 'RECRUITMENT_ZALO_OA_SECRET_KEY (phải trống')" 1
G2=$(guard -e RECRUITMENT_ZALO_OA_SECRET_KEY= -e RECRUITMENT_ZALO_TOKEN_KEY=)
same "1. quarantine thiếu RECRUITMENT_ZALO_TOKEN_KEY → app từ chối khởi động" "$(echo "$G2" | grep -c 'RECRUITMENT_ZALO_TOKEN_KEY')" 1
same "1. lỗi khởi động chỉ nêu tên biến, không lộ giá trị" "$(printf '%s\n%s' "$G1" "$G2" | grep -cF -f <(sed -n 's/^STAGING_ZALO_OA_SECRET_KEY=//p;s/^STAGING_ZALO_TOKEN_KEY=//p' "$ENV_FILE") || true)" 0

"${DC[@]}" run -d --no-deps --name "$MOCK" -e MOCK_PORT=3099 -v "$PWD/staging/mock-openclaw.js:/run/kido/mock-openclaw.js:ro" \
  staging-api node /run/kido/mock-openclaw.js >/dev/null
"${DC[@]}" run -d --no-deps --name "$Q" -e PORT=3026 -e RECRUITMENT_ZALO_ENABLED=true -e RECRUITMENT_ZALO_WEBHOOK_QUARANTINE=true \
  -e RECRUITMENT_ZALO_OA_SECRET_KEY= staging-api >/dev/null
# Worker chạy SUỐT bài: không được đụng gì đang cách ly.
"${DC[@]}" run -d --no-deps --name "$W" -e PORT=3027 -e RECRUITMENT_ZALO_ENABLED=false -e RECRUITMENT_WORKER_ENABLED=true \
  -e RECRUITMENT_OPENCLAW_URL=http://localhost:3099 -e RECRUITMENT_WORKER_POLL_MS=300 -e RECRUITMENT_WORKER_SETTLE_MS=500 staging-api >/dev/null
wait_http 3099 /__log; wait_http 3026 /recruitment/ai/jobs/active; wait_http 3027 /recruitment/ai/jobs/active
node_in_api "fetch('http://localhost:3099/__mode',{method:'POST',body:JSON.stringify({mode:'ok'})}).then(r=>r.text())" >/dev/null

echo "== 2. Nhận khi chưa có key: ghi bản mã rồi mới 200, không xử lý"
R=$(qsend 3026 "$A-1" "$A" valid -e EVENT_TEXT="$TXT_A")
QA=$(qid_of)
same "2. event ký đúng (khoá sẽ có sau) → 200 quarantined, dòng QUARANTINED có bản mã + chữ ký + loại event" \
  "$(status_of "$R")|$(jq_get "$R" quarantined)|$(jq_get "$R" duplicate)|$(sql "select status || '/' || (body_enc is not null) || '/' || (signature like 'mac=%') || '/' || event_type from recruitment_channel_quarantine where id = $QA")" \
  "200|True|False|QUARANTINED/true/true/user_send_text"
same "2. bản ghi cách ly KHÔNG chứa nội dung tin / id người gửi ở dạng rõ" \
  "$(sql "select count(*) from recruitment_channel_quarantine where id = $QA and (body_enc like '%$A%' or body_enc like '%run $RUN_ID%' or coalesce(signature,'') like '%$A%')")" 0
R=$(qsend 3026 "$B-1" "$B" none)
QB=$(qid_of "$QA")
same "2. request KHÔNG có chữ ký (như request thử của Zalo khi đăng ký) → vẫn 200 quarantined, signature NULL" \
  "$(status_of "$R")|$(sql "select status || '/' || (signature is null) from recruitment_channel_quarantine where id = $QB")" "200|QUARANTINED/true"
R=$(qsend 3026 "$X-1" "$X" bad -e EVENT_TEXT="giả mạo run $RUN_ID")
QX=$(qid_of "$QB")
same "2. chữ ký sai → 200 quarantined (chưa kiểm được khi chưa có key)" "$(status_of "$R")|$(sql "select status from recruitment_channel_quarantine where id = $QX")" "200|QUARANTINED"
timeout 3 tail -f /dev/null || true
same "2. KHÔNG xử lý: 0 event inbox, 0 ứng viên, OpenClaw 0 lần (worker đang chạy)" \
  "$(sql "select count(*) from recruitment_channel_events where provider_message_id in ('$A-1','$B-1','$X-1')")|$(sql "select count(*) from recruitment_candidates where zalo_user_id in ('$A','$B','$X')")|$(mock_calls "$A-1")$(mock_calls "$X-1")" "0|0|00"

echo "== 3. Từ chối như receiver thường"
same "3. sai app_id → 403 APP_MISMATCH" "$(R=$(qsend 3026 "$F-1" "$F" none -e EVENT_APP=app-khac); echo "$(status_of "$R")/$(jq_get "$R" code)")" "403/APP_MISMATCH"
same "3. sai OA → 403 OA_MISMATCH" "$(R=$(qsend 3026 "$F-2" "$F" none -e EVENT_OA=oa-giao-vien); echo "$(status_of "$R")/$(jq_get "$R" code)")" "403/OA_MISMATCH"
same "3. JSON hỏng → 400 (bộ đọc JSON chặn trước receiver, như receiver thường)" "$(status_of "$(qsend 3026 "$F-3" "$F" none -e RAW_BODY='xin chao')")" 400
same "3. JSON hợp lệ nhưng không phải object → 400 MALFORMED_PAYLOAD" "$(R=$(qsend 3026 "$F-4" "$F" none -e RAW_BODY='[1,2]'); echo "$(status_of "$R")/$(jq_get "$R" code)")" "400/MALFORMED_PAYLOAD"
same "3. request bị từ chối → không ghi dòng nào" "$(sql "select count(*) from recruitment_channel_quarantine where received_at >= '$T0'")" 3

echo "== 4. Zalo gửi lại / DB lỗi / bảng đầy"
R=$(qsend 3026 "$A-1" "$A" valid -e EVENT_TEXT="$TXT_A")
same "4. gửi lại đúng request → 200 duplicate=true, vẫn 1 dòng" "$(status_of "$R")|$(jq_get "$R" duplicate)|$(qrow "$QA" 'count(*)')" "200|True|1"
sql "alter table recruitment_channel_quarantine rename to recruitment_channel_quarantine_x" >/dev/null
R=$(qsend 3026 "$E-1" "$E" valid)
sql "alter table recruitment_channel_quarantine_x rename to recruitment_channel_quarantine" >/dev/null
same "4. DB không ghi được → 503 EVENT_STORE_UNAVAILABLE (Zalo gửi lại), KHÔNG 200 giả" "$(status_of "$R")/$(jq_get "$R" code)" "503/EVENT_STORE_UNAVAILABLE"
R=$(qsend 3026 "$E-1" "$E" valid)
QE=$(qid_of "$QX")
same "4. Zalo gửi lại sau khi DB hồi phục → 200, ghi đúng 1 dòng" "$(status_of "$R")|$(jq_get "$R" duplicate)|$(qrow "$QE" 'count(*)')" "200|False|1"
CAP=$(sql "select count(*) from recruitment_channel_quarantine where status = 'QUARANTINED'")
"${DC[@]}" run -d --no-deps --name "$C" -e PORT=3028 -e RECRUITMENT_ZALO_ENABLED=true -e RECRUITMENT_ZALO_WEBHOOK_QUARANTINE=true \
  -e RECRUITMENT_ZALO_OA_SECRET_KEY= -e RECRUITMENT_ZALO_QUARANTINE_MAX_ROWS="$CAP" staging-api >/dev/null
wait_http 3028 /recruitment/ai/jobs/active
R=$(qsend 3028 "$F-9" "$F" valid)
same "4. bảng cách ly đầy (trần = $CAP) → 503 QUARANTINE_FULL, không ghi" "$(status_of "$R")/$(jq_get "$R" code)|$(sql "select count(*) from recruitment_channel_quarantine where status = 'QUARANTINED'")" "503/QUARANTINE_FULL|$CAP"
same "4. bảng đầy nhưng request đã có → vẫn 200 duplicate (không bắt Zalo gửi lại vô ích)" "$(R=$(qsend 3028 "$A-1" "$A" valid -e EVENT_TEXT="$TXT_A"); echo "$(status_of "$R")/$(jq_get "$R" duplicate)")" "200/True"
docker rm -f "$C" >/dev/null

echo "== 5. Có key: xác minh hồi tố"
R=$(hr hr 3026 GET /recruitment/operations/webhook-quarantine)
same "5. thống kê (chế độ cách ly): chỉ số lượng, không nội dung" "$(status_of "$R")|$(jq_get "$R" mode)|$(echo "$R" | grep -c "$A" || true)" "200|QUARANTINE|0"
R=$(hr hr 3026 POST /recruitment/operations/webhook-quarantine/verify)
same "5. xác minh khi quarantine còn bật → 409 QUARANTINE_STILL_ACTIVE, không đổi gì" "$(status_of "$R")/$(jq_get "$R" code)|$(sql "select count(*) from recruitment_channel_quarantine where status = 'QUARANTINED' and received_at >= '$T0'")" "409/QUARANTINE_STILL_ACTIVE|4"
# Khoá đã có → tắt quarantine, receiver thường (kiểm chữ ký) trên cùng cổng.
docker rm -f "$Q" >/dev/null
"${DC[@]}" run -d --no-deps --name "$N" -e PORT=3026 -e RECRUITMENT_ZALO_ENABLED=true staging-api >/dev/null
wait_http 3026 /recruitment/ai/jobs/active
sql "update recruitment_channel_quarantine set received_at = now() - interval '73 hours' where id = $QE" >/dev/null
# Dừng worker quanh bước xác minh để kiểm đúng dòng inbox vừa tạo (worker xử lý xong sẽ xoá nội dung).
docker stop "$W" >/dev/null
same "5. ban giám đốc (chỉ xem) chạy xác minh → 403" "$(status_of "$(hr dir 3026 POST /recruitment/operations/webhook-quarantine/verify)")" 403
R=$(hr hr 3026 POST /recruitment/operations/webhook-quarantine/verify)
same "5. xác minh: ký đúng → vào inbox (1); không chữ ký + chữ ký sai → REJECTED (2); quá 72 giờ → EXPIRED (1)" \
  "$(status_of "$R")|$(jq_get "$R" verified)|$(jq_get "$R" duplicates)|$(jq_get "$R" rejected)|$(jq_get "$R" expired)|$(jq_get "$R" undecryptable)|$(jq_get "$R" remaining)" \
  '200|1|0|{"INVALID_SIGNATURE": 2}|1|0|0'
same "5. event ký đúng đi qua ĐÚNG đường receiver thường: inbox RECEIVED, nội dung chuẩn hoá, cùng payload hash, liên kết dòng cách ly" \
  "$(ev_of "$A-1" "status")|$(sql "select (normalized_message_text = '$TXT_A') || '/' || (payload_hash = (select payload_hash from recruitment_channel_quarantine where id = $QA)) from recruitment_channel_events where provider_message_id = '$A-1'")|$(sql "select status || '/' || resolution_code || '/' || (channel_event_id = (select id from recruitment_channel_events where provider_message_id = '$A-1')) from recruitment_channel_quarantine where id = $QA")" \
  "RECEIVED|true/true|VERIFIED/NEW/true"
same "5. request không chữ ký / chữ ký sai → REJECTED, KHÔNG vào inbox; quá hạn → EXPIRED" \
  "$(sql "select string_agg(status || '/' || resolution_code, ',' order by id) from recruitment_channel_quarantine where id in ($QB, $QX, $QE)")|$(sql "select count(*) from recruitment_channel_events where provider_message_id in ('$B-1','$X-1','$E-1')")" \
  "REJECTED/INVALID_SIGNATURE,REJECTED/INVALID_SIGNATURE,EXPIRED/RETENTION_EXPIRED|0"
same "5. mọi dòng đã kết thúc → bản mã đã xoá (CHECK bảo đảm)" "$(sql "select count(*) from recruitment_channel_quarantine where id >= $QA and body_enc is not null")" 0
docker start "$W" >/dev/null; wait_http 3027 /recruitment/ai/jobs/active
wait_sql 30 "select status = 'PROCESSED' from recruitment_channel_events where provider_message_id = '$A-1'" || true
same "5. sau xác minh, event đi tiếp bình thường: worker xử lý (OpenClaw đúng 1 lần) → PROCESSED" "$(ev_of "$A-1" status)|$(mock_calls "$A-1")" "PROCESSED|1"
same "5. event bị từ chối không bao giờ tới OpenClaw" "$(mock_calls "$B-1")$(mock_calls "$X-1")$(mock_calls "$E-1")" "000"
R=$(hr hr 3026 POST /recruitment/operations/webhook-quarantine/verify)
same "5. chạy xác minh lần 2 → không còn gì, không ghi thêm" "$(jq_get "$R" verified)|$(jq_get "$R" duplicates)|$(jq_get "$R" rejected)|$(sql "select count(*) from recruitment_channel_events where provider_message_id = '$A-1'")" "0|0|{}|1"
R=$(qsend 3026 "$A-1" "$A" valid -e EVENT_TEXT="$TXT_A")
same "5. Zalo gửi lại event đó tới receiver thường (đã có key) → 200 duplicate=true (chống trùng chung)" "$(status_of "$R")|$(jq_get "$R" duplicate)|$(sql "select count(*) from recruitment_channel_events where provider_message_id = '$A-1'")" "200|True|1"
same "5. receiver thường (có key) từ chối request không chữ ký → 401, không cách ly" \
  "$(status_of "$(qsend 3026 "$F-5" "$F" none)")|$(sql "select count(*) from recruitment_channel_quarantine where id >= $QA")" "401|4"
same "5. audit CHANNEL_QUARANTINE_VERIFY: đúng nhân viên HR, chỉ số lượng" \
  "$(sql "select count(*) >= 2 and bool_and(\"actorId\" = $HR_ID) and bool_and(context::text not like '%$A%' and context::text not like '%run $RUN_ID%') from activity_log where method = 'CHANNEL_QUARANTINE_VERIFY' and \"createdAt\" >= '$T0'")" t

echo "== 6. Log / OA giáo viên"
LEAK=$( { docker logs "$Q" 2>&1 || true; docker logs "$N" 2>&1; docker logs "$W" 2>&1; } | grep -cF -f <(printf '%s\n' "$A" "$B" "$X" "$E" "run $RUN_ID" "Ngọc"; sed -n 's/^STAGING_ZALO_OA_SECRET_KEY=//p;s/^STAGING_ZALO_TOKEN_KEY=//p' "$ENV_FILE") || true)
same "6. log receiver/worker: 0 nội dung, 0 id người gửi, 0 secret" "$LEAK" 0
same "6. token OA giáo viên không đổi" "$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || access_token || refresh_token, ',' order by id)), '-') from zalo_tokens")" "$TEACHER_BEFORE"
if git -C "$REPO" diff --quiet "$TEACHER_BASELINE" HEAD -- src/zalo-oa src/zalo-token src/notify-zalo src/main.ts; then ok "6. code OA giáo viên không đổi so với production baseline"; else ko "6. code OA giáo viên không đổi so với production baseline"; fi

echo "  $(scripts/outbox-fixture-cleanup.sh "P3-7.2A acceptance run $RUN_ID: dọn outbox do worker tạo")"
echo "== Kết quả: $PASS đạt, $FAIL lỗi (run $RUN_ID)"
[ "$FAIL" -eq 0 ]
