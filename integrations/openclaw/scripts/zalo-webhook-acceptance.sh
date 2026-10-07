#!/bin/bash
# Acceptance P3-3 — webhook Zalo OA tuyển dụng trên staging (PostgreSQL thật):
#   chữ ký, gắn OA theo cấu hình, chuẩn hoá, chống trùng nguyên tử, lưu event, ACK.
#
# Chạy trên instance TẠM (cùng image/env với staging-api) có preload net-tap để ĐẾM
# kết nối đi ra của app — OpenClaw và API Zalo phải bằng 0:
#   3022  OA tuyển dụng staging (stg-recruit-oa)
#   3023  cùng app, OA khác (stg-other-oa) — kiểm cùng id tin ở hai OA không đụng nhau
# OA đều là OA GIẢ, không có token gửi tin; network staging không ra internet.
#
#   integrations/openclaw/scripts/zalo-webhook-acceptance.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(cd ../.. && pwd)"
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
RUN_ID="$(date +%s)"
ACC="kido-p33-acc-$RUN_ID"
OTHER="kido-p33-other-$RUN_ID"
TABLE=recruitment_channel_events
PARKED=recruitment_channel_events_p33_off
PASS=0
FAIL=0

sql() { "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -At -c "$1"; }
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; [ -n "${2:-}" ] && echo "    → $2"; }
same() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "thực tế [$2], mong đợi [$3]"; fi; }
jget() { echo "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d; [v:=v[k] for k in sys.argv[1].split('.')]; print(v if not isinstance(v,(list,dict)) else json.dumps(v))" "$2"; }
report() {
  while IFS=$'\t' read -r flag name detail; do
    if [ "$flag" = 1 ]; then ok "$name"; else ko "$name" "$detail"; fi
  done < <(echo "$1" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for r in d['results']:
    print(('1' if r['ok'] else '0') + '\t' + r['name'] + '\t' + (r.get('detail') or ''))
if d.get('error'): print('0\tscript lỗi\t' + d['error'])")
}
# Runner chạy trong container staging-api chính (không bị tap), gọi instance đích qua localhost.
runner() { local port=$1; shift; "${DC[@]}" exec -T -e TARGET_PORT="$port" staging-api node - "$@" < staging/zalo-webhook-acceptance.js | tail -1; }
send() { runner "$1" send "$RUN_ID" "${@:2}"; }
key() { echo "user_send_text:msg:$1"; }
rows() { sql "select count(*) from $TABLE where dedupe_key = '$(key "$1")'${2:+ and channel_account_id = '$2'}"; }
wait_ready() {
  for _ in $(seq 1 60); do
    "${DC[@]}" exec -T staging-api node -e "fetch('http://localhost:$1/recruitment/ai/jobs/active').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && return 0
    timeout 2 tail -f /dev/null || true
  done
  echo "instance cổng $1 không lên" >&2; return 1
}
start_instance() { # start_instance <name> <port> [env...]
  local name=$1 port=$2; shift 2
  "${DC[@]}" run -d --no-deps --name "$name" -e PORT="$port" "$@" \
    -e NODE_OPTIONS=--require=/run/kido/net-tap.js -v "$PWD/staging/net-tap.js:/run/kido/net-tap.js:ro" \
    staging-api >/dev/null
  wait_ready "$port"
}
taps() { docker exec "$1" sh -c 'cat /tmp/net-tap.jsonl 2>/dev/null || true'; }
cleanup() {
  # Bảng bị đổi tên ở bước 6 → luôn trả lại tên, kể cả khi script dừng giữa chừng.
  if [ "$(sql "select to_regclass('$PARKED') is not null")" = t ]; then
    sql "alter table $PARKED rename to $TABLE" >/dev/null && echo "  (đã trả lại tên bảng $TABLE)"
  fi
  docker rm -f "$ACC" "$OTHER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

T0=$(sql "select now()::text")
START_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LINKED_BEFORE=$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || ':' || zalo_user_id, ',' order by id)), '-') from employee where zalo_user_id is not null")
TOKENS_BEFORE=$(sql "select count(*) from zalo_tokens")

echo "== 0. Instance tạm (run $RUN_ID): $ACC :3022 (OA stg-recruit-oa), $OTHER :3023 (OA stg-other-oa)"
start_instance "$ACC" 3022
start_instance "$OTHER" 3023 -e RECRUITMENT_ZALO_OA_ID=stg-other-oa
BASE_ACC=$(taps "$ACC" | wc -l)
BASE_OTHER=$(taps "$OTHER" | wc -l)
if taps "$ACC" | grep -q '"port":5432'; then ok "net-tap hoạt động (đã ghi kết nối DB lúc khởi động)"; else ko "net-tap hoạt động" "không thấy kết nối DB nào"; fi

