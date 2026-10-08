#!/bin/bash
# Acceptance P3-5 — outbox → Zalo Send API của OA tuyển dụng, trên staging (PostgreSQL thật)
# với Zalo GIẢ (staging/fake-zalo.js: 200/401/429/5xx/504/treo/cắt kết nối/đóng cổng).
#
#   0. SQL PREPARE; dọn outbox fixture cũ (backup + manifest); Zalo giả; nạp token giả
#   1. kill switch tắt → 0 kết nối
#   2. 2 sender: gửi một lần, thứ tự theo người nhận, song song giữa người nhận, redact
#   3. 429 / 5xx / cổng đóng → RETRY; treo / cắt kết nối / 504 / rác → UNKNOWN không gửi lại
#   4. từ chối vĩnh viễn / chưa phân loại → DEAD_LETTER; token hết hạn → refresh đúng 1 lần
#   5. sender chết sau dispatch → UNKNOWN; chết trước dispatch → gửi lại an toàn
#   6. người nhận lệch hội thoại / OA khác → không gửi; log; OA giáo viên; E2E đủ luồng
#
#   integrations/openclaw/scripts/zalo-outbound-acceptance.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(cd ../.. && pwd)"
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
RUN_ID="$(date +%s)"
OA=stg-recruit-oa
Z="z${RUN_ID}"
FAKE="kido-p35-zalo-$RUN_ID"; S1="kido-p35-s1-$RUN_ID"; S2="kido-p35-s2-$RUN_ID"
OFF="kido-p35-off-$RUN_ID"; MOCK="kido-p35-mock-$RUN_ID"; W="kido-p35-w-$RUN_ID"
PASS=0
FAIL=0

