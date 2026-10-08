# Phase 3 — Zalo OA tuyển dụng

Phase 2 DONE ở run `20261007-134317` (HEAD `8fad182`). Quyết định đã chốt (07/10/2026):

- Kênh: **Zalo OA tuyển dụng riêng** — không đụng OA/webhook `/zalo/oa/webhook` của luồng giáo viên.
- Adapter: **module trong sales-management**, route riêng, feature flag mặc định tắt.
- Danh tính do server gắn (AGENTS.md §16): model không tự truyền `senderId`/`zaloUserId`/`oaId`.

## Kiến trúc

```
Zalo OA tuyển dụng
  → POST /recruitment/channels/zalo/webhook  (kiểm chữ ký SHA256(appId+body+timestamp+OASecret), OA theo cấu hình)
  → ghi recruitment_channel_events + nội dung tin đã chuẩn hoá (inbox bền,
    ON CONFLICT DO NOTHING theo msg_id) → ACK 200                                      [P3-3]
  → worker (RECRUITMENT_WORKER_ENABLED): claim nguyên tử, tuần tự theo người gửi,
    lease + fencing; nhận diện ứng viên (OA, người gửi) + lưu TIN ĐẾN nguyên văn       [P3-4]
  → OpenClaw POST /v1/responses
       x-openclaw-session-key: agent:main:zalo:<oaId>:<zaloUserId>   (dựng từ DB)
  → plugin đọc danh tính từ session key → gửi kèm header subject cho API AI
  → API AI chỉ cho đọc/ghi hồ sơ thuộc đúng subject đó
  → tin đi canonical (msg-reply) → một transaction: outbox PENDING + PROCESSED + xoá text [P3-4]
  → gửi outbox qua API OA (token OA tuyển dụng, kho riêng) → SENT / thử lại               [P3-5]
```

## Các bước

| Bước | Nội dung | Kiểm tra |
|---|---|---|
| P3-1 | Spike: plugin (factory mode) đọc được `sessionKey` khi chạy qua `openclaw agent` và `/v1/responses` | log thử trên staging |
| P3-2 | Backend: cột `zalo_oa_id` + unique (OA, zaloUserId) — migration review, không synchronize; API AI nhận header subject, chặn truy cập hồ sơ không thuộc subject. Plugin gửi subject từ session key, bỏ `zaloUserId` khỏi tham số model | **DONE** staging: `subject-acceptance.sh` 38/38, tool-e2e 20/20 |
| P3-3 | Webhook nhận event: chữ ký + gắn OA theo cấu hình + chuẩn hoá + chống trùng nguyên tử (`recruitment_channel_events`, migration `1792000000000`) + ACK. **Không** gọi OpenClaw, **không** gửi tin Zalo | **DONE** staging: `zalo-webhook-acceptance.sh` 54/54 ×2 (55/55 sau P3-4) |
| P3-4 | Inbox bền (nội dung tin tạm, xoá khi xong, tối đa 7 ngày) → worker tuần tự theo người gửi → OpenClaw (session tin cậy) → hội thoại canonical → outbox `PENDING` (migration `1792100000000`). **Không** gửi tin Zalo | `channel-worker-acceptance.sh` (mock + 7 lượt OpenClaw thật), tool-e2e, A/B/C/isolation |
| P3-5 | Outbox `PENDING` → Zalo Send API (kho token riêng, refresh) → `SENT` / thử lại; redact `message_text` của outbox sau khi gửi | — |
| P3-6 | E2E staging: webhook giả có chữ ký thật + mock API Zalo; chạy lại A/B/C/isolation qua webhook; thêm test tấn công (ứng viên tự khai id người khác / prompt injection) | report như Phase 2 |
| P3-7 | OA thật với tài khoản test (cần credentials), rồi cổng production: key prod riêng, `RECRUITMENT_AI_ENABLED`, thông báo HR, rollback — deploy 3010/3011 cần duyệt riêng | — |

## Cần từ phía KIDO trước P3-7

- OA tuyển dụng + Zalo app: App ID, App Secret, OA Secret Key, OA ID; access/refresh token ban đầu
  (lưu file 600 trên VPS, không gửi qua chat).
- Domain HTTPS cho webhook (khai trong Zalo app console).
- Quy định Zalo OA về cửa sổ trả lời tin tư vấn — kiểm lại trước khi bật thật.

## Rủi ro / ghi chú

- sales-management sẽ giữ gateway token của OpenClaw recruiter (quyền operator) — gateway chỉ có
  15 tool tuyển dụng, chỉ nghe 127.0.0.1; vẫn ghi vào backlog bảo mật.
