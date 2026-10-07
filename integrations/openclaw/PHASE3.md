# Phase 3 — Zalo OA tuyển dụng

Phase 2 DONE ở run `20261007-134317` (HEAD `8fad182`). Quyết định đã chốt (07/10/2026):

- Kênh: **Zalo OA tuyển dụng riêng** — không đụng OA/webhook `/zalo/oa/webhook` của luồng giáo viên.
- Adapter: **module trong sales-management**, route riêng, feature flag mặc định tắt.
- Danh tính do server gắn (AGENTS.md §16): model không tự truyền `senderId`/`zaloUserId`/`oaId`.

## Kiến trúc

```
Zalo OA tuyển dụng
  → POST /recruitment/channels/zalo/webhook  (kiểm chữ ký SHA256(appId+body+timestamp+OASecret), OA theo cấu hình)
  → ghi recruitment_channel_events (ON CONFLICT DO NOTHING theo msg_id) → ACK 200   [P3-3]
  → worker xử lý nền, tuần tự theo từng người gửi; lưu TIN ĐẾN (tất định, không qua model)
  → OpenClaw POST /v1/responses (nội bộ 127.0.0.1)
       x-openclaw-session-key: agent:main:zalo:<oaId>:<zaloUserId>
  → plugin đọc danh tính từ session key → gửi kèm header subject cho API AI
  → API AI chỉ cho đọc/ghi hồ sơ thuộc đúng subject đó
  → gửi trả lời qua API OA (token OA tuyển dụng, kho riêng); lưu TIN ĐI
  → lỗi/timeout: tin xin lỗi + chuyển HR (AI_UNCERTAIN)
```

## Các bước

| Bước | Nội dung | Kiểm tra |
|---|---|---|
| P3-1 | Spike: plugin (factory mode) đọc được `sessionKey` khi chạy qua `openclaw agent` và `/v1/responses` | log thử trên staging |
| P3-2 | Backend: cột `zalo_oa_id` + unique (OA, zaloUserId) — migration review, không synchronize; API AI nhận header subject, chặn truy cập hồ sơ không thuộc subject. Plugin gửi subject từ session key, bỏ `zaloUserId` khỏi tham số model | **DONE** staging: `subject-acceptance.sh` 38/38, tool-e2e 20/20 |
| P3-3 | Webhook nhận event: chữ ký + gắn OA theo cấu hình + chuẩn hoá + chống trùng nguyên tử (`recruitment_channel_events`, migration `1792000000000`) + ACK. **Không** gọi OpenClaw, **không** gửi tin Zalo | unit test; `zalo-webhook-acceptance.sh` 14 tiêu chí trên PostgreSQL staging |
| P3-4 | Worker: đọc event `RECEIVED` → hàng đợi theo người gửi → client OpenClaw (session tin cậy) + lưu tin vào/ra; client OA (kho token riêng, refresh) + fallback | unit test |
| P3-5 | Skill/workspace cho chế độ kênh (adapter lưu tin, không còn header giả lập) | — |
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
- P3-3 không lưu nội dung tin (chỉ `payload_hash` + metadata). P3-4 cần chốt nơi lưu bền nội dung
  tin đến để worker xử lý (cột trên event hay ghi `recruitment_messages` lúc nhận) + thời hạn lưu.
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