sql() { "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -At -c "$1"; }
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; if [ -n "${2:-}" ]; then echo "    → $2"; fi; }
same() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "thực tế [$2], mong đợi [$3]"; fi; }
check() { if [ "$2" = t ]; then ok "$1"; else ko "$1" "${3:-}"; fi; }
node_in_api() { "${DC[@]}" exec -T staging-api node -e "$1"; }
wait_sql() { local end=$((SECONDS + $1)); while [ $SECONDS -lt $end ]; do [ "$(sql "$2")" = t ] && return 0; timeout 0.3 tail -f /dev/null || true; done; return 1; }
wait_check() { if wait_sql "$2" "$3"; then ok "$1"; else ko "$1" "điều kiện không xảy ra trong $2s"; fi; }
wait_http() {
  for _ in $(seq 1 90); do
    node_in_api "fetch('http://localhost:$1$2').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && return 0
    timeout 1 tail -f /dev/null || true
  done
  echo "cổng $1 không lên" >&2; return 1
}
# Lệnh admin Zalo giả qua `docker compose exec` — idempotent nên thử lại tối đa 3 lần (đã gặp
# một lần exec trả 255 không thông báo); lần nào phải thử lại đều in cảnh báo, không che giấu.
admin_call() {
  local n
  for n in 1 2 3; do
    if node_in_api "$1"; then return 0; fi
    echo "  ⚠ lệnh admin Zalo giả lỗi (lần $n) — thử lại" >&2
  done
  return 1
}
fz_get() { admin_call "fetch('http://localhost:3199$1').then(r=>{if(!r.ok)process.exit(3);return r.text()}).then(t=>process.stdout.write(t))"; }
fz_post() { # fz_post <đường dẫn> [object JS]
  local body="${2:-}"; [ -n "$body" ] || body='{}'
  local js="fetch('http://localhost:3199$1',{method:'POST',body:JSON.stringify($body)}).then(r=>{if(!r.ok)process.exit(3)})"
  # /__down không idempotent (đóng/mở cổng theo hẹn giờ) → không thử lại.
  if [ "$1" = /__down ]; then node_in_api "$js"; else admin_call "$js"; fi
}
fz_log() { fz_get /__log; }
# Kết quả Zalo giả nhận cho một nội dung tin (khớp theo hash 16 ký tự).
results_for() { fz_log | python3 -c "
import hashlib, json, sys
h = hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16]
print(','.join(e['result'] or '?' for e in json.load(sys.stdin) if e['textSha'] == h))" "$1"; }
ob() { sql "select $2 from recruitment_channel_outbox where id = $1"; }
text_of() { echo "Tin nhắn $2 cho $1 — run $RUN_ID"; }
# mk <người nhận> <khoá> [OA] [người nhận của hội thoại] [trạng thái] → id outbox. Dựng đủ chuỗi
# tin cậy: ứng viên (OA, người) → hội thoại ZALO <OA>:<người> → event đã xử lý → tin đi AI → outbox.
mk() {
  local r=$1 key=$2 oa=${3:-$OA} conv=${4:-$1} status=${5:-PENDING}
  local text; text=$(text_of "$r" "$key")
  sql "WITH cand AS (
     INSERT INTO recruitment_candidates (zalo_oa_id, zalo_user_id, source) VALUES ('$oa', '$conv', 'ZALO')
     ON CONFLICT (zalo_oa_id, zalo_user_id) WHERE zalo_user_id IS NOT NULL DO UPDATE SET updated_at = now() RETURNING id),
   conv AS (
     INSERT INTO recruitment_conversations (candidate_id, channel, external_conversation_id)
     SELECT id, 'ZALO', '$oa:$conv' FROM cand
     ON CONFLICT (channel, external_conversation_id) WHERE external_conversation_id IS NOT NULL
     DO UPDATE SET updated_at = now() RETURNING id),
   ev AS (
     INSERT INTO recruitment_channel_events (channel, channel_account_id, dedupe_key, external_sender_id,
       event_type, provider_message_id, status, payload_hash, processed_at)
     VALUES ('ZALO', '$oa', 'p35:$RUN_ID:$key', '$conv', 'user_send_text', 'p35-$RUN_ID-$key', 'PROCESSED', repeat('0', 64), now())
     RETURNING id),
   msg AS (
     INSERT INTO recruitment_messages (conversation_id, external_message_id, sender_type, direction, content)
     SELECT id, 'p35-$RUN_ID-$key-reply', 'AI', 'OUTBOUND', '$text' FROM conv RETURNING id)
   INSERT INTO recruitment_channel_outbox (source_event_id, channel, channel_account_id, external_recipient_id,
     message_text, recruitment_message_id, status, lease_owner, lease_until, attempt_count)
   SELECT ev.id, 'ZALO', '$oa', '$r', '$text', msg.id, '$status',
     CASE WHEN '$status' = 'SENDING' THEN 'dead-host:1:dead00:nonce' END,
     CASE WHEN '$status' = 'SENDING' THEN now() - interval '1 minute' END,
     CASE WHEN '$status' = 'SENDING' THEN 1 ELSE 0 END
   FROM ev, msg RETURNING id" | head -1
}
start_sender() { # start_sender <tên> <cổng> [-e ...]
  local name=$1 port=$2; shift 2
  "${DC[@]}" run -d --no-deps --name "$name" -e PORT="$port" \
    -e RECRUITMENT_ZALO_SENDER_CONCURRENCY=3 -e RECRUITMENT_ZALO_SENDER_POLL_MS=200 \
    -e RECRUITMENT_ZALO_SENDER_LEASE_MS=6000 -e RECRUITMENT_ZALO_SENDER_RETRY_BASE_MS=2000 \
    -e RECRUITMENT_ZALO_SENDER_RETRY_MAX_MS=3000 -e RECRUITMENT_ZALO_CONNECT_TIMEOUT_MS=1000 \
    -e RECRUITMENT_ZALO_RESPONSE_TIMEOUT_MS=5000 -e RECRUITMENT_ZALO_PERMANENT_ERRORS=-213 "$@" \
    -e NODE_OPTIONS=--require=/run/kido/net-tap.js -v "$PWD/staging/net-tap.js:/run/kido/net-tap.js:ro" \
    staging-api >/dev/null
  wait_http "$port" /recruitment/ai/jobs/active
}
sender_tag() { docker logs "$1" 2>&1 | grep -o 'sender start id=[^ ]*' | tail -1 | cut -d= -f2 | cut -d: -f3; }
taps() { docker exec "$1" sh -c 'cat /tmp/net-tap.jsonl 2>/dev/null || true'; }
cleanup() { docker rm -f "$FAKE" "$S1" "$S2" "$OFF" "$MOCK" "$W" >/dev/null 2>&1 || true; }
on_error() { # dừng bất thường: in dòng lỗi + log Zalo giả (không có token) để chẩn đoán
  echo "  ✗ script dừng ở dòng $1 (exit $2)" >&2
  docker logs --tail 20 "$FAKE" 2>&1 | sed 's/^/    fake-zalo: /' >&2 || true
}
trap 'on_error $LINENO $?' ERR
trap cleanup EXIT