echo "== 1. HTTP: case 1–7, 9"
OUT=$(runner 3022 full "$RUN_ID")
report "$OUT"
A=$(jget "$OUT" ids.senderA); B=$(jget "$OUT" ids.senderB)
C1=$(jget "$OUT" ids.c1)

echo "== 2. DB staging"
same "1. đúng 1 dòng, RECEIVED, OA theo cấu hình, sender/msg/hash chuẩn hoá đúng" \
  "$(sql "select count(*) || '|' || string_agg(channel || '|' || channel_account_id || '|' || status || '|' || external_sender_id || '|' || provider_message_id || '|' || payload_hash || '|' || (provider_event_id is null) || '|' || (provider_created_at is not null), ',') from $TABLE where dedupe_key = '$(key "$C1")'")" \
  "1|ZALO|stg-recruit-oa|RECEIVED|$A|$C1|$(jget "$OUT" ids.c1PayloadHash)|true|true"
same "2. gửi lại → vẫn 1 dòng" "$(rows "$C1")" 1
same "3. 10 request song song → đúng 1 dòng (unique + ON CONFLICT)" "$(rows "$(jget "$OUT" ids.c3)")" 1
same "3b. 10 body khác cùng msg_id song song → đúng 1 dòng" "$(rows "$(jget "$OUT" ids.c3b)")" 1
REJECTED=$(echo "$OUT" | python3 -c "import json,sys; i=json.load(sys.stdin)['ids']; print(','.join(\"'%s'\" % m for m in i['c4'] + i['c5'] + i['c6Rejected']))")
same "4/5/6. chữ ký sai, sai OA/app, payload hỏng → 0 dòng" \
  "$(sql "select count(*) from $TABLE where provider_message_id in ($REJECTED)")" 0
same "6. event hợp lệ sau payload hỏng đã được ghi" "$(rows "$(jget "$OUT" ids.c6g)")" 1
same "7. follow → 1 dòng IGNORED (khoá hash), sender = follower" \
  "$(sql "select count(*) || '|' || string_agg(status || '|' || external_sender_id || '|' || (dedupe_key ~ '^follow:h:[0-9a-f]{64}$'), ',') from $TABLE where event_type = 'follow' and external_sender_id = '$A'")" "1|IGNORED|$A|true"
same "7. user_send_image → IGNORED" "$(sql "select status from $TABLE where dedupe_key = 'user_send_image:msg:$(jget "$OUT" ids.c7b)'")" IGNORED
C9=$(jget "$OUT" ids.c9)
EXPECTED9=$(echo "$C9" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join('%s=%s@stg-recruit-oa' % (m, d[m]) for m in sorted(d)))")
same "9. A/B xen kẽ → mỗi tin đúng người gửi, đúng OA" \
  "$(sql "select string_agg(provider_message_id || '=' || external_sender_id || '@' || channel_account_id, ',' order by provider_message_id) from $TABLE where provider_message_id like 'p33-$RUN_ID-c9%'")" "$EXPECTED9"
same "không có dòng nào của run này mang OA ngoài cấu hình" \
  "$(sql "select count(*) from $TABLE where received_at >= '$T0' and channel_account_id not in ('stg-recruit-oa', 'stg-other-oa')")" 0

echo "== 3. Cùng id tin ở OA khác (instance :3023)"
R8=$(send 3023 "$C1" "$A" stg-other-oa)
same "8. cùng msg_id, OA khác → 200 duplicate=false" "$(jget "$R8" status)/$(jget "$R8" body.duplicate)" "200/False"
same "8. hai dòng, mỗi OA một dòng, không va chạm" \
  "$(sql "select count(*) || '|' || string_agg(channel_account_id, ',' order by channel_account_id) from $TABLE where dedupe_key = '$(key "$C1")'")" "2|stg-other-oa,stg-recruit-oa"
R8b=$(send 3023 "p33-$RUN_ID-c8b" "$A")
same "8. event của OA tuyển dụng gửi vào instance OA khác → 403" "$(jget "$R8b" status)/$(jget "$R8b" body.code)" "403/OA_MISMATCH"

echo "== 4. Restart process rồi Zalo gửi lại"
C10="p33-$RUN_ID-c10"
R10a=$(send 3022 "$C10" "$B")
same "10. event trước restart → 200 duplicate=false" "$(jget "$R10a" status)/$(jget "$R10a" body.duplicate)" "200/False"
docker restart "$ACC" >/dev/null
wait_ready 3022
R10b=$(send 3022 "$C10" "$B")
R10c=$(send 3022 "$C1" "$A")
same "10. sau restart, Zalo gửi lại → 200 duplicate=true" "$(jget "$R10b" status)/$(jget "$R10b" body.duplicate)" "200/True"
same "10. sau restart, gửi lại event case 1 → duplicate=true" "$(jget "$R10c" body.duplicate)" "True"
same "10. vẫn đúng 1 dòng mỗi event" "$(rows "$C10")/$(rows "$C1" stg-recruit-oa)" "1/1"

