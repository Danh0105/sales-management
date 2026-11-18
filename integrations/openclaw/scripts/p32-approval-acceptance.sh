#!/bin/bash
# Acceptance P3.2 — HR duyệt từng tin AI trước khi gửi Zalo, trọn vòng trên STAGING:
# webhook có chữ ký → worker (OpenClaw GIẢ) → outbox AWAITING_APPROVAL → API duyệt của HR
# → sender → Zalo GIẢ (đếm kết nối theo hash nội dung). Tiêu chí (kế hoạch P3.2 mục 6):
#   chưa duyệt = 0 kết nối · duyệt = đúng 1 · sửa rồi duyệt = gửi đúng bản đã duyệt ·
#   từ chối / tiếp quản / STOP = 0 · hai HR duyệt cùng lúc = 1 lần gửi · role xem = 403 ·
#   duyệt tin sau khi tin trước chưa duyệt = vẫn giữ thứ tự.
#
#   STAGING_API_TAG=<tag> integrations/openclaw/scripts/p32-approval-acceptance.sh
#
# STAGING_API_TAG phải trỏ image chứa cổng duyệt: các container tạm (worker, sender) lấy image
# theo biến này, KHÔNG theo staging-api đang chạy.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(cd ../.. && pwd)"
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
RUN_ID="$(date +%s)"
OA=stg-recruit-oa
MOCK="kido-p32-mock-$RUN_ID"; W="kido-p32-w-$RUN_ID"; FAKE="kido-p32-zalo-$RUN_ID"; S="kido-p32-s-$RUN_ID"
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
jq_get() { python3 -c "import json,sys; d=json.loads(sys.argv[1].split(' ',1)[1]); v=d; [v:=v[k] if not isinstance(v, list) else v[int(k)] for k in sys.argv[2].split('.')]; print(v if not isinstance(v,(dict,list)) else json.dumps(v))" "$1" "$2"; }
status_of() { echo "${1%% *}"; }
uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