echo "== 0. Chuẩn bị (run $RUN_ID)"
PREP=$( { echo "BEGIN;"; python3 - "$REPO" <<'PY'
import re, sys
root = sys.argv[1]
files = ['src/recruitment/channels/recruitment-channel-event.queue.ts', 'src/recruitment/channels/recruitment-zalo-webhook.service.ts',
         'src/recruitment/channels/recruitment-channel-outbox.queue.ts', 'src/recruitment/channels/recruitment-zalo-credential.store.ts',
         'src/recruitment/channels/recruitment-zalo-sender.service.ts']
for n, f in enumerate(files):
    src = open(f'{root}/{f}').read()
    unfinished = re.search(r"const UNFINISHED = `([^`]*)`", src)
    for i, m in enumerate(re.finditer(r'query\(\s*`([^`]*)`', src)):
        sql = m.group(1).replace('${EVENT_TEXT_RETENTION_DAYS}', '7').replace('${OUTBOX_TEXT_RETENTION_DAYS}', '7')
        if unfinished: sql = sql.replace('${UNFINISHED}', unfinished.group(1))
        print(f"PREPARE q{n}_{i} AS {sql};")
PY
echo "ROLLBACK;"; } | "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -v ON_ERROR_STOP=1 2>&1)
check "mọi câu SQL của webhook/worker/outbox/credential/sender hợp lệ trên schema thật ($(echo "$PREP" | grep -c '^PREPARE') câu)" \
  "$(echo "$PREP" | grep -q ERROR && echo f || echo t)" "$(echo "$PREP" | grep ERROR)"
CLEAN=$(scripts/outbox-fixture-cleanup.sh "P3-5 acceptance run $RUN_ID: dọn outbox còn gửi được trước khi bật sender")
echo "  $CLEAN"
check "17. outbox cũ còn gửi được = 0 trước khi bất kỳ sender nào chạy" \
  "$(sql "select count(*) = 0 from recruitment_channel_outbox where status in ('PENDING','SENDING','RETRY','UNKNOWN')")"
TEACHER_BEFORE="$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || access_token || refresh_token, ',' order by id)), '-') from zalo_tokens")|$(sql "select count(*) from employee where zalo_user_id is not null")"
"${DC[@]}" run -d --no-deps --name "$FAKE" -v "$PWD/staging/fake-zalo.js:/run/kido/fake-zalo.js:ro" \
  staging-api node /run/kido/fake-zalo.js >/dev/null
wait_http 3199 /__state
echo "  $("${DC[@]}" exec -T staging-api node - < staging/seed-zalo-credentials.js)"
ENC=$(sql "select access_token_enc || ' ' || refresh_token_enc from recruitment_zalo_credentials where oa_id = '$OA'")
check "token OA tuyển dụng trong DB đã mã hoá (v1.<iv>.<tag>.<ct>, không chứa token gốc)" \
  "$(fz_get /__seed | python3 -c "
import json, sys
seed, enc = json.load(sys.stdin), sys.argv[1]
print('t' if enc.startswith('v1.') and seed['access_token'] not in enc and seed['refresh_token'] not in enc else 'f')" "$ENC")"

echo "== 1. Kill switch: RECRUITMENT_ZALO_OUTBOUND_ENABLED=false"
K1=$(mk "${Z}k1" k1); K2=$(mk "${Z}k2" k2)
"${DC[@]}" run -d --no-deps --name "$OFF" -e PORT=3024 \
  -e NODE_OPTIONS=--require=/run/kido/net-tap.js -v "$PWD/staging/net-tap.js:/run/kido/net-tap.js:ro" staging-api >/dev/null
