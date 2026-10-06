#!/bin/bash
# E2E mức tool, KHÔNG cần LLM: gọi từng tool recruitment_* qua RPC tools.invoke
# của gateway (cùng đường chính sách tool mà agent dùng) → plugin → staging-api
# → staging-db. Chỉ chạy với stack staging (docker-compose.yml trong thư mục này).
#
#   integrations/openclaw/scripts/tool-e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${KIDO_RECRUITER_ENV:-/opt/kido-recruiter/.env}"
DC=(docker compose --env-file "$ENV_FILE")
RUN_ID="$(date +%s)"
PASS=0
FAIL=0

invoke() { # invoke <tool> <json-args> → in ra {ok,httpStatus,data|error}
  local params
  params=$(jq -nc --arg name "$1" --argjson args "$2" '{name:$name,args:$args,agentId:"main"}')
  "${DC[@]}" exec -T openclaw-gateway openclaw gateway call tools.invoke --json --params "$params" \
    | jq -c 'if .ok then (.output.details // (.output.content[0].text | fromjson)) else {gatewayError: .error} end'
}

check() { # check <mô tả> <jq-điều-kiện> <json>
  if echo "$3" | jq -e "$2" >/dev/null; then
    PASS=$((PASS + 1)); echo "  ✓ $1"
  else
    FAIL=$((FAIL + 1)); echo "  ✗ $1"; echo "    → $(echo "$3" | head -c 400)"
  fi
}

sql() { "${DC[@]}" exec -T staging-db psql -U postgres -d sales_db_staging -At -c "$1"; }

echo "== Kịch bản 1: ứng viên phù hợp → phỏng vấn (run $RUN_ID)"
ZALO="sim-zalo-$RUN_ID"
R=$(invoke recruitment_find_or_create_candidate "{\"zaloUserId\":\"$ZALO\",\"fullName\":\"Nguyễn Văn Thử\",\"source\":\"ZALO\"}")
check "tạo ứng viên mới" '.ok and .data.outcome=="CREATED"' "$R"
CAND=$(echo "$R" | jq -r '.data.candidate.id')
R=$(invoke recruitment_find_or_create_candidate "{\"zaloUserId\":\"$ZALO\",\"source\":\"ZALO\"}")
check "retry cùng zaloUserId → EXISTING, cùng id" ".ok and .data.outcome==\"EXISTING\" and .data.candidate.id==$CAND" "$R"

MSG="{\"candidateId\":$CAND,\"channel\":\"ZALO\",\"externalConversationId\":\"$ZALO\",\"externalMessageId\":\"m-$RUN_ID-1\",\"senderType\":\"CANDIDATE\",\"direction\":\"INBOUND\",\"content\":\"Em muốn ứng tuyển nhân viên kinh doanh ạ\"}"
R=$(invoke recruitment_save_message "$MSG")
check "lưu tin nhắn đến" '.ok and .data.duplicate==false' "$R"
R=$(invoke recruitment_save_message "$MSG")
check "retry cùng externalMessageId → duplicate" '.ok and .data.duplicate==true' "$R"

