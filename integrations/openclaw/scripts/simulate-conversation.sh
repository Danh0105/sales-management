#!/bin/bash
# Hội thoại giả lập với LLM thật (openai/gpt-5.6-terra) qua OpenClaw (agent "main" + skill kido-recruiter),
# backend là staging. Cần OPENAI_API_KEY (key riêng của bot) trong /opt/kido-recruiter/.env.
#
#   integrations/openclaw/scripts/simulate-conversation.sh [happy|human|sensitive|isolation|all]
#
# Kết quả LLM không tất định: mỗi kịch bản in hội thoại kèm tool đã gọi theo thứ tự,
# rồi đối chiếu DB staging (hồ sơ, tin nhắn, sàng lọc, phỏng vấn, chuyển HR, thông tin
# nhạy cảm, cô lập giữa các ứng viên). Báo cáo đầy đủ: /opt/kido-recruiter/runs/<run>/report.md
set -euo pipefail
exec python3 "$(dirname "$0")/simulate_conversation.py" "$@"