wait_http 3024 /recruitment/ai/jobs/active
timeout 8 tail -f /dev/null || true
same "16. cờ tắt: outbox vẫn PENDING, chưa lần thử nào" "$(sql "select string_agg(status || '/' || attempt_count, ',' order by id) from recruitment_channel_outbox where id in ($K1, $K2)")" "PENDING/0,PENDING/0"
same "16. cờ tắt: 0 kết nối ra (Zalo giả / Zalo thật / nơi khác ngoài DB)" \
  "$(taps "$OFF" | python3 -c "import json,sys; print(sum(1 for l in sys.stdin if l.strip() and json.loads(l)['port'] != 5432))")/$(fz_log | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" "0/0"
docker rm -f "$OFF" >/dev/null

echo "== 2. Hai sender: gửi một lần, thứ tự theo người nhận, song song giữa người nhận"
fz_post /__mode "{mode:'slow',delayMs:700}"
start_sender "$S1" 3022 -e RECRUITMENT_ZALO_OUTBOUND_ENABLED=true
start_sender "$S2" 3023 -e RECRUITMENT_ZALO_OUTBOUND_ENABLED=true
IDS="$K1,$K2"
for n in 1 2 3; do for r in a b c; do IDS="$IDS,$(mk "${Z}$r" "$r$n")"; done; done
if wait_sql 90 "select count(*) = 11 from recruitment_channel_outbox where id in ($IDS) and status = 'SENT'"; then
  ok "1. 11/11 dòng PENDING → claim → Zalo 200 → SENT (kể cả 2 dòng tạo lúc cờ tắt)"
else ko "1. 11 dòng SENT" "$(sql "select string_agg(id || ':' || status || ':' || coalesce(last_error_code,'-'), ' ') from recruitment_channel_outbox where id in ($IDS)")"; fi
same "2. SENT: message_text = NULL, có id tin Zalo, sent_at; mỗi dòng 1 lần thử" \
  "$(sql "select count(*) from recruitment_channel_outbox where id in ($IDS) and status = 'SENT' and message_text is null and text_redacted_at is not null and provider_message_id like 'fz-%' and sent_at is not null and attempt_count = 1")" 11