JOB=$(invoke recruitment_get_active_jobs '{}' | jq -r '.data.data[] | select(.code=="SALES-CM-01") | .id')
# Mỗi lần chạy tự mở một slot riêng (dữ liệu test, chỉ trên DB staging) để
# không phụ thuộc slot seed đã bị các lần chạy trước giữ hết chỗ.
SLOT=$(sql "insert into recruitment_interview_slots (job_id, start_at, end_at, location, capacity, notes)
  values ($JOB, date_trunc('day', now()) + interval '3 day 16 hour', date_trunc('day', now()) + interval '3 day 16 hour 45 minute',
          'E2E $RUN_ID', 2, 'tool-e2e') returning id" | head -1)
R=$(invoke recruitment_find_or_create_application "{\"candidateId\":$CAND,\"jobId\":$JOB}")
check "tạo hồ sơ ứng tuyển" '.ok and .data.created==true' "$R"
APP=$(echo "$R" | jq -r '.data.application.id')

R=$(invoke recruitment_get_application_context "{\"applicationId\":$APP}")
check "context có missingFields + allowedActions" '.ok and (.data.missingFields|index("phone")) and (.data.allowedActions|index("SCREEN_CANDIDATE"))' "$R"

R=$(invoke recruitment_update_candidate "{\"candidateId\":$CAND,\"gender\":\"male\"}")
check "thuộc tính nhạy cảm bị chặn (schema tool từ chối hoặc API 400)" '(.gatewayError != null) or (.ok == false)' "$R"

R=$(invoke recruitment_update_candidate "{\"candidateId\":$CAND,\"phone\":\"0987$((RUN_ID % 1000000))\",\"location\":\"TP. Cà Mau\"}")
check "cập nhật SĐT + khu vực" '.ok' "$R"

R=$(invoke recruitment_screen_candidate "{\"applicationId\":$APP,\"extractedSkills\":[\"sales\",\"CRM\"],\"totalExperienceMonths\":24,\"expectedSalary\":12000000,\"availableFrom\":\"$(date -d '+3 day' +%F)\",\"aiSummary\":\"2 năm sales B2B, dùng CRM.\"}")
check "sàng lọc HIGH_MATCH → QUALIFIED, đề xuất phỏng vấn" '.ok and .data.matchLevel=="HIGH_MATCH" and .data.status=="QUALIFIED" and .data.recommendedAction=="PROPOSE_INTERVIEW"' "$R"

R=$(invoke recruitment_get_interview_slots "{\"jobId\":$JOB,\"limit\":50}")
check "slot HR vừa mở có trong danh sách AI thấy" ".ok and (.data.data|map(.id)|index($SLOT)) != null" "$R"

R=$(invoke recruitment_propose_interview "{\"applicationId\":$APP,\"slotId\":$SLOT}")
check "đề xuất phỏng vấn trong slot → PROPOSED" '.ok and .data.interview.status=="PROPOSED"' "$R"
INTERVIEW=$(echo "$R" | jq -r '.data.interview.id')
R=$(invoke recruitment_propose_interview "{\"applicationId\":$APP,\"slotId\":$SLOT}")
check "đề xuất lần 2 → ACTIVE_INTERVIEW_EXISTS (không giữ thêm chỗ)" '.ok==false and .error.code=="ACTIVE_INTERVIEW_EXISTS"' "$R"

R=$(invoke recruitment_confirm_interview "{\"interviewId\":$INTERVIEW}")
check "ứng viên xác nhận → CONFIRMED, hồ sơ INTERVIEW" '.ok and .data.interview.status=="CONFIRMED" and .data.application.status=="INTERVIEW"' "$R"

echo "== Kịch bản 2: lương vượt khung → tự chuyển HR, AI bị khoá"
ZALO2="sim-zalo-$RUN_ID-b"
CAND2=$(invoke recruitment_find_or_create_candidate "{\"zaloUserId\":\"$ZALO2\",\"fullName\":\"Trần Thị Thử\",\"source\":\"ZALO\"}" | jq -r '.data.candidate.id')
APP2=$(invoke recruitment_find_or_create_application "{\"candidateId\":$CAND2,\"jobId\":$JOB}" | jq -r '.data.application.id')
R=$(invoke recruitment_screen_candidate "{\"applicationId\":$APP2,\"extractedSkills\":[\"sales\"],\"totalExperienceMonths\":36,\"expectedSalary\":30000000,\"location\":\"Cà Mau\",\"availableFrom\":\"$(date -d '+5 day' +%F)\"}")
check "lương vượt trần >10% → HANDOFF_TO_HR, NEEDS_HR_REVIEW, aiPaused" '.ok and .data.recommendedAction=="HANDOFF_TO_HR" and .data.status=="NEEDS_HR_REVIEW" and .data.aiPaused==true' "$R"
R=$(invoke recruitment_propose_interview "{\"applicationId\":$APP2,\"slotId\":$SLOT}")
check "AI không được hẹn phỏng vấn sau khi chuyển HR" '.ok==false and .error.code=="AI_PAUSED_FOR_HR"' "$R"
R=$(invoke recruitment_save_message "{\"candidateId\":$CAND2,\"applicationId\":$APP2,\"channel\":\"ZALO\",\"externalConversationId\":\"$ZALO2\",\"externalMessageId\":\"m-$RUN_ID-b1\",\"senderType\":\"CANDIDATE\",\"direction\":\"INBOUND\",\"content\":\"Khi nào có kết quả ạ?\"}")
check "vẫn lưu được tin nhắn sau khi chuyển HR" '.ok' "$R"

echo "== Đối chiếu DB staging"
check "hồ sơ 1 = INTERVIEW" '.=="INTERVIEW"' "\"$(sql "select status from recruitment_applications where id=$APP")\""
check "hồ sơ 2 = NEEDS_HR_REVIEW + có handoff OPEN SALARY_OUT_OF_RANGE" '.=="NEEDS_HR_REVIEW|SALARY_OUT_OF_RANGE"' "\"$(sql "select a.status||'|'||h.reason from recruitment_applications a join recruitment_handoffs h on h.application_id=a.id and h.status='OPEN' where a.id=$APP2")\""
check "audit ghi actorId -1 (OpenClaw AI)" '. > 0' "$(sql "select count(*) from activity_log where \"actorId\"=-1 and path like '/recruitment-%'")"
check "tin nhắn không bị lưu trùng" '.==2' "$(sql "select count(*) from recruitment_messages m join recruitment_conversations c on c.id=m.conversation_id where c.candidate_id in ($CAND,$CAND2)")"

echo "== Kết quả: $PASS đạt, $FAIL lỗi"
[ "$FAIL" -eq 0 ]
