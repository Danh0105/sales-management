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
# qpar <cổng> <tiền tố> <n> <same|distinct> → JSON {codes, created} (n request gửi CÙNG LÚC)
qpar() { "${DC[@]}" exec -T -e TARGET_PORT="$1" staging-api node - par "$RUN_ID" "$2" "$3" "$4" < staging/zalo-quarantine-acceptance.js; }
pj() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(json.dumps(d[sys.argv[2]], sort_keys=True) if isinstance(d[sys.argv[2]], dict) else d[sys.argv[2]])" "$1" "$2"; }
# vsum <trường> <file…> → tổng trường (dict → tổng các giá trị) qua các phản hồi verify
vsum() { python3 -c "
import json, sys
t = 0
for f in sys.argv[2:]:
    v = json.loads(open(f).read().split(' ', 1)[1]).get(sys.argv[1], 0)
    t += sum(v.values()) if isinstance(v, dict) else v
print(t)" "$@"; }
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
  docker rm -f "$Q" "$N" "$C" "$C2" "$W" "$MOCK" >/dev/null 2>&1 || true
  rm -rf "${TMPD:-/nonexistent}"
  sql "alter table if exists recruitment_channel_quarantine_x rename to recruitment_channel_quarantine" >/dev/null 2>&1 || true
  sql "drop trigger if exists p372a_fail_g on recruitment_channel_events; drop function if exists p372a_fail()" >/dev/null 2>&1 || true
  sql "delete from recruitment_channel_quarantine where body_enc in ('p372a-fill', 'p372a-hold')" >/dev/null 2>&1 || true
  sql "delete from employee where id in (${HR_ID:-0}, ${DIR_ID:-0})" >/dev/null 2>&1 || true
}
trap cleanup EXIT

OA=$(node_in_api "console.log(process.env.RECRUITMENT_ZALO_OA_ID)")
T0=$(sql "select now()::text")
TEACHER_BEFORE="$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || access_token || refresh_token, ',' order by id)), '-') from zalo_tokens")"
A="q${RUN_ID}a"; G="q${RUN_ID}g"; B="q${RUN_ID}b"; X="q${RUN_ID}x"; E="q${RUN_ID}e"; F="q${RUN_ID}f"
S1="q${RUN_ID}s"; H="q${RUN_ID}h"; K="q${RUN_ID}k"; C2="kido-p372a-cap2-$RUN_ID"
TMPD=$(mktemp -d)
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
R=$(qsend 3026 "$G-1" "$G" valid -e EVENT_TEXT="Tin thứ hai run $RUN_ID")
QG=$(qid_of "$QA")
R=$(qsend 3026 "$B-1" "$B" none)
QB=$(qid_of "$QG")
same "2. request KHÔNG có chữ ký (như request thử của Zalo khi đăng ký) → vẫn 200 quarantined, signature NULL" \
  "$(status_of "$R")|$(sql "select status || '/' || (signature is null) from recruitment_channel_quarantine where id = $QB")" "200|QUARANTINED/true"
R=$(qsend 3026 "$X-1" "$X" bad -e EVENT_TEXT="giả mạo run $RUN_ID")
QX=$(qid_of "$QB")
same "2. chữ ký sai → 200 quarantined (chưa kiểm được khi chưa có key)" "$(status_of "$R")|$(sql "select status from recruitment_channel_quarantine where id = $QX")" "200|QUARANTINED"
timeout 3 tail -f /dev/null || true
same "2. KHÔNG xử lý: 0 event inbox, 0 ứng viên, OpenClaw 0 lần (worker đang chạy)" \
  "$(sql "select count(*) from recruitment_channel_events where provider_message_id in ('$A-1','$G-1','$B-1','$X-1')")|$(sql "select count(*) from recruitment_candidates where zalo_user_id in ('$A','$G','$B','$X')")|$(mock_calls "$A-1")$(mock_calls "$G-1")$(mock_calls "$X-1")" "0|0|000"