A=$(fz_log | python3 -c "
import hashlib, itertools, json, sys
run, z = sys.argv[1], sys.argv[2]
text = lambda r, k: f'Tin nhắn {k} cho {r} — run {run}'
h = lambda t: hashlib.sha256(t.encode()).hexdigest()[:16]
want = {h(text(z + r, r + str(n))): (r, n) for r in 'abc' for n in (1, 2, 3)}
want.update({h(text(z + 'k1', 'k1')): ('k1', 1), h(text(z + 'k2', 'k2')): ('k2', 1)})
log = [e for e in json.load(sys.stdin) if e['textSha'] in want]
once = len(log) == 11 and len({e['textSha'] for e in log}) == 11
ordered, no_overlap = True, True
for r in 'abc':
    reqs = sorted([e for e in log if want[e['textSha']][0] == r], key=lambda e: e['t0'])
    ordered &= [want[e['textSha']][1] for e in reqs] == [1, 2, 3]
    no_overlap &= all(a['t1'] is not None and a['t1'] <= b['t0'] for a, b in zip(reqs, reqs[1:]))
parallel = any(want[a['textSha']][0] != want[b['textSha']][0] and a['t0'] < b['t1'] and b['t0'] < a['t1'] for a, b in itertools.combinations(log, 2))
right = all(e['recipient'] == z + want[e['textSha']][0] and e['tokenOk'] for e in log)
print(' '.join('t' if x else 'f' for x in (once, ordered, no_overlap, parallel, right)))" "$RUN_ID" "$Z")
read -r A_ONCE A_ORDER A_NOOVERLAP A_PARALLEL A_RIGHT <<< "$A"
check "3. 2 sender: mỗi dòng outbox tới Zalo đúng 1 lần" "$A_ONCE"
check "4. 3 tin cùng người nhận: gửi đúng thứ tự tạo (1→2→3)" "$A_ORDER"
check "4. cùng người nhận: không có hai lần gửi chồng nhau" "$A_NOOVERLAP"
check "5. người nhận khác nhau: gửi song song" "$A_PARALLEL"
check "gửi đúng người nhận theo outbox, kèm access token hợp lệ" "$A_RIGHT"
T1=$(sender_tag "$S1"); T2=$(sender_tag "$S2")
echo "  (phân bổ: $(sql "select string_agg(t || '×' || n, ', ') from (select split_part(lease_owner, ':', 3) t, count(*) n from recruitment_channel_outbox where id in ($IDS) group by 1) x") — $S1=$T1, $S2=$T2)"

echo "== 3. Lỗi tạm: RETRY (chắc chắn chưa gửi) — không mất tin"
fz_post /__mode "{mode:'429',times:1,then:{mode:'ok'}}"
D1=$(mk "${Z}d" d1)
wait_check "7. Zalo 429 → RETRY có lịch, giữ nội dung" 15 \
  "select count(*) = 1 from recruitment_channel_outbox where id = $D1 and status = 'RETRY' and last_error_code = 'PROVIDER_RATE_LIMIT' and next_attempt_at is not null and message_text is not null"
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $D1" || true
same "7. sau backoff → SENT ở lần 2; Zalo nhận: 429 rồi 200" "$(ob "$D1" "status || '/' || attempt_count")|$(results_for "$(text_of "${Z}d" d1)" | sed 's/:fz-[0-9]*//g')" "SENT/2|429,200"
fz_post /__mode "{mode:'500',times:1,then:{mode:'503',times:1,then:{mode:'ok'}}}"
E1=$(mk "${Z}e" e1)
wait_check "8. Zalo 500 → RETRY" 15 "select count(*) = 1 from recruitment_channel_outbox where id = $E1 and status = 'RETRY' and last_error_code = 'PROVIDER_5XX'"
wait_sql 30 "select status = 'SENT' from recruitment_channel_outbox where id = $E1" || true
same "8. 500 → 503 → 200: SENT ở lần 3" "$(ob "$E1" "status || '/' || attempt_count")|$(results_for "$(text_of "${Z}e" e1)" | sed 's/:fz-[0-9]*//g')" "SENT/3|500,503,200"
fz_post /__down "{ms:6000}"
G1=$(mk "${Z}g" g1)
wait_check "11. cổng Zalo đóng (request chưa đi) → RETRY NETWORK_BEFORE_SEND, giữ nội dung" 15 \
  "select count(*) = 1 from recruitment_channel_outbox where id = $G1 and status = 'RETRY' and last_error_code = 'NETWORK_BEFORE_SEND' and message_text is not null and dispatched_at is null"
wait_sql 30 "select status = 'SENT' from recruitment_channel_outbox where id = $G1" || true
same "11. cổng mở lại → SENT; Zalo chỉ nhận đúng 1 request (các lần bị từ chối chưa tới)" "$(ob "$G1" "status")|$(results_for "$(text_of "${Z}g" g1)" | sed 's/:fz-[0-9]*//g')" "SENT|200"

echo "== 4. Có thể đã tới Zalo → UNKNOWN, không gửi lại; tin sau của người đó phải chờ"
fz_post /__mode "{mode:'hang',times:1,then:{mode:'ok'}}"
H1=$(mk "${Z}h" h1); H2=$(mk "${Z}h" h2)
wait_sql 20 "select status = 'UNKNOWN' from recruitment_channel_outbox where id = $H1" || true
timeout 8 tail -f /dev/null || true
same "12. Zalo nhận rồi không trả lời → UNKNOWN (RESPONSE_TIMEOUT); sau 8s vẫn không gửi lại" \
  "$(ob "$H1" "status || '/' || last_error_code")|$(results_for "$(text_of "${Z}h" h1)")" "UNKNOWN/RESPONSE_TIMEOUT|hang"
same "4/12. tin thứ 2 của cùng người nhận KHÔNG vượt dòng UNKNOWN: vẫn PENDING, Zalo chưa nhận" \
  "$(ob "$H2" "status || '/' || attempt_count")|$(results_for "$(text_of "${Z}h" h2)")" "PENDING/0|"
same "12. UNKNOWN có audit cho vận hành (không nội dung)" \
  "$(sql "select count(*) from activity_log where method = 'CHANNEL_OUTBOX_UNKNOWN' and path = '/recruitment-channel-outbox/$H1' and \"beforeData\" is null and \"afterData\" is null")" 1
