# KIDO AI Recruiter — OpenClaw (Phase 2, staging)

Nối **OpenClaw → NestJS (`/recruitment/ai/*`) → PostgreSQL** trên một stack staging
tách khỏi production. Chưa nối Zalo (Phase 3).

```
 ứng viên (giả lập: openclaw agent / tools.invoke)
        │
 openclaw-gateway  (Docker, OpenClaw 2026.9.8, model anthropic/claude-sonnet-5-5)
   │  skill  kido-recruiter        ← skills/kido-recruiter/SKILL.md
   │  plugin kido-recruitment      ← plugin/kido-recruitment (15 tool recruitment_*)
   │  mọi tool khác: TẮT (exec, file, web, browser, messaging, sessions...)
   ▼  HTTP + Bearer RECRUITMENT_AI_API_KEY (key staging)
 staging-api  (image build từ tag sales-release-20261005, NODE_ENV=staging)
   ▼  localhost:5432 (chung network namespace)
 staging-db   (Postgres 16.10: schema production, KHÔNG dữ liệu thật + staging/seed.sql)
```

| Thành phần | Ở đâu |
|---|---|
| Compose, Dockerfile, seed, cấu hình, plugin, skill, script | thư mục này (có trong git) |
| Secrets (`.env`), state OpenClaw (phiên chat, SQLite), build | `/opt/kido-recruiter` (quyền 700, **không** commit) |

## Bảo mật

- **Không publish cổng nào ra internet.** Control UI chỉ nghe `127.0.0.1:18789` trên host
  (truy cập qua SSH tunnel: `ssh -L 18789:127.0.0.1:18789 <vps>`).
- Mạng `staging` là `internal`: staging-db/staging-api **không** ra internet, **không** chạm
  Postgres production. Chỉ OpenClaw có thêm mạng `egress` để gọi Anthropic.
- Tool policy (`config/openclaw.batch.json`): `profile: minimal` + `alsoAllow: recruitment_*`,
  `deny` mọi nhóm core (deny thắng allow). `tools.elevated` và browser tắt.
  Đã kiểm: `exec`, `web_fetch` gọi qua gateway → "Tool not available".
- Chỉ skill `kido-recruiter` được nạp cho agent (`agents.defaults.skills`).
- API key / gateway token / Anthropic key chỉ ở `/opt/kido-recruiter/.env`; `openclaw.json`
  dùng SecretRef (`source: env`). Plugin đọc key từ env, không bao giờ trả key trong kết quả.
- `openclaw security audit`: 0 critical · 0 warn.
- Mô hình tin cậy của OpenClaw là "một operator tin cậy". Ứng viên là **người lạ** — vì vậy
  an toàn dựa trên việc agent chỉ có 15 tool nghiệp vụ, và backend tự giữ state machine,
  chống trùng, khoá AI sau handoff, chặn thuộc tính nhạy cảm.

## Vận hành

```bash
cd integrations/openclaw
ENV=/opt/kido-recruiter/.env

# Dựng / dựng lại toàn bộ (idempotent). PGPASSWORD chỉ cần ở lần đầu (đọc schema prod).
PGPASSWORD=... scripts/bootstrap.sh sales-release-20261005

# E2E mức tool, không cần LLM (qua đúng đường chính sách tool của gateway)
scripts/tool-e2e.sh

# Hội thoại với Claude thật — sau khi điền ANTHROPIC_API_KEY vào $ENV:
docker compose --env-file $ENV up -d --force-recreate openclaw-gateway
scripts/simulate-conversation.sh all      # happy | human | sensitive | all

# Gọi một tool bằng tay
docker compose --env-file $ENV exec -T openclaw-gateway openclaw gateway call tools.invoke \
  --json --params '{"name":"recruitment_get_active_jobs","args":{},"agentId":"main"}'

# Log
docker compose --env-file $ENV logs -f openclaw-gateway staging-api

# Làm mới DB staging về seed ban đầu
docker compose --env-file $ENV down && docker volume rm kido-recruiter_staging-db-data
scripts/bootstrap.sh
```

Đổi key staging: sửa `RECRUITMENT_AI_API_KEY` trong `$ENV` rồi
`docker compose --env-file $ENV up -d --force-recreate staging-api openclaw-gateway`.

## Plugin `kido-recruitment`

- `src/client.ts` — HTTP client: kết quả luôn `{ ok, httpStatus, data | error{code,message} }`
  (dữ liệu API nằm trong `data` vì OpenClaw coi `status/ok/error` ở cấp trên cùng là trạng thái
  lời gọi tool); thử lại 1 lần khi lỗi mạng với **cùng** `Idempotency-Key`.
- `src/index.ts` — 15 tool, ánh xạ 1-1 với `openapi/recruitment-ai.yaml`.
- Build/test trong image OpenClaw (Node 24), không dùng Node của host:
  `npm install --include=dev && npm test && npm run plugin:validate` (bootstrap tự làm).
- Đổi tên/tool → chạy lại `npm run plugin:build` để sinh lại `openclaw.plugin.json`.

## Chưa làm (Phase 3 trở đi)

- Nối kênh Zalo. Cần chốt: Zalo OA hay Zalo Bot; OA hiện đang gửi webhook về
  `sales-management` (`/zalo-oa/webhook`, liên kết giáo viên) — không được giành webhook đó.
  Khi có kênh thật: tách session theo người gửi (`session.dmScope`), danh tính `sender`
  lấy từ kênh thay cho dòng `[channel=... sender=...]` của môi trường giả lập.
- Lưu tin nhắn hiện dựa vào skill (model gọi `recruitment_save_message`). Có thể chuyển sang
  hook của plugin để không phụ thuộc model.
- Production: chỉ bật khi đã duyệt kết quả hội thoại giả lập, có key production riêng và
  `RECRUITMENT_AI_ENABLED=true` trên 3010.