echo "== 3. Từ chối như receiver thường"
same "3. sai app_id → 403 APP_MISMATCH" "$(R=$(qsend 3026 "$F-1" "$F" none -e EVENT_APP=app-khac); echo "$(status_of "$R")/$(jq_get "$R" code)")" "403/APP_MISMATCH"
same "3. sai OA → 403 OA_MISMATCH" "$(R=$(qsend 3026 "$F-2" "$F" none -e EVENT_OA=oa-giao-vien); echo "$(status_of "$R")/$(jq_get "$R" code)")" "403/OA_MISMATCH"
same "3. JSON hỏng → 400 (bộ đọc JSON chặn trước receiver, như receiver thường)" "$(status_of "$(qsend 3026 "$F-3" "$F" none -e RAW_BODY='xin chao')")" 400
same "3. JSON hợp lệ nhưng không phải object → 400 MALFORMED_PAYLOAD" "$(R=$(qsend 3026 "$F-4" "$F" none -e RAW_BODY='[1,2]'); echo "$(status_of "$R")/$(jq_get "$R" code)")" "400/MALFORMED_PAYLOAD"
same "3. request > 64 KB (chặn nhồi dung lượng bằng request không chữ ký) → 413 PAYLOAD_TOO_LARGE" \
  "$(R=$(qsend 3026 "$F-6" "$F" none -e EVENT_TEXT="$(head -c 70000 /dev/zero | tr '\0' a)"); echo "$(status_of "$R")/$(jq_get "$R" code)")" "413/PAYLOAD_TOO_LARGE"
same "3. request bị từ chối → không ghi dòng nào" "$(sql "select count(*) from recruitment_channel_quarantine where id >= $QA")" 4

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
same "4. bảng cách ly đầy (trần cấu hình = $CAP) → 503 QUARANTINE_FULL, không ghi" "$(status_of "$R")/$(jq_get "$R" code)|$(sql "select count(*) from recruitment_channel_quarantine where status = 'QUARANTINED'")" "503/QUARANTINE_FULL|$CAP"
same "4. bảng đầy nhưng request đã có → vẫn 200 duplicate (không bắt Zalo gửi lại vô ích)" "$(R=$(qsend 3028 "$A-1" "$A" valid -e EVENT_TEXT="$TXT_A"); echo "$(status_of "$R")/$(jq_get "$R" duplicate)")" "200/True"
docker rm -f "$C" >/dev/null

echo "== 4b. Trần MẶC ĐỊNH 2000 (instance không đặt trần): đầy → 503, không đẩy dòng cũ ra"
FILL=$((2000 - $(sql "select count(*) from recruitment_channel_quarantine where status = 'QUARANTINED'")))
sql "insert into recruitment_channel_quarantine (channel, channel_account_id, payload_hash, signature, event_type, body_size, body_enc)
     select 'ZALO', '$OA', md5('p372a-$RUN_ID-' || g) || md5('fill-' || g), null, 'user_send_text', 1, 'p372a-fill'
     from generate_series(1, $FILL) g" >/dev/null
SET_BEFORE=$(sql "select count(*) || '/' || md5(string_agg(id::text, ',' order by id)) from recruitment_channel_quarantine where status = 'QUARANTINED'")
R=$(qsend 3026 "$F-7" "$F" valid)
same "4b. đủ 2000 dòng đang cách ly → request mới 503 QUARANTINE_FULL (không 200 giả)" "$(status_of "$R")/$(jq_get "$R" code)|${SET_BEFORE%%/*}" "503/QUARANTINE_FULL|2000"
same "4b. không đẩy dòng cũ ra: đúng tập dòng đang cách ly như trước; 5 event thật còn nguyên bản mã" \
  "$(sql "select count(*) || '/' || md5(string_agg(id::text, ',' order by id)) from recruitment_channel_quarantine where status = 'QUARANTINED'")|$(sql "select count(*) from recruitment_channel_quarantine where id in ($QA, $QG, $QB, $QX, $QE) and status = 'QUARANTINED' and body_enc is not null")" \
  "$SET_BEFORE|5"
sql "delete from recruitment_channel_quarantine where body_enc = 'p372a-fill'" >/dev/null

echo "== 4c. Đồng thời: Zalo gửi lại dồn dập, nhiều tin cùng lúc, trần chính xác"
MAXID=$(sql "select coalesce(max(id), 0) from recruitment_channel_quarantine")
R=$(qpar 3026 "$S1" 20 same)
same "4c. 20 request GIỐNG HỆT gửi cùng lúc → 200×20, đúng 1 lần ghi mới, đúng 1 dòng" \
  "$(pj "$R" codes)|$(pj "$R" created)|$(sql "select count(*) from recruitment_channel_quarantine where id > $MAXID")" '{"200": 20}|1|1'