for spec in "drop:CONNECTION_LOST:i" "504:PROVIDER_GATEWAY_TIMEOUT:j" "garbage:PROVIDER_UNPARSEABLE:l"; do
  IFS=: read -r MODE CODE R <<< "$spec"
  fz_post /__mode "{mode:'$MODE',times:1,then:{mode:'ok'}}"
  X=$(mk "${Z}$R" "${R}1")
  wait_sql 20 "select status = 'UNKNOWN' from recruitment_channel_outbox where id = $X" || true
  timeout 4 tail -f /dev/null || true
  same "12. Zalo '$MODE' → UNKNOWN ($CODE), chỉ 1 request, không tự gửi lại" \
    "$(ob "$X" "status || '/' || last_error_code")|$(results_for "$(text_of "${Z}$R" "${R}1")" | tr ',' '\n' | grep -c .)" "UNKNOWN/$CODE|1"
done

echo "== 5. Từ chối → DEAD_LETTER; token hết hạn → refresh đúng 1 lần"
fz_post /__mode "{mode:'reject',times:1,then:{mode:'ok'}}"
P1=$(mk "${Z}p" p1)
wait_sql 20 "select status = 'DEAD_LETTER' from recruitment_channel_outbox where id = $P1" || true
same "10. từ chối vĩnh viễn (-213 khai trong RECRUITMENT_ZALO_PERMANENT_ERRORS) → DEAD_LETTER ngay + audit" \
  "$(ob "$P1" "status || '/' || last_error_code || '/' || attempt_count")|$(sql "select count(*) from activity_log where method = 'CHANNEL_OUTBOX_DEAD_LETTER' and path = '/recruitment-channel-outbox/$P1'")" "DEAD_LETTER/ZALO_-213/1|1"
fz_post /__mode "{mode:'reject-unknown',times:3,then:{mode:'ok'}}"
Q1=$(mk "${Z}q" q1)
wait_sql 40 "select status = 'DEAD_LETTER' from recruitment_channel_outbox where id = $Q1" || true
same "10. mã từ chối chưa phân loại → thử lại tối đa 3 lần rồi DEAD_LETTER" \
  "$(ob "$Q1" "status || '/' || last_error_code || '/' || attempt_count")|$(results_for "$(text_of "${Z}q" q1)")" "DEAD_LETTER/ZALO_-230/3|-230,-230,-230"
fz_post /__mode "{mode:'ok'}"
fz_post /__refresh-delay "{ms:1500}"
fz_post /__expire
REFRESH0=$(fz_get /__state | python3 -c 'import json,sys; print(json.load(sys.stdin)["refreshCount"])')
VER0=$(sql "select version from recruitment_zalo_credentials where oa_id = '$OA'")
MIDS=""
for i in 1 2 3 4 5 6; do MIDS="$MIDS${MIDS:+,}$(mk "${Z}m$i" "m$i")"; done
wait_sql 40 "select count(*) = 6 from recruitment_channel_outbox where id in ($MIDS) and status = 'SENT'" || true
STATE=$(fz_get /__state)
same "9. token hết hạn: 6 tin (2 sender song song) → refresh ĐÚNG 1 lần, không dùng lại refresh token cũ, 6/6 SENT" \
  "$(echo "$STATE" | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['refreshCount'] - $REFRESH0, s['refreshRejected'])")|$(sql "select version - $VER0 from recruitment_zalo_credentials where oa_id = '$OA'")|$(sql "select count(*) from recruitment_channel_outbox where id in ($MIDS) and status = 'SENT'")" \
  "1 0|1|6"
same "9. có lần gửi bị từ chối vì token cũ rồi gửi lại bằng token mới" \
  "$(fz_log | python3 -c "
import json, sys
z = sys.argv[1]
log = [e for e in json.load(sys.stdin) if (e['recipient'] or '').startswith(z + 'm')]
print(any(not e['tokenOk'] for e in log), sum(1 for e in log if e['tokenOk'] and e['result'].startswith('200')))" "$Z")" "True 6"
fz_post /__refresh-delay "{ms:0}"

