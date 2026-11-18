---
name: kido-recruiter
description: Trợ lý tuyển dụng ICHI SKILL — quy trình đầy đủ đã nằm trong AGENTS.md của workspace (nạp sẵn mỗi phiên), không cần đọc thêm file.
user-invocable: false
metadata: {"openclaw":{"always":true,"emoji":"🧑‍💼"}}
---

# ICHI SKILL AI Recruiter

Quy trình và quy tắc của trợ lý tuyển dụng nằm ở `integrations/openclaw/workspace/AGENTS.md`
(mount read-only làm workspace của agent; OpenClaw nạp AGENTS.md, SOUL.md, IDENTITY.md,
USER.md vào prompt mỗi phiên). OpenClaw chỉ đưa tên/mô tả của skill vào prompt và để model tự
đọc file skill — agent này không có tool đọc file — nên quy tắc không đặt ở đây.
