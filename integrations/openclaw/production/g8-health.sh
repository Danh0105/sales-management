#!/bin/bash
# Giám sát AI Recruiter production — CHỈ ĐỌC (transaction read only), không in nội dung tin / secret.
#   integrations/openclaw/production/g8-health.sh
set -uo pipefail
APP=sales-management
q() { runuser -u postgres -- psql -XAt -d sales_db -c "SET default_transaction_read_only = on" -c "$1" | tail -n +2; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$@"; }
flag() { pm2 jlist | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['name']=='$APP'][0];e=p['pm2_env'];print(e.get('env',{}).get('$1', e.get('$1','')) or '-')"; }

echo "== $(date '+%d/%m %H:%M') — AI Recruiter"
echo "3010: $(pm2 jlist | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['name']=='$APP'][0];print(p['pm2_env']['status'], 'restarts', p['pm2_env']['restart_time'])") · HR console $(code http://127.0.0.1:3010/recruitment/operations/overview) · API AI $(code http://127.0.0.1:3010/recruitment/ai/jobs/active) (503 tắt / 401 bật)"
echo "Cờ env: AI=$(flag RECRUITMENT_AI_ENABLED) WORKER=$(flag RECRUITMENT_WORKER_ENABLED) OUTBOUND=$(flag RECRUITMENT_ZALO_OUTBOUND_ENABLED) PILOT=$(flag RECRUITMENT_PILOT_MODE)"
echo "Gateway: $(docker inspect -f '{{.State.Status}}/{{.State.Health.Status}}' kido-recruiter-prod-openclaw-gateway-1 2>/dev/null || echo 'không có') · publish $(docker port kido-recruiter-prod-openclaw-gateway-1 2>/dev/null | tr '\n' ' ')· ufw br-kido-prod $(ufw status | grep -c br-kido-prod) luật"
echo "Dừng khẩn (AI/WORKER/OUTBOUND/failsafe): $(q "select ai_halted||'/'||worker_halted||'/'||outbound_halted||'/'||failsafe_halted||coalesce(' — '||failsafe_reason,'') from recruitment_runtime_controls")"
echo "Tin đến: $(q "select coalesce(string_agg(status||'='||n, ' '),'0') from (select status::text, count(*) n from recruitment_channel_events group by 1 order by 1) t")"
echo "Tin đi AI: $(q "select coalesce(string_agg(status||'='||n, ' '),'0') from (select status::text, count(*) n from recruitment_channel_outbox where source_type='AI_REPLY' group by 1 order by 1) t")"
echo "Chờ duyệt lâu nhất: $(q "select coalesce(to_char(min(created_at) at time zone 'Asia/Ho_Chi_Minh','DD/MM HH24:MI'),'—') from recruitment_channel_outbox where status='AWAITING_APPROVAL'")"
echo "Cảnh báo HR mở: $(q "select coalesce(string_agg(type||'='||n, ' '),'0') from (select type::text, count(*) n from recruitment_hr_alerts where status='OPEN' group by 1) t")"
echo "AI hôm nay: $(q "select count(*) filter (where ai_control_version is not null)||' lượt, '||coalesce(sum(ai_total_tokens),0)||' token' from recruitment_channel_events where received_at >= date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh'")"
echo "Lỗi log 3010 (300 dòng gần nhất, bỏ FCM thiết bị đã gỡ): $(pm2 logs "$APP" --nostream --lines 300 2>&1 | grep -E 'RECRUITMENT_AI_SAFETY_CONFIG_INVALID|Error: |ERROR \[' | grep -vc 'FCM Error' || true)"