echo "== 6. Sender chết khi đang SENDING"
fz_post /__mode "{mode:'slow',delayMs:15000,times:1,then:{mode:'ok'}}"
V1=$(mk "${Z}v" v1)
wait_sql 15 "select dispatched_at is not null from recruitment_channel_outbox where id = $V1" || true
for _ in $(seq 1 20); do [ -n "$(results_for "$(text_of "${Z}v" v1)")" ] && break; timeout 0.2 tail -f /dev/null || true; done
OWNER=$(ob "$V1" "split_part(lease_owner, ':', 3)")
if [ "$OWNER" = "$(sender_tag "$S1")" ]; then VICTIM=$S1; else VICTIM=$S2; fi
docker kill "$VICTIM" >/dev/null
echo "  (request đã tới Zalo giả, sender $OWNER đang chờ → kill $VICTIM)"
wait_sql 30 "select status = 'UNKNOWN' from recruitment_channel_outbox where id = $V1" || true
same "6. chết SAU khi dispatch → lease hết hạn → UNKNOWN (LEASE_EXPIRED_AFTER_DISPATCH), không gửi lại" \
  "$(ob "$V1" "status || '/' || last_error_code")|$(results_for "$(text_of "${Z}v" v1)" | tr ',' '\n' | grep -c .)" "UNKNOWN/LEASE_EXPIRED_AFTER_DISPATCH|1"
docker start "$VICTIM" >/dev/null && wait_http "$([ "$VICTIM" = "$S1" ] && echo 3022 || echo 3023)" /recruitment/ai/jobs/active
N1=$(mk "${Z}n" n1 "$OA" "${Z}n" SENDING)
wait_sql 20 "select status = 'SENT' from recruitment_channel_outbox where id = $N1" || true
same "6. chết TRƯỚC khi dispatch (SENDING, lease hết hạn, chưa dispatch) → claim lại → SENT một lần" \
  "$(ob "$N1" "status || '/' || attempt_count")|$(results_for "$(text_of "${Z}n" n1)" | sed 's/:fz-[0-9]*//g')" "SENT/2|200"

echo "== 7. Không gửi khi dữ liệu không khớp nguồn tin cậy"
X1=$(mk "${Z}x" x1 "$OA" "${Z}y")
O1=$(mk "${Z}o" o1 stg-other-oa)
wait_sql 15 "select status = 'DEAD_LETTER' from recruitment_channel_outbox where id = $X1" || true
timeout 4 tail -f /dev/null || true
same "14. người nhận outbox ≠ người của hội thoại canonical → DEAD_LETTER RECIPIENT_MISMATCH, không gửi" \
  "$(ob "$X1" "status || '/' || last_error_code")|$(fz_log | python3 -c "import json,sys; print(sum(1 for e in json.load(sys.stdin) if e['recipient'] in ('${Z}x', '${Z}y')))")" "DEAD_LETTER/RECIPIENT_MISMATCH|0"
same "15. outbox của OA khác OA tuyển dụng → sender không nhận, không gửi" \
  "$(ob "$O1" "status || '/' || attempt_count")|$(fz_log | python3 -c "import json,sys; print(sum(1 for e in json.load(sys.stdin) if e['recipient'] == '${Z}o'))")" "PENDING/0|0"
sql "delete from recruitment_channel_outbox where id = $O1" >/dev/null

echo "== 8. E2E: webhook → inbox → worker (OpenClaw giả) → outbox → sender → Zalo giả"
"${DC[@]}" run -d --no-deps --name "$MOCK" -e MOCK_PORT=3099 \
  -v "$PWD/staging/mock-openclaw.js:/run/kido/mock-openclaw.js:ro" staging-api node /run/kido/mock-openclaw.js >/dev/null
wait_http 3099 /__log
"${DC[@]}" run -d --no-deps --name "$W" -e PORT=3025 -e RECRUITMENT_WORKER_ENABLED=true \
  -e RECRUITMENT_OPENCLAW_URL=http://localhost:3099 -e RECRUITMENT_WORKER_POLL_MS=300 staging-api >/dev/null
wait_http 3025 /recruitment/ai/jobs/active
"${DC[@]}" exec -T -e TARGET_PORT=3021 -e "EVENT_TEXT=Chào bạn, mình muốn hỏi lịch phỏng vấn" staging-api \
  node - send "$RUN_ID" "p35-$RUN_ID-e2e" "${Z}w" < staging/zalo-webhook-acceptance.js >/dev/null