echo "== 5. DB lỗi (đổi tên bảng tạm thời)"
C11="p33-$RUN_ID-c11"
sql "alter table $TABLE rename to $PARKED" >/dev/null
R11a=$(send 3022 "$C11" "$A")
sql "alter table $PARKED rename to $TABLE" >/dev/null
same "11. DB lỗi → 503 EVENT_STORE_UNAVAILABLE (không ACK giả)" "$(jget "$R11a" status)/$(jget "$R11a" body.code)" "503/EVENT_STORE_UNAVAILABLE"
same "11. không có dòng nào cho event lúc DB lỗi" "$(rows "$C11")" 0
R11b=$(send 3022 "$C11" "$A")
same "11. DB hồi phục, Zalo gửi lại → 200 và đúng 1 dòng" "$(jget "$R11b" status)/$(jget "$R11b" body.duplicate)/$(rows "$C11")" "200/False/1"

echo "== 6. Không gọi OpenClaw, không gửi tin Zalo"
OUTBOUND=$( { taps "$ACC" | tail -n +"$((BASE_ACC + 1))"; taps "$OTHER" | tail -n +"$((BASE_OTHER + 1))"; } )
count_tap() { echo "$OUTBOUND" | python3 -c "
import json, re, sys
rows = [json.loads(l) for l in sys.stdin if l.strip()]
local_db = lambda r: r['port'] == 5432 and r['host'] in ('localhost', '127.0.0.1', '::1')
pick = {'openclaw': lambda r: 'openclaw' in r['host'] or r['port'] == 18789,
        'zalo': lambda r: 'zalo' in r['host'],
        'other': lambda r: not local_db(r) and 'openclaw' not in r['host'] and r['port'] != 18789 and 'zalo' not in r['host']}[sys.argv[1]]
print(sum(1 for r in rows if pick(r)))" "$1"; }
echo "  kết nối đi ra trong lúc test: $(echo "$OUTBOUND" | grep -c . || true) (DB nội bộ: $(echo "$OUTBOUND" | grep -c '"port":5432' || true))"
same "12. số kết nối tới OpenClaw gateway = 0" "$(count_tap openclaw)" 0
same "13. số kết nối tới API Zalo = 0" "$(count_tap zalo)" 0
same "12/13. không có kết nối đi ra nào khác ngoài DB" "$(count_tap other)" 0
GW=$("${DC[@]}" logs --no-log-prefix --since "$START_UTC" openclaw-gateway 2>/dev/null | grep -c 'kido-trace' || true)
same "12. gateway OpenClaw không có lời gọi tool nào từ lúc bắt đầu" "$GW" 0
# Mẫu tìm đọc qua process substitution — secret không nằm trên dòng lệnh, không in ra.
LEAK=$(docker logs "$ACC" 2>&1 | grep -cF -f <(printf '%s\n' "$A" "$B" "Xin chào"; sed -n 's/^STAGING_ZALO_OA_SECRET_KEY=//p' "$ENV_FILE") || true)
same "log app không chứa id người gửi, nội dung tin hay secret" "$LEAK" 0

echo "== 7. Regression webhook OA giáo viên"
RT=$("${DC[@]}" exec -T staging-api node -e "fetch('http://localhost:3022/zalo/oa/webhook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event_name:'user_send_text',sender:{id:'x'},message:{text:'0900000000'}})}).then(r=>console.log(r.status))")
same "14. /zalo/oa/webhook không chữ ký → 403 như trước" "$RT" 403
RT2=$(send 3022 "p33-$RUN_ID-c14" "$A" stg-recruit-oa /zalo/oa/webhook)
same "14. event ký bằng secret OA tuyển dụng gửi vào webhook giáo viên → 403" "$(jget "$RT2" status)" 403
same "14. liên kết Zalo nhân viên + token OA giáo viên không đổi" \
  "$(sql "select count(*) || '/' || coalesce(md5(string_agg(id::text || ':' || zalo_user_id, ',' order by id)), '-') from employee where zalo_user_id is not null")|$(sql "select count(*) from zalo_tokens")" "$LINKED_BEFORE|$TOKENS_BEFORE"
if git -C "$REPO" diff --quiet master HEAD -- src/zalo-oa src/main.ts; then ok "14. src/zalo-oa và main.ts không đổi so với master"; else ko "14. src/zalo-oa và main.ts không đổi so với master"; fi
JEST=$(cd "$REPO" && npx jest src/zalo-oa 2>&1 | grep -E '^Tests:' || true)
if echo "$JEST" | grep -qE 'Tests: +[0-9]+ passed, [0-9]+ total' && ! echo "$JEST" | grep -q failed; then ok "14. unit test OA giáo viên: $JEST"; else ko "14. unit test OA giáo viên" "$JEST"; fi

echo "== Kết quả: $PASS đạt, $FAIL lỗi"
[ "$FAIL" -eq 0 ]