R=$(qpar 3026 "$H" 10 distinct)
same "4c. 10 tin KHÁC NHAU gửi cùng lúc → 200×10, 10 dòng mới" \
  "$(pj "$R" codes)|$(pj "$R" created)|$(sql "select count(*) from recruitment_channel_quarantine where id > $MAXID")" '{"200": 10}|10|11'
CAP2=$(( $(sql "select count(*) from recruitment_channel_quarantine where status = 'QUARANTINED'") + 5 ))
MAXID2=$(sql "select coalesce(max(id), 0) from recruitment_channel_quarantine")
"${DC[@]}" run -d --no-deps --name "$C2" -e PORT=3028 -e RECRUITMENT_ZALO_ENABLED=true -e RECRUITMENT_ZALO_WEBHOOK_QUARANTINE=true \
  -e RECRUITMENT_ZALO_OA_SECRET_KEY= -e RECRUITMENT_ZALO_QUARANTINE_MAX_ROWS="$CAP2" staging-api >/dev/null
wait_http 3028 /recruitment/ai/jobs/active
R=$(qpar 3028 "$K" 30 distinct)
same "4c. còn đúng 5 chỗ, 30 tin khác nhau CÙNG LÚC → đúng 5 nhận (200), 25 bị 503; số dòng đang cách ly = trần, không vượt" \
  "$(pj "$R" codes)|$(pj "$R" created)|$(sql "select count(*) from recruitment_channel_quarantine where status = 'QUARANTINED'")" "{\"200\": 5, \"503\": 25}|5|$CAP2"
docker rm -f "$C2" >/dev/null
sql "delete from recruitment_channel_quarantine where id > $MAXID2" >/dev/null  # 5 dòng thử trần — không thuộc phần xác minh

echo "== 5. Có key: xác minh hồi tố"
R=$(hr hr 3026 GET /recruitment/operations/webhook-quarantine)
same "5. thống kê (chế độ cách ly): chỉ số lượng, không nội dung" "$(status_of "$R")|$(jq_get "$R" mode)|$(echo "$R" | grep -c "$A" || true)" "200|QUARANTINE|0"
R=$(hr hr 3026 POST /recruitment/operations/webhook-quarantine/verify)
same "5. xác minh khi quarantine còn bật → 409 QUARANTINE_STILL_ACTIVE, không đổi gì" "$(status_of "$R")/$(jq_get "$R" code)|$(sql "select count(*) from recruitment_channel_quarantine where status = 'QUARANTINED' and id >= $QA")" "409/QUARANTINE_STILL_ACTIVE|16"
# Khoá đã có → tắt quarantine, receiver thường (kiểm chữ ký) trên cùng cổng.
docker rm -f "$Q" >/dev/null
"${DC[@]}" run -d --no-deps --name "$N" -e PORT=3026 -e RECRUITMENT_ZALO_ENABLED=true staging-api >/dev/null
wait_http 3026 /recruitment/ai/jobs/active
sql "update recruitment_channel_quarantine set received_at = now() - interval '73 hours' where id = $QE" >/dev/null
# Dừng worker quanh bước xác minh để kiểm đúng dòng inbox vừa tạo (worker xử lý xong sẽ xoá nội dung).
docker stop "$W" >/dev/null
same "5. ban giám đốc (chỉ xem) chạy xác minh → 403" "$(status_of "$(hr dir 3026 POST /recruitment/operations/webhook-quarantine/verify)")" 403
# Lỗi DB giữa chừng: ghi inbox của event G bị trigger tạm thời làm hỏng.
sql "create or replace function p372a_fail() returns trigger language plpgsql as \$\$ begin raise exception 'p372a: lỗi giả lập'; end \$\$;
     create trigger p372a_fail_g before insert on recruitment_channel_events for each row
       when (NEW.provider_message_id = '$G-1') execute function p372a_fail()" >/dev/null
# Lần 1: HAI lần xác minh chạy CÙNG LÚC (vd. hai người bấm) — mỗi dòng chỉ được một bên xử lý.
hr hr 3026 POST /recruitment/operations/webhook-quarantine/verify > "$TMPD/v1" &
hr hr 3026 POST /recruitment/operations/webhook-quarantine/verify > "$TMPD/v2" &
wait
same "5. hai lần xác minh cùng lúc: cộng lại = A + S1 + 10 H vào inbox (12), không trùng; REJECTED 2; EXPIRED 1; G lỗi DB → failed ≥ 1" \
  "$(status_of "$(cat "$TMPD/v1")")|$(status_of "$(cat "$TMPD/v2")")|$(vsum verified "$TMPD/v1" "$TMPD/v2")|$(vsum duplicates "$TMPD/v1" "$TMPD/v2")|$(vsum rejected "$TMPD/v1" "$TMPD/v2")|$(vsum expired "$TMPD/v1" "$TMPD/v2")|$(( $(vsum failed "$TMPD/v1" "$TMPD/v2") >= 1 ))" \
  "200|200|12|0|2|1|1"
