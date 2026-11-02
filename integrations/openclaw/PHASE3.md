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
  → sender (RECRUITMENT_ZALO_OUTBOUND_ENABLED — kill switch): claim theo người nhận, kiểm
    người nhận/OA/tin canonical, dispatched_at → Send API (token riêng, mã hoá, refresh có khoá)
    → SENT (xoá bản sao) / RETRY / UNKNOWN (không gửi lại) / DEAD_LETTER                   [P3-5]
```

## Các bước

| Bước | Nội dung | Kiểm tra |
|---|---|---|
| P3-1 | Spike: plugin (factory mode) đọc được `sessionKey` khi chạy qua `openclaw agent` và `/v1/responses` | log thử trên staging |
| P3-2 | Backend: cột `zalo_oa_id` + unique (OA, zaloUserId) — migration review, không synchronize; API AI nhận header subject, chặn truy cập hồ sơ không thuộc subject. Plugin gửi subject từ session key, bỏ `zaloUserId` khỏi tham số model | **DONE** staging: `subject-acceptance.sh` 38/38, tool-e2e 20/20 |
| P3-3 | Webhook nhận event: chữ ký + gắn OA theo cấu hình + chuẩn hoá + chống trùng nguyên tử (`recruitment_channel_events`, migration `1792000000000`) + ACK. **Không** gọi OpenClaw, **không** gửi tin Zalo | **DONE** staging: `zalo-webhook-acceptance.sh` 54/54 ×2 (55/55 sau P3-4) |
| P3-4 | Inbox bền (nội dung tin tạm, xoá khi xong, tối đa 7 ngày) → worker tuần tự theo người gửi → OpenClaw (session tin cậy) → hội thoại canonical → outbox `PENDING` (migration `1792100000000`). **Không** gửi tin Zalo | **DONE** staging: `channel-worker-acceptance.sh` 53/53 ×2 |
| P3-5 | Outbox → Zalo Send API của OA tuyển dụng: kill switch, claim/lease/fencing theo người nhận, kiểm trước khi gửi, `dispatched_at`, RETRY/UNKNOWN/DEAD_LETTER, kho token riêng mã hoá + refresh có khoá, redact sau SENT (migration `1792200000000`). Chỉ Zalo GIẢ trên staging | **DONE** staging: `zalo-outbound-acceptance.sh` 41/41 ×5 |
| P3-6 | Điều khiển hội thoại (AI_ACTIVE/AI_PAUSED/HUMAN_TAKEOVER/CLOSED) do backend/worker cưỡng chế, HR tiếp quản + gửi tin qua outbox, trả lại AI, đóng, fencing `control_version` khi tiếp quản giữa lượt AI, cảnh báo HR bền, đối soát UNKNOWN, API vận hành (migration `1792300000000`) | **DONE** staging: `channel-control-acceptance.sh` 44/44 ×2 |
| P3-6.5 | Gate trước P3-7: HR tiếp quản chặn mọi tin AI chưa dispatch — cửa kiểm ngay trước `dispatched_at`, trạng thái `SUPPRESSED` (migration `1792500000000`) | **DONE** staging: `channel-control-acceptance.sh` mục 11 — 56/56; regression P3-3 55/55, P3-4 53/53 (lượt thật), P3-5 41/41, tool-e2e 20/20, sim 4/4 (20261009-084551) |
| P3-7.1 | OA tuyển dụng thật + credential thật: getoa đọc-chỉ, token mã hoá at rest — không webhook/worker/gửi tin | **DONE** 09/10/2026 (report `/opt/kido-recruiter/runs/p371-20261009/report.md`) |
| P3-7.2…7.7 | Webhook thật (inbound) → worker (outbound tắt) → shadow → HR duyệt gửi → auto-reply giới hạn → production | chưa bắt đầu — cần `RECRUITMENT_ZALO_OA_SECRET_KEY` + reconcile `cf7b51c` |
| P3-6 | E2E staging: webhook giả có chữ ký thật + mock API Zalo; chạy lại A/B/C/isolation qua webhook; thêm test tấn công (ứng viên tự khai id người khác / prompt injection) | report như Phase 2 |

## RELEASE BLOCKER — lineage production (09/10/2026)

Production 3010 + 3011 chạy build `cf7b51c` (tag `production-20261009-zalo-hardening`) = `19c8a18`
(`chore/wavec-sales-db-roles`: DB credentials qua `DB_USER`, Firebase đọc `FIREBASE_SERVICE_ACCOUNT_PATH`)
+ hardening token OA giáo viên. Commit này **không nằm trên master, cũng không nằm trên
`feat/openclaw-phase3`**. Trước BẤT KỲ production deploy nào của Phase 3 phải reconcile `cf7b51c`/`19c8a18`
vào nhánh release chính và dựng release từ đó. **Không** build production từ `c601161` hay `8f9225f`
(c601161 hard-code `postgres/postgres`; 8f9225f cần file Firebase JSON cũ đã bị xoá — cả hai không boot).

DB production (`sales_db`) mới có bảng Phase 1; schema Phase 2/3 (migration `1791900000000`…`1792500000000`)
chưa chạy — thuộc đợt production deploy Phase 3 (sau khi reconcile, review migration trên bản clone).

## OA tuyển dụng chính thức (quyết định 09/10/2026)

- **OA: "ICHI SKILL"** — user xác nhận là OA tuyển dụng chính thức. `oa_id` fingerprint (sha256[:10])
  `97fc26723f`; OA giáo viên "Kidoedu" `e72dee8aca`. App tuyển dụng tách khỏi app OA giáo viên (app id,
  app secret, token đều khác).
- Cấu hình (ngoài repo, root 600): `/root/recruitment-oa.env` (APP_ID, OA_ID, APP_SECRET, OA_SECRET_KEY
  — **còn trống, bắt buộc trước P3-7.2**; 3 kill switch `false`; không chứa token),
  `/root/recruitment-oa.keys.env` (`RECRUITMENT_CHANNEL_API_KEY` hex 32, `RECRUITMENT_ZALO_TOKEN_KEY` base64
  32 byte).
- Token: cấp bằng authorization code (OAuth v4), lưu **chỉ dạng mã hoá** trong
  `/root/recruitment-oa.credential.json` — đúng cột `recruitment_zalo_credentials`, định dạng
  `zalo-token.crypto` v1 (AES-256-GCM, AAD = oa_id). DB production chưa có schema Phase 2/3 → nạp vào bảng
  ở đợt production deploy Phase 3. Không refresh tới khi sender được bật (P3-7.5).
- Lần cấp quyền đầu chọn nhầm OA Kidoedu → script từ chối, không lưu gì; user đã thu hồi quyền của app
  tuyển dụng trên OA Kidoedu (09/10, đối chiếu: app tuyển dụng không còn trong "Quản lý liên kết" của
  Kidoedu). **Lưu ý tên dễ nhầm:** app "ICHI SKILL Chấm Công" trên Kidoedu chính là **app OA giáo viên**
  (`ZALO_APP_ID` production) — không bao giờ thu hồi; "App kido" là app khác, không thuộc tuyển dụng.
- Zalo Console đã thử gọi webhook 3 lần (09/10 13:51, 14:11 ×2) → 404: chỉ đăng ký webhook khi receiver
  P3-7.2 đã deploy.

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
- Dead-letter / UNKNOWN mới chỉ ghi `activity_log` + log — kênh báo HR thật và thao tác đối soát
  UNKNOWN (đánh dấu đã gửi / gửi lại) là P3-6. Trong lúc chờ, UNKNOWN chặn các tin sau của đúng
  người nhận đó (giữ thứ tự) — người nhận khác không bị ảnh hưởng.
- Mã lỗi Zalo: tài liệu developers.zalo.me không đọc được tự động (trang render JS) → không gán cứng
  ý nghĩa mã. `error ≠ 0` = Zalo đã từ chối (tin chưa đi) → thử lại có giới hạn; mã "vĩnh viễn" và mã
  "token hỏng" lấy từ `RECRUITMENT_ZALO_PERMANENT_ERRORS` / `RECRUITMENT_ZALO_TOKEN_ERRORS` (mặc
  định `-216` + message chứa "access token"). **Trước P3-7 phải đối chiếu bảng mã lỗi chính thức.**
- Refresh token: nếu process chết đúng lúc Zalo đã xoay token mà chưa kịp lưu → refresh token mới bị
  mất, phải cấp lại quyền OA (log `REFRESH_OUTCOME_UNKNOWN`). Không tránh được hoàn toàn phía client.
- Tin dài hơn `RECRUITMENT_ZALO_MAX_TEXT_LENGTH` (2000) → DEAD_LETTER, chưa tách tin.
- Gate 1 trước P3-7 (nhánh riêng `security/zalo-teacher-token-hardening`, không trộn vào Phase 3):
  `ZaloTokenService` của OA giáo viên từng `console.log(res.data)` khi refresh → token OA giáo viên nằm
  trong log pm2; refresh không có khoá đồng thời. Code sửa xong (82bc161); deploy + xoay token chờ duyệt.
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

## Sender (P3-5)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `RECRUITMENT_ZALO_OUTBOUND_ENABLED` | `false` | Kill switch: khác `true` → không gửi, không kết nối ra Zalo |
| `RECRUITMENT_ZALO_APP_SECRET` | — | App Secret (header `secret_key` khi refresh) |
| `RECRUITMENT_ZALO_TOKEN_KEY` | — | Khoá AES-256-GCM 32 byte mã hoá token trong `recruitment_zalo_credentials` |
| `RECRUITMENT_ZALO_API_URL` / `_OAUTH_URL` | Zalo thật | Staging trỏ vào Zalo giả |
| `RECRUITMENT_ZALO_PERMANENT_ERRORS` / `_TOKEN_ERRORS` | rỗng / `-216` | Phân loại mã lỗi Zalo (đã đối chiếu tài liệu) |
| `RECRUITMENT_ZALO_MAX_REJECT_ATTEMPTS` | 3 | Mã từ chối chưa phân loại: thử tối đa n lần |
| `RECRUITMENT_ZALO_CONNECT_TIMEOUT_MS` / `_RESPONSE_TIMEOUT_MS` | 5000 / 15000 | Ranh giới "chưa gửi" / "có thể đã gửi" |
| `RECRUITMENT_ZALO_SENDER_CONCURRENCY` / `_LEASE_MS` / `_RETRY_BASE_MS` / `_RETRY_MAX_MS` | 2 / 60000 / 5000 / 300000 | |

Trạng thái outbox: `PENDING` → `SENDING` (`dispatched_at` = request có thể đã tới Zalo) →
`SENT` (xoá `message_text`) | `RETRY` (chắc chắn chưa đi: 429, 500–503, lỗi trước khi kết nối, token/credential) |
`UNKNOWN` (có thể đã tới: mất kết nối/hết giờ sau khi gửi, 504, response không đọc được, lease hết hạn sau
dispatch — **không bao giờ tự gửi lại**) | `DEAD_LETTER` (từ chối vĩnh viễn, dữ liệu không khớp nguồn tin cậy,
quá 7 ngày) | `SUPPRESSED` (tin AI bị chặn trước khi gửi vì HR đổi điều khiển hội thoại — P3-6.5). Cấp token ban đầu: `RecruitmentZaloCredentialStore.saveInitial` (staging:
`staging/seed-zalo-credentials.js`). Trước khi bật sender ở môi trường có dữ liệu cũ:
`scripts/outbox-fixture-cleanup.sh` (chỉ staging).

## Điều khiển hội thoại & vận hành (P3-6)

Trạng thái hiệu lực (worker kiểm SAU khi lưu tin đến, TRƯỚC khi gọi OpenClaw — không phó mặc skill):

| Trạng thái | Nguồn | Tin đến |
|---|---|---|
| `AI_ACTIVE` | `control_mode` = AI_ACTIVE, không gì chặn | lưu → OpenClaw → outbox |
| `AI_PAUSED` | suy ra: handoff mở / hồ sơ `aiPaused`·`NEEDS_HR_REVIEW` / ứng viên dừng AI | lưu, KHÔNG gọi AI, cảnh báo tin-chờ |
| `HUMAN_TAKEOVER` | `control_mode` (HR chọn) | lưu, KHÔNG gọi AI, cảnh báo tin-chờ |
| `CLOSED` | `control_mode` (HR chọn) | lưu, KHÔNG gọi AI, cảnh báo tin-chờ |

Mỗi thao tác HR khoá dòng hội thoại và tăng `control_version`; transaction ghi kết quả của worker đọc
lại version (`FOR SHARE`) — HR tiếp quản trong lúc OpenClaw chạy thì câu trả lời AI bị bỏ (event
`DISCARDED_CONTROL_CHANGED`, tin AI gắn `metadata.delivery`), không bao giờ vào outbox. Handoff do
chính lượt AI mở không chặn câu trả lời của lượt đó (chỉ version do HR đổi mới chặn).

Chạy lại sau crash: worker ghi `ai_control_version` lên event TRƯỚC khi gọi OpenClaw. Lần thử sau của
một lượt đã bắt đầu chỉ bị chặn khi HR đổi chế độ/version; tin đi của lượt đã có trong hội thoại thì
gửi đúng bản đó, không gọi OpenClaw lần hai; chưa có thì chạy lại lượt dưới version cũ. (Tìm ra khi
regression P3-4 lượt thật: lượt đầu tự mở handoff SPECIAL_CASE rồi mất response — bản trước bỏ qua
lần thử lại và câu trả lời đã lưu không bao giờ được gửi.)

API (JWT; đọc: `RECRUITMENT_VIEW_ROLES`; thao tác: `RECRUITMENT_TAKEOVER_ROLES` /
`RECRUITMENT_OPERATIONS_ROLES` — hiện = `nhansu`; audit bằng nhân viên thật):

- `GET /recruitment/conversations/:id/control`
- `POST /recruitment/conversations/:id/takeover | resume-ai | close`
- `POST /recruitment/conversations/:id/messages {content, clientMessageId}` — tin HR canonical + đúng
  một outbox `HR_MESSAGE`; đang AI thì tự chuyển HUMAN_TAKEOVER; idempotent theo `clientMessageId`;
  `activity_log` của request này không chép body.
- `GET /recruitment/operations/outbox?status=UNKNOWN`
- `POST /recruitment/operations/outbox/:id/mark-sent | retry {confirmDuplicateRisk: true} | dead-letter`
  — chỉ từ UNKNOWN, idempotent; mark-sent không kết nối mạng; retry lấy lại nội dung từ tin canonical.
- `GET /recruitment/operations/handoffs`, `GET /recruitment/operations/alerts`,
  `POST /recruitment/operations/alerts/:id/acknowledge`

Cảnh báo `recruitment_hr_alerts` (unique `type` + `source_key`, chỉ metadata): CANDIDATE_REQUESTED_HUMAN,
AI_POLICY_HANDOFF (`handoff:<id>`), CANDIDATE_MESSAGE_WAITING (`conversation:<id>:v<version>`),
OUTBOUND_UNKNOWN / OUTBOUND_DEAD_LETTER (`outbox:<id>`), CHANNEL_EVENT_DEAD_LETTER (`event:<id>`),
REPEATED_AI_FAILURE (`ai:<OA>:<giờ UTC>`), REFRESH_OUTCOME_UNKNOWN (`credential:<OA>:v<version>`).
Tạo bằng `raise()` (trong transaction nơi gọi) hoặc `sweep()` định kỳ trong worker/sender. Chưa có kênh
đẩy thông báo thật (push/email) — đọc qua API.

## HR tiếp quản chặn tin AI chưa gửi (P3-6.5)

Cửa kiểm cuối của sender, NGAY TRƯỚC khi mở kết nối (`RecruitmentChannelOutboxQueue.dispatch`): một
transaction khoá chia sẻ dòng hội thoại (`FOR SHARE`; thao tác HR giữ `FOR UPDATE`) rồi:

| Dòng outbox | Điều kiện | Kết quả |
|---|---|---|
| `AI_REPLY` | `control_mode` = HUMAN_TAKEOVER | `SUPPRESSED` · `CONTROL_HUMAN_TAKEOVER` |
| `AI_REPLY` | `control_mode` = CLOSED | `SUPPRESSED` · `CONTROL_CLOSED` |
| `AI_REPLY` | AI_ACTIVE nhưng `control_version` ≠ version lúc xếp hàng (vd. tiếp quản rồi trả lại) | `SUPPRESSED` · `CONTROL_VERSION_CHANGED` |
| `AI_REPLY` | không có version lúc xếp hàng | `SUPPRESSED` · `CONTROL_VERSION_MISSING` (fail-closed) |
| `HR_MESSAGE` | mọi chế độ | gửi bình thường |
| bất kỳ | tin canonical / hội thoại không còn | `DEAD_LETTER` · `CANONICAL_MISSING` |

`SUPPRESSED`: 0 kết nối mạng, xoá bản sao nội dung (CHECK), tin AI canonical giữ nguyên + gắn
`metadata.delivery = SUPPRESSED_CONTROL_CHANGED`, audit `CHANNEL_OUTBOX_SUPPRESSED` (mã, chế độ, version
lúc xếp hàng → hiện tại, `network: false`), không cảnh báo HR, trạng thái kết thúc (không chặn hàng của
người nhận — tin HR phía sau vẫn đi). Chỉ tin AI được `SUPPRESSED` (CHECK). Cửa kiểm chạy lại trước lần
gửi thứ hai sau khi Zalo từ chối token (lần đầu chắc chắn chưa tới) và cả khi vận hành RETRY một dòng
UNKNOWN.

`AI_PAUSED` suy ra (handoff mở, hồ sơ chờ HR) KHÔNG chặn tin đã xếp hàng: pause đó thường do chính lượt
AI tạo ra và câu trả lời của lượt ("mình đã chuyển nhân sự") phải tới ứng viên. Chỉ thao tác tường minh
của HR (đổi `control_mode` → tăng version) mới chặn.

Đã dispatch trước khi HR tiếp quản → coi như đã tới ứng viên (luồng này không thu hồi tin); dòng giữ kết quả
thật (SENT/UNKNOWN), không huỷ giả, không gửi lại. `takeover` / `close` / tin HR tự tiếp quản trả về và
ghi audit `aiOutbound: {alreadyDispatched: [id outbox], willBeSuppressed: [id outbox]}` — danh sách đọc
trong cùng transaction giữ `FOR UPDATE` nên chính xác với cửa kiểm.