- 3011 (dev) dùng chung DB production: route webhook chỉ khai cho 3010; flag tắt trên 3011.
- Slot phỏng vấn staging dùng chung giữa các lần chạy (WARN đã ghi ở Phase 2).
- Nội dung tin (đã chốt ở P3-4): inbox giữ `normalized_message_text` tới khi `PROCESSED` (xoá ngay),
  `FAILED` giữ tối đa 7 ngày rồi xoá + dead-letter (audit `CHANNEL_EVENT_DEAD_LETTER`). Hội thoại
  canonical là `recruitment_messages`. Outbox còn giữ câu trả lời tới khi P3-5 gửi xong.
- `/v1/responses` (OpenClaw 2026.9.8) không trả `runtime`/`codeModeEngaged`/danh sách tool theo từng
  lượt → worker chỉ kiểm được envelope (200, `completed`, text thật, không `function_call`, không text
  lỗi). Runtime openclaw + Code Mode tắt + tool `recruitment_*` được giữ bằng cấu hình gateway và
  kiểm ở acceptance (session store + `kido-trace`).
- Dead-letter mới chỉ ghi `activity_log` + log ERROR — kênh báo HR thật (dashboard/thông báo) chưa có.
- Ngữ nghĩa: at-least-once gọi OpenClaw; chết đúng sau khi OpenClaw trả lời thì lượt chạy lại (model
  thấy tin đó hai lần trong session) — tác dụng nghiệp vụ và tin đi vẫn một lần (đã test với lượt thật).
- Webhook từ chối event Zalo có OA không nằm ở vị trí đã biết (`user_*`→recipient, `oa_*`→sender,
  follow/unfollow→`oa_id`, loại khác→`oa_id`). Trước P3-7 đối chiếu payload thật và chỉ bật các
  event cần trong Zalo console.
- Webhook chưa có rate limit riêng (request sai chữ ký chỉ tốn một lần băm, không chạm DB).

## Biến môi trường webhook (P3-3)

| Biến | Ý nghĩa |
|---|---|
| `RECRUITMENT_ZALO_ENABLED` | `true` mới mở route; khác → 404 |
| `RECRUITMENT_ZALO_APP_ID` | App ID của Zalo app gắn với OA tuyển dụng — dùng trong công thức ký và phải khớp `app_id` của event |
| `RECRUITMENT_ZALO_OA_ID` | OA tuyển dụng — `channel_account_id` của mọi event; event của OA khác → 403 |
| `RECRUITMENT_ZALO_OA_SECRET_KEY` | OA Secret Key (≥ 16 ký tự), lưu ngoài repo |

Bật mà thiếu/sai một trong ba biến → app không khởi động. Không có cờ tắt kiểm chữ ký.

Mã trả về: 200 `{ok, duplicate, status}` · 400 `MALFORMED_PAYLOAD`/`MALFORMED_EVENT` · 401
`INVALID_SIGNATURE` · 403 `APP_MISMATCH`/`OA_MISMATCH` · 503 `EVENT_STORE_UNAVAILABLE` (Zalo gửi lại).

## Worker (P3-4)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `RECRUITMENT_WORKER_ENABLED` | `false` | `true` mới chạy worker trong process này |
| `RECRUITMENT_OPENCLAW_URL` / `RECRUITMENT_OPENCLAW_TOKEN` | — | Gateway + token (quyền operator) — chỉ đặt ở process chạy worker |
| `RECRUITMENT_OPENCLAW_AGENT_ID` | `main` | Agent; session key `agent:<agent>:zalo:<OA>:<người gửi>` |
| `RECRUITMENT_OPENCLAW_TIMEOUT_MS` | 240000 | Timeout một lượt |
| `RECRUITMENT_WORKER_CONCURRENCY` | 2 | Lượt song song / process (khác người gửi) |
| `RECRUITMENT_WORKER_LEASE_MS` | 300000 | Lease (gia hạn mỗi 1/3 khi còn chạy) |
| `RECRUITMENT_WORKER_SETTLE_MS` | 2000 | Chờ sau khi nhận để tin tới lệch thứ tự kịp xếp theo timestamp Zalo |
| `RECRUITMENT_WORKER_RETRY_BASE_MS` / `_MAX_MS` | 30000 / 900000 | Thử lại base·2^n, có trần |

Phân loại lỗi: hạ tầng (5xx, timeout, mạng, 401/403) và provider (429, hết quota, 402) → thử lại tới
hết 7 ngày; kết quả model không dùng được (incomplete, text rỗng/"No response from OpenClaw.", text
"⚠️ …", `function_call`) → tối đa 3 lần; gateway từ chối (4xx khác) → dead-letter ngay.