same "5. mỗi event vào inbox ĐÚNG 1 lần dù hai lần xác minh chạy song song (S1 + 10 H)" \
  "$(sql "select count(*) || '/' || count(distinct provider_message_id) from recruitment_channel_events where provider_message_id = '$S1' or provider_message_id like '$H-%'")" "11/11"
same "5. dòng lỗi giữa chừng KHÔNG mất, KHÔNG vào inbox dở dang: G vẫn QUARANTINED + còn bản mã" \
  "$(sql "select status || '/' || (body_enc is not null) || '/' || coalesce(resolution_code, '-') from recruitment_channel_quarantine where id = $QG")|$(sql "select count(*) from recruitment_channel_events where provider_message_id = '$G-1'")" "QUARANTINED/true/-|0"
same "5. event ký đúng đi qua ĐÚNG đường receiver thường: inbox RECEIVED, nội dung chuẩn hoá, cùng payload hash, liên kết dòng cách ly" \
  "$(ev_of "$A-1" "status")|$(sql "select (normalized_message_text = '$TXT_A') || '/' || (payload_hash = (select payload_hash from recruitment_channel_quarantine where id = $QA)) from recruitment_channel_events where provider_message_id = '$A-1'")|$(sql "select status || '/' || resolution_code || '/' || (channel_event_id = (select id from recruitment_channel_events where provider_message_id = '$A-1')) from recruitment_channel_quarantine where id = $QA")" \
  "RECEIVED|true/true|VERIFIED/NEW/true"
same "5. request không chữ ký / chữ ký sai → REJECTED, KHÔNG vào inbox; quá hạn → EXPIRED" \
  "$(sql "select string_agg(status || '/' || resolution_code, ',' order by id) from recruitment_channel_quarantine where id in ($QB, $QX, $QE)")|$(sql "select count(*) from recruitment_channel_events where provider_message_id in ('$B-1','$X-1','$E-1')")" \
  "REJECTED/INVALID_SIGNATURE,REJECTED/INVALID_SIGNATURE,EXPIRED/RETENTION_EXPIRED|0"
sql "drop trigger p372a_fail_g on recruitment_channel_events; drop function p372a_fail()" >/dev/null
R=$(hr hr 3026 POST /recruitment/operations/webhook-quarantine/verify)
same "5. hết lỗi → chạy lại: G vào inbox đúng 1 lần (VERIFIED/NEW), failed 0, không còn gì cách ly" \
  "$(jq_get "$R" verified)|$(jq_get "$R" failed)|$(jq_get "$R" remaining)|$(sql "select status || '/' || resolution_code from recruitment_channel_quarantine where id = $QG")|$(sql "select count(*) from recruitment_channel_events where provider_message_id = '$G-1'")" \
  "1|0|0|VERIFIED/NEW|1"
same "5. mọi dòng đã kết thúc → bản mã đã xoá (CHECK bảo đảm)" "$(sql "select count(*) from recruitment_channel_quarantine where id >= $QA and body_enc is not null")" 0
docker start "$W" >/dev/null; wait_http 3027 /recruitment/ai/jobs/active
wait_sql 90 "select count(*) = 13 and bool_and(status = 'PROCESSED') from recruitment_channel_events where provider_message_id in ('$A-1', '$G-1', '$S1') or provider_message_id like '$H-%'" || true
same "5. sau xác minh, event đi tiếp bình thường: worker xử lý A, G, S1 + 10 H (OpenClaw đúng 1 lần mỗi tin) → PROCESSED" \
  "$(sql "select count(*) filter (where status = 'PROCESSED') from recruitment_channel_events where provider_message_id in ('$A-1', '$G-1', '$S1') or provider_message_id like '$H-%'")|$(mock_calls "$A-1")$(mock_calls "$G-1")$(mock_calls "$S1")|$(mock_calls "$H-")" "13|111|10"