wait_sql 60 "select count(*) = 1 from recruitment_channel_outbox o join recruitment_channel_events e on e.id = o.source_event_id where e.provider_message_id = 'p35-$RUN_ID-e2e' and o.status = 'SENT'" || true
REPLY=$(sql "select m.content from recruitment_messages m where m.external_message_id = 'p35-$RUN_ID-e2e-reply'")
same "E2E: inbox PROCESSED (nội dung đã xoá) → outbox SENT (đã redact) → Zalo nhận đúng tin đi canonical, đúng người" \
  "$(sql "select e.status || '/' || (e.normalized_message_text is null) || '/' || o.status || '/' || (o.message_text is null) from recruitment_channel_events e join recruitment_channel_outbox o on o.source_event_id = e.id where e.provider_message_id = 'p35-$RUN_ID-e2e'")|$(fz_log | python3 -c "
import hashlib, json, sys
h = hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16]
print(sum(1 for e in json.load(sys.stdin) if e['textSha'] == h and e['recipient'] == sys.argv[2] and e['result'].startswith('200')))" "$REPLY" "${Z}w")" \
  "PROCESSED/true/SENT/true|1"

echo "== 9. Không trùng, không lộ, không chạm OA giáo viên"
same "13. sender không tạo tin canonical nào: mỗi fixture đúng 1 tin (tin đi AI) trong hội thoại" \
  "$(sql "select count(*) || '/' || count(*) filter (where m.external_message_id like '%-reply' and m.direction = 'OUTBOUND')
          from recruitment_messages m join recruitment_conversations c on c.id = m.conversation_id
          where c.external_conversation_id like '%:${Z}%' and c.external_conversation_id <> '$OA:${Z}w'")" \
  "$(sql "select count(*) || '/' || count(*) from recruitment_channel_events where dedupe_key like 'p35:$RUN_ID:%'")"
same "17. Zalo giả chỉ nhận tin của run này — 0 fixture cũ bị gửi" \
  "$(fz_log | python3 -c "import json,sys; print(sum(1 for e in json.load(sys.stdin) if not (e['recipient'] or '').startswith('$Z')))")" 0
OUTSIDE=$( { taps "$S1"; taps "$S2"; } | python3 -c "
import json, sys
rows = [json.loads(l) for l in sys.stdin if l.strip()]
print(sum(1 for r in rows if r['port'] not in (5432, 3198)))")
same "sender chỉ kết nối DB + Zalo giả (0 kết nối tới Zalo thật / nơi khác)" "$OUTSIDE" 0
LEAK=$( { docker logs "$S1" 2>&1; docker logs "$S2" 2>&1; docker logs "$W" 2>&1; } | grep -cF -f <(fz_get /__issued | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)))'; printf '%s\n' "$Z" "Tin nhắn" "Chào bạn"; sed -n 's/^STAGING_ZALO_APP_SECRET=//p;s/^STAGING_ZALO_TOKEN_KEY=//p' "$ENV_FILE") || true)
same "18. log sender/worker: 0 token, 0 id người nhận, 0 nội dung tin, 0 secret" "$LEAK" 0
same "19. token + liên kết Zalo của OA giáo viên không đổi" \
  "$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || access_token || refresh_token, ',' order by id)), '-') from zalo_tokens")|$(sql "select count(*) from employee where zalo_user_id is not null")" "$TEACHER_BEFORE"
if git -C "$REPO" diff --quiet master HEAD -- src/zalo-oa src/zalo-token src/notify-zalo src/main.ts; then ok "19. code OA giáo viên (zalo-oa, zalo-token, notify-zalo, main.ts) không đổi so với master"; else ko "19. code OA giáo viên không đổi so với master"; fi
RT=$(node_in_api "fetch('http://localhost:3021/zalo/oa/webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))")
same "19. /zalo/oa/webhook không chữ ký → 403 như trước" "$RT" 403
JEST=$(cd "$REPO" && npx jest src/zalo-oa 2>&1 | grep -E '^Tests:' || true)
if echo "$JEST" | grep -qE 'Tests: +[0-9]+ passed, [0-9]+ total' && ! echo "$JEST" | grep -q failed; then ok "19. unit test OA giáo viên: $JEST"; else ko "19. unit test OA giáo viên" "$JEST"; fi

echo "== Kết quả: $PASS đạt, $FAIL lỗi (run $RUN_ID)"
[ "$FAIL" -eq 0 ]