# --- tài khoản test: 2 HR (duyệt đồng thời) + ban giám đốc chỉ-xem -------------------------
PW=$(openssl rand -hex 16)
HASH=$(printf '%s' "$PW" | "${DC[@]}" exec -T staging-api node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('bcrypt').hash(s,10).then(h=>console.log(h)))")
declare -A PHONE=([hr]="0993${RUN_ID: -6}" [hr2]="0994${RUN_ID: -6}" [dir]="0995${RUN_ID: -6}")
HR_ID=$(sql "insert into employee (name, phone, password, roles) values ('HR duyệt $RUN_ID', '${PHONE[hr]}', '$HASH', '{nhansu}') returning id" | head -1)
HR2_ID=$(sql "insert into employee (name, phone, password, roles) values ('HR duyệt 2 $RUN_ID', '${PHONE[hr2]}', '$HASH', '{nhansu}') returning id" | head -1)
DIR_ID=$(sql "insert into employee (name, phone, password, roles) values ('GĐ xem $RUN_ID', '${PHONE[dir]}', '$HASH', '{director}') returning id" | head -1)
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
approve() { hr "${3:-hr}" POST "/recruitment/operations/outbox/$1/approve" "{\"requestId\":\"$2\"}"; }
send_in() { # send_in <msgId> <sender> <text> — webhook có chữ ký thật
  "${DC[@]}" exec -T -e TARGET_PORT=3021 -e "EVENT_TS=$(date +%s%3N)" -e "EVENT_TEXT=$3" staging-api \
    node - send "$RUN_ID" "$1" "$2" < staging/zalo-webhook-acceptance.js >/dev/null
}
mock() { node_in_api "fetch('http://localhost:3099/__mode',{method:'POST',body:JSON.stringify($1)}).then(r=>r.text())" >/dev/null; }
fz_count() { node_in_api "fetch('http://localhost:3199/__log').then(r=>r.json()).then(l=>{const h=require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,16);console.log(l.filter(e=>e.textSha===h).length)})" "$1"; }
fz_order() { # fz_order <text1> <text2> → thứ tự Zalo nhận (vd. "1,2")
  node_in_api "fetch('http://localhost:3199/__log').then(r=>r.json()).then(l=>{const s=t=>require('crypto').createHash('sha256').update(t).digest('hex').slice(0,16);const m={[s(process.argv[1])]:'1',[s(process.argv[2])]:'2'};console.log(l.filter(e=>m[e.textSha]).map(e=>m[e.textSha]).join(','))})" "$1" "$2"
}
ob() { sql "select $2 from recruitment_channel_outbox where id = $1"; }
ap() { sql "select $2 from recruitment_outbox_approvals where outbox_id = $1"; }
ap_events() { sql "select coalesce(string_agg(action, ',' order by id), '-') from recruitment_outbox_approval_events where outbox_id = $1"; }
conv_of() { sql "select conversation_id from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1'"; }
wait_event() { wait_sql "${2:-30}" "select status = 'PROCESSED' from recruitment_channel_events where channel_account_id = '$OA' and provider_message_id = '$1'" || true; }
ai_ob() { sql "select o.id from recruitment_channel_outbox o join recruitment_channel_events e on e.id = o.source_event_id where e.channel_account_id = '$OA' and e.provider_message_id = '$1'"; }
ob_text() { sql "select m.content from recruitment_messages m join recruitment_channel_outbox o on o.recruitment_message_id = m.id where o.id = $1"; }
audit_n() { sql "select count(*) from activity_log where method = '$1' and path = '/recruitment-channel-outbox/$2' and \"actorId\" = $3"; }
runtime() { hr hr POST "/recruitment/operations/runtime-controls/$1" "{\"scopes\":[\"OUTBOUND\"],\"reason\":\"p32 acceptance run $RUN_ID\"}" >/dev/null; }
# ai_reply <msgId> <sender> <text> → id outbox tin AI (đợi worker xử lý xong)
ai_reply() { send_in "$1" "$2" "$3"; wait_event "$1"; ai_ob "$1"; }
cleanup() {
  runtime resume 2>/dev/null || true
  docker rm -f "$MOCK" "$W" "$FAKE" "$S" >/dev/null 2>&1 || true
  sql "delete from employee where id in (${HR_ID:-0}, ${HR2_ID:-0}, ${DIR_ID:-0})" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== 0. Chuẩn bị (run $RUN_ID, image ${STAGING_API_TAG:-<theo .env>})"
PREP=$( { echo "BEGIN;"; python3 - "$REPO" <<'PY'
import re, sys
root = sys.argv[1]
files = ['recruitment-channel-event.queue.ts', 'recruitment-channel-outbox.queue.ts', 'recruitment-conversation-control.service.ts',
         'recruitment-outbox-approval.service.ts', 'recruitment-outbox-approval-expiry.service.ts']
for n, f in enumerate(files):
    src = open(f'{root}/src/recruitment/channels/{f}').read()
    consts = {k: v for k, v in re.findall(r"const (\w+) = `([^`]*)`;", src)}
    for i, m in enumerate(re.finditer(r'query(?:<[^`(]*>)?\(\s*`([^`]*)`', src)):
        sql = m.group(1)
        sql = re.sub(r"\$\{lock \? 'FOR UPDATE OF c' : ''\}", 'FOR UPDATE OF c', sql)
        for k, v in consts.items(): sql = sql.replace('${' + k + '}', v)
        if '${' in sql: continue
        print(f"PREPARE q{n}_{i} AS {sql};")
PY
echo "ROLLBACK;"; } | "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -v ON_ERROR_STOP=1 2>&1)
if echo "$PREP" | grep -q ERROR; then ko "SQL của worker/outbox/duyệt/hết hạn hợp lệ trên schema thật" "$(echo "$PREP" | grep ERROR | head -3)"
else ok "SQL của worker/outbox/duyệt/hết hạn hợp lệ trên schema thật ($(echo "$PREP" | grep -c '^PREPARE') câu)"; fi
echo "  $(scripts/outbox-fixture-cleanup.sh "P3.2 acceptance run $RUN_ID: dọn outbox còn gửi được trước khi bật sender")"
"${DC[@]}" run -d --no-deps --name "$MOCK" -e MOCK_PORT=3099 -v "$PWD/staging/mock-openclaw.js:/run/kido/mock-openclaw.js:ro" \
  staging-api node /run/kido/mock-openclaw.js >/dev/null
"${DC[@]}" run -d --no-deps --name "$FAKE" -v "$PWD/staging/fake-zalo.js:/run/kido/fake-zalo.js:ro" staging-api node /run/kido/fake-zalo.js >/dev/null
wait_http 3099 /__log; wait_http 3199 /__state
echo "  $("${DC[@]}" exec -T staging-api node - < staging/seed-zalo-credentials.js)"
"${DC[@]}" run -d --no-deps --name "$W" -e PORT=3022 -e RECRUITMENT_WORKER_ENABLED=true \
  -e RECRUITMENT_OPENCLAW_URL=http://localhost:3099 -e RECRUITMENT_OPENCLAW_TIMEOUT_MS=20000 \
  -e RECRUITMENT_WORKER_POLL_MS=300 -e RECRUITMENT_WORKER_SETTLE_MS=500 -e RECRUITMENT_WORKER_LEASE_MS=8000 \
  staging-api >/dev/null
"${DC[@]}" run -d --no-deps --name "$S" -e PORT=3023 -e RECRUITMENT_ZALO_OUTBOUND_ENABLED=true \
  -e RECRUITMENT_ZALO_SENDER_POLL_MS=200 -e RECRUITMENT_ZALO_SENDER_LEASE_MS=6000 \
  -e RECRUITMENT_ZALO_CONNECT_TIMEOUT_MS=1000 -e RECRUITMENT_ZALO_RESPONSE_TIMEOUT_MS=3000 staging-api >/dev/null
wait_http 3022 /recruitment/ai/jobs/active; wait_http 3023 /recruitment/ai/jobs/active
mock "{mode:'ok'}"
same "image container tạm có cổng duyệt (enum AWAITING_APPROVAL + bảng duyệt)" \
  "$(sql "select to_regclass('public.recruitment_outbox_approvals') is not null")" t

echo "== 1. Chưa duyệt → 0 kết nối; role xem → 403; duyệt → đúng 1; gọi lại → idempotent"
A="p32a$RUN_ID"
OB_A=$(ai_reply "p32-$RUN_ID-a1" "$A" "Chào anh chị, em muốn ứng tuyển")
T_A=$(ob_text "$OB_A")
same "1. tin AI vào outbox AWAITING_APPROVAL + dòng duyệt AWAITING_APPROVAL + sự kiện CREATED" \
  "$(ob "$OB_A" status)|$(ap "$OB_A" state)|$(ap_events "$OB_A")" "AWAITING_APPROVAL|AWAITING_APPROVAL|CREATED"
pause 4
same "1. sender đang chạy 4 giây: tin chưa duyệt không được claim, Zalo 0 kết nối" \
  "$(ob "$OB_A" "status || '/' || attempt_count || '/' || (dispatched_at is null)")|$(fz_count "$T_A")" "AWAITING_APPROVAL/0/true|0"
R=$(approve "$OB_A" "$(uuid)" dir)
same "1. ban giám đốc (role xem) duyệt → 403, không đổi gì" "$(status_of "$R")|$(ob "$OB_A" status)" "403|AWAITING_APPROVAL"
REQ_A=$(uuid)
R=$(approve "$OB_A" "$REQ_A")
same "1. HR duyệt → 200, PENDING, phiên bản duyệt 1" "$(status_of "$R")|$(jq_get "$R" status)|$(jq_get "$R" approvalVersion)" "200|PENDING|1"
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $OB_A" || true
same "1. sau duyệt: SENT, Zalo nhận đúng 1 lần đúng nội dung đã duyệt" "$(ob "$OB_A" status)|$(fz_count "$T_A")" "SENT|1"
same "1. bản duyệt ghi đúng HR, OA, người nhận, version, hash nội dung" \
  "$(ap "$OB_A" "state || '/' || approved_by || '/' || (approved_oa_id = '$OA') || '/' || (approved_recipient_id = '$A') || '/' || (approved_text_sha256 = encode(sha256(convert_to('$T_A','UTF8')),'hex')) || '/' || (expires_at > approved_at)")" \
  "APPROVED/$HR_ID/true/true/true/true"
same "1. audit OUTBOX_APPROVE đúng 1 dòng, đúng HR" "$(audit_n OUTBOX_APPROVE "$OB_A" "$HR_ID")" 1
R=$(approve "$OB_A" "$REQ_A")
same "1. gọi lại cùng requestId → 200 idempotent, không thêm sự kiện, Zalo vẫn 1" \
  "$(status_of "$R")|$(jq_get "$R" idempotent)|$(ap_events "$OB_A")|$(fz_count "$T_A")" "200|True|CREATED,APPROVED|1"
R=$(approve "$OB_A" "$(uuid)")
same "1. duyệt lần 2 với requestId mới → 409" "$(status_of "$R")" 409

echo "== 2. Sửa rồi duyệt → Zalo nhận đúng bản sửa, không nhận bản gốc"
B="p32b$RUN_ID"
OB_B=$(ai_reply "p32-$RUN_ID-b1" "$B" "Cho em hỏi mức lương")
T_B=$(ob_text "$OB_B")
T_B2="Chào bạn, mức lương tham khảo 8–15 triệu, HR sẽ trao đổi thêm (run $RUN_ID)"
R=$(hr hr POST "/recruitment/operations/outbox/$OB_B/edit-and-approve" "{\"requestId\":\"$(uuid)\",\"text\":\"$T_B2\"}")
same "2. sửa rồi duyệt → 200 PENDING" "$(status_of "$R")|$(jq_get "$R" status)" "200|PENDING"
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $OB_B" || true
same "2. Zalo nhận bản sửa đúng 1 lần, bản gốc 0 lần; tin canonical = bản sửa" \
  "$(ob "$OB_B" status)|$(fz_count "$T_B2")|$(fz_count "$T_B")|$(ob_text "$OB_B" | grep -cF "$T_B2")" "SENT|1|0|1"
same "2. sự kiện EDITED_AND_APPROVED; audit chỉ có hash, không có nội dung" \
  "$(ap_events "$OB_B")|$(audit_n OUTBOX_EDIT_AND_APPROVE "$OB_B" "$HR_ID")|$(sql "select count(*) from activity_log where path = '/recruitment-channel-outbox/$OB_B' and (\"afterData\"::text || \"beforeData\"::text || coalesce(context::text,'')) ~ 'run $RUN_ID|mức lương'")" \
  "CREATED,EDITED_AND_APPROVED|1|0"

echo "== 3. Từ chối → không gửi, xoá bản sao"
C="p32c$RUN_ID"
OB_C=$(ai_reply "p32-$RUN_ID-c1" "$C" "Em muốn hỏi thêm")
T_C=$(ob_text "$OB_C")
R=$(hr hr POST "/recruitment/operations/outbox/$OB_C/reject" "{\"requestId\":\"$(uuid)\",\"reason\":\"Câu trả lời chưa phù hợp\"}")
pause 3
same "3. từ chối → SUPPRESSED, bản sao xoá, duyệt REJECTED, Zalo 0" \
  "$(status_of "$R")|$(ob "$OB_C" "status || '/' || last_error_code || '/' || (message_text is null)")|$(ap "$OB_C" state)|$(fz_count "$T_C")" \
  "200|SUPPRESSED/HR_REJECTED/true|REJECTED|0"
same "3. duyệt sau khi đã từ chối → 409" "$(status_of "$(approve "$OB_C" "$(uuid)")")" 409

echo "== 4. HR tiếp quản khi tin AI đang chờ duyệt → thu hồi, không gửi"
D="p32d$RUN_ID"
OB_D=$(ai_reply "p32-$RUN_ID-d1" "$D" "Bên mình còn tuyển không ạ")
T_D=$(ob_text "$OB_D")
R=$(hr hr POST "/recruitment/conversations/$(conv_of "p32-$RUN_ID-d1")/takeover")
pause 3
same "4. takeover → outbox SUPPRESSED (CONTROL_HUMAN_TAKEOVER), duyệt REVOKED, Zalo 0" \
  "$(status_of "$R")|$(ob "$OB_D" "status || '/' || last_error_code")|$(ap "$OB_D" state)|$(ap_events "$OB_D")|$(fz_count "$T_D")" \
  "200|SUPPRESSED/CONTROL_HUMAN_TAKEOVER|REVOKED|CREATED,REVOKED|0"
same "4. duyệt sau khi đã thu hồi → 409" "$(status_of "$(approve "$OB_D" "$(uuid)")")" 409

echo "== 5. Đã duyệt nhưng OUTBOUND đang dừng → giữ PENDING; mở lại → gửi đúng 1"
E="p32e$RUN_ID"
OB_E=$(ai_reply "p32-$RUN_ID-e1" "$E" "Em gửi CV ở đâu ạ")
T_E=$(ob_text "$OB_E")
runtime stop
R=$(approve "$OB_E" "$(uuid)")
pause 4
same "5. OUTBOUND dừng: đã duyệt nhưng PENDING, lần thử 0, Zalo 0" \
  "$(status_of "$R")|$(ob "$OB_E" "status || '/' || attempt_count")|$(fz_count "$T_E")" "200|PENDING/0|0"
runtime resume
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $OB_E" || true
same "5. mở lại OUTBOUND → SENT, Zalo đúng 1" "$(ob "$OB_E" status)|$(fz_count "$T_E")" "SENT|1"

echo "== 6. Hai HR duyệt cùng lúc → đúng một thành công, gửi đúng 1"
F="p32f$RUN_ID"
OB_F=$(ai_reply "p32-$RUN_ID-f1" "$F" "Ca làm việc thế nào ạ")
T_F=$(ob_text "$OB_F")
TMP=$(mktemp -d)
approve "$OB_F" "$(uuid)" hr > "$TMP/1" &
approve "$OB_F" "$(uuid)" hr2 > "$TMP/2" &
wait
CODES=$(printf '%s\n%s\n' "$(status_of "$(cat "$TMP/1")")" "$(status_of "$(cat "$TMP/2")")" | sort | paste -sd,)
rm -rf "$TMP"
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $OB_F" || true
same "6. hai lần duyệt đồng thời: 200 + 409, một sự kiện APPROVED, Zalo đúng 1" \
  "$CODES|$(ap_events "$OB_F")|$(fz_count "$T_F")" "200,409|CREATED,APPROVED|1"

echo "== 7. Duyệt tin sau trong khi tin trước còn chờ → giữ thứ tự theo người nhận"
G="p32g$RUN_ID"
OB_G1=$(ai_reply "p32-$RUN_ID-g1" "$G" "Tin thứ nhất")
OB_G2=$(ai_reply "p32-$RUN_ID-g2" "$G" "Tin thứ hai")
T_G1=$(ob_text "$OB_G1"); T_G2=$(ob_text "$OB_G2")
approve "$OB_G2" "$(uuid)" >/dev/null
pause 4
same "7. tin sau đã duyệt nhưng tin trước còn AWAITING_APPROVAL → chưa gửi tin nào" \
  "$(ob "$OB_G1" status)|$(ob "$OB_G2" status)|$(fz_count "$T_G1")|$(fz_count "$T_G2")" "AWAITING_APPROVAL|PENDING|0|0"
approve "$OB_G1" "$(uuid)" >/dev/null
wait_sql 25 "select bool_and(status = 'SENT') from recruitment_channel_outbox where id in ($OB_G1, $OB_G2)" || true
same "7. duyệt tin trước → cả hai SENT, Zalo nhận theo thứ tự 1 rồi 2" \
  "$(ob "$OB_G1" status)|$(ob "$OB_G2" status)|$(fz_order "$T_G1" "$T_G2")" "SENT|SENT|1,2"

echo "== 8. Log container không lộ nội dung / người gửi"
LEAK=$( { docker logs "$W" 2>&1; docker logs "$S" 2>&1; } | grep -cF -f <(printf '%s\n' "$A" "$B" "$C" "$D" "$E" "$F" "$G" "$T_B2" "Câu trả lời chưa phù hợp") || true)
same "8. log worker/sender: 0 id người gửi, 0 nội dung" "$LEAK" 0

echo "== Kết quả: $PASS đạt, $FAIL lỗi (run $RUN_ID)"
[ "$FAIL" -eq 0 ]