same "5. event bị từ chối không bao giờ tới OpenClaw" "$(mock_calls "$B-1")$(mock_calls "$X-1")$(mock_calls "$E-1")" "000"
R=$(hr hr 3026 POST /recruitment/operations/webhook-quarantine/verify)
same "5. chạy xác minh lần 3 → không còn gì, không ghi thêm" "$(jq_get "$R" verified)|$(jq_get "$R" duplicates)|$(jq_get "$R" rejected)|$(jq_get "$R" failed)|$(sql "select count(*) from recruitment_channel_events where provider_message_id in ('$A-1', '$G-1')")" "0|0|{}|0|2"
R=$(qsend 3026 "$A-1" "$A" valid -e EVENT_TEXT="$TXT_A")
same "5. Zalo gửi lại event đó tới receiver thường (đã có key) → 200 duplicate=true (chống trùng chung)" "$(status_of "$R")|$(jq_get "$R" duplicate)|$(sql "select count(*) from recruitment_channel_events where provider_message_id = '$A-1'")" "200|True|1"
same "5. receiver thường (có key) từ chối request không chữ ký → 401, không cách ly" \
  "$(status_of "$(qsend 3026 "$F-5" "$F" none)")|$(sql "select count(*) from recruitment_channel_quarantine where id >= $QA")" "401|16"
same "5. audit CHANNEL_QUARANTINE_VERIFY: 3 lần chạy, đúng nhân viên HR, chỉ số lượng" \
  "$(sql "select count(*) >= 3 and bool_and(\"actorId\" = $HR_ID) and bool_and(context::text not like '%$A%' and context::text not like '%run $RUN_ID%') from activity_log where method = 'CHANNEL_QUARANTINE_VERIFY' and \"createdAt\" >= '$T0'")" t

echo "== 6. Log / OA giáo viên"
LEAK=$( { docker logs "$Q" 2>&1 || true; docker logs "$N" 2>&1; docker logs "$W" 2>&1; } | grep -cF -f <(printf '%s\n' "$A" "$G" "$B" "$X" "$E" "$S1" "$H" "$K" "run $RUN_ID" "Ngọc" "Tin song song"; sed -n 's/^STAGING_ZALO_OA_SECRET_KEY=//p;s/^STAGING_ZALO_TOKEN_KEY=//p' "$ENV_FILE") || true)
same "6. log receiver/worker: 0 nội dung, 0 id người gửi, 0 secret" "$LEAK" 0
same "6. token OA giáo viên không đổi" "$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || access_token || refresh_token, ',' order by id)), '-') from zalo_tokens")" "$TEACHER_BEFORE"
if git -C "$REPO" diff --quiet "$TEACHER_BASELINE" HEAD -- src/zalo-oa src/zalo-token src/notify-zalo src/main.ts; then ok "6. code OA giáo viên không đổi so với production baseline"; else ko "6. code OA giáo viên không đổi so với production baseline"; fi

echo "== 7. Gỡ migration không được xoá request đang cách ly"
sql "insert into recruitment_channel_quarantine (channel, channel_account_id, payload_hash, event_type, body_size, body_enc)
     values ('ZALO', '$OA', md5('p372a-hold-$RUN_ID') || md5('hold'), 'user_send_text', 1, 'p372a-hold')" >/dev/null
DOWN=$("${DC[@]}" run --rm --no-deps -T staging-api node - dist/migrations/1792600000000-add-recruitment-webhook-quarantine.js down < staging/run-migration.js 2>&1 | grep -E "OK|LỖI" || true)
if echo "$DOWN" | grep -q "OK"; then
  # Không được xảy ra — dựng lại bảng để staging không hỏng, rồi báo lỗi.
  "${DC[@]}" run --rm --no-deps -T staging-api node - dist/migrations/1792600000000-add-recruitment-webhook-quarantine.js up < staging/run-migration.js >/dev/null 2>&1 || true
fi
same "7. còn dòng QUARANTINED → gỡ migration bị chặn (rollback), bảng + dòng còn nguyên" \
  "$(echo "$DOWN" | grep -c 'LỖI — đã rollback: còn request đang cách ly')|$(sql "select count(*) from recruitment_channel_quarantine where body_enc = 'p372a-hold'")" "1|1"
sql "delete from recruitment_channel_quarantine where body_enc = 'p372a-hold'" >/dev/null

echo "  $(scripts/outbox-fixture-cleanup.sh "P3-7.2A acceptance run $RUN_ID: dọn outbox do worker tạo")"
echo "== Kết quả: $PASS đạt, $FAIL lỗi (run $RUN_ID)"
[ "$FAIL" -eq 0 ]
