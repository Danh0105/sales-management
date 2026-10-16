# AI Recruiter — Vận hành production (G8)

Trạng thái đến khi có GO: **AI, worker, Zalo outbound TẮT**; gateway chạy rỗi; mọi tin AI phải được Nhân sự duyệt.

## 1. Luồng xử lý

```text
Zalo OA ICHI SKILL → nginx → 3010 webhook (kiểm chữ ký, khử trùng dedupe_key) → hộp đến recruitment_channel_events
  → worker 3010 (pilot allowlist, trần lượt/token, lease + fencing, retry/dead-letter)
  → gateway OpenClaw 127.0.0.1:18790 (chỉ 15 tool recruitment_*, token, mạng br-kido-prod chỉ tới 3010 + OpenAI)
  → API /recruitment/ai/* (key kênh + X-Recruitment-Subject = đúng ứng viên) → PostgreSQL
  → bản nháp AI: outbox AWAITING_APPROVAL  ──(HR duyệt / sửa-duyệt / từ chối)──►  PENDING
  → sender 3010 (kiểm lại bản duyệt dưới khoá ngay trước khi gửi: nội dung, người nhận, OA, phiên bản, hạn 30 phút)
  → Zalo Send API → SENT | RETRY | UNKNOWN (không tự gửi lại) | DEAD_LETTER
```

Tiếp quản / đóng hội thoại thu hồi mọi tin AI chưa gửi. Dừng khẩn có hiệu lực trong một chu kỳ, không cần restart.

## 2. Quyền

| Vai trò | Quyền trong màn Tuyển dụng | Nguồn |
|---|---|---|
| `nhansu` | xem tất cả; duyệt / sửa-duyệt / từ chối tin AI; tiếp quản, gửi tin, trả AI, đóng hội thoại; dừng khẩn / mở lại; xác nhận cảnh báo | `RECRUITMENT_MANAGE_ROLES` = `RECRUITMENT_OPERATIONS_ROLES` |
| `director`, `director_la`, `troly_gd` | chỉ xem (không thấy nút thao tác; backend trả 403 nếu gọi thẳng) | `RECRUITMENT_VIEW_ONLY_ROLES` |

Cấp quyền: quản trị gán role `nhansu` cho tài khoản nhân viên (bảng `employee.roles`) theo phê duyệt của Ban giám đốc; thu hồi
bằng cách bỏ role. Mọi thao tác ghi `activity_log` đúng người (không ghi mật khẩu/token; module `auth` không được audit).

## 3. Hướng dẫn Nhân sự duyệt tin (kido-app → Tuyển dụng → **Duyệt tin AI**)

1. Mở tab **Chờ duyệt** (số trên tab = số tin đang chờ). Tin cũ nhất ở trên — duyệt theo thứ tự để tin không bị giữ hàng.
2. Bấm vào tin: đọc **Nội dung AI đề xuất**, **Ngữ cảnh hội thoại** (tin được tô viền là bản nháp này) và **Lịch sử duyệt**.
3. Chọn:
   - **Duyệt** — nội dung đúng, phù hợp → xác nhận. Tin chuyển "Chờ gửi"; gửi khi Zalo outbound được bật.
   - **Sửa rồi duyệt** — chỉnh câu chữ (≤ 2.000 ký tự, phải khác bản gốc) → xác nhận. Gửi đúng bản đã sửa.
   - **Từ chối** — ghi lý do (≤ 500 ký tự). Tin không bao giờ được gửi.
4. Không duyệt tin: hứa hẹn kết quả tuyển dụng ("đã trúng tuyển", "bị loại"), hỏi thông tin nhạy cảm (tôn giáo, sức khoẻ,
   hôn nhân…), lương/lịch không có trong hệ thống, đường link hoặc số điện thoại lạ.
5. Bản duyệt hết hạn sau **30 phút** nếu chưa gửi; hội thoại đổi trạng thái (tiếp quản/đóng) cũng làm bản duyệt mất hiệu lực.
6. Báo "Tin đã thay đổi trạng thái" = HR khác vừa xử lý hoặc hội thoại đã đổi — màn hình tự tải lại, không thao tác lặp.
7. Ứng viên cần người thật / có khiếu nại / AI không trả lời được (hội thoại "AI tạm dừng") → **Hội thoại Zalo** → **Tiếp quản**,
   nhắn trực tiếp; xong thì **Trả lại AI** hoặc **Đóng hội thoại**.

## 4. Xử lý tin lỗi (tab **Gửi lỗi** + **Vận hành**)

| Trạng thái / cảnh báo | Ý nghĩa | Việc cần làm |
|---|---|---|
| Gửi lại (RETRY) | lỗi tạm (Zalo 429/5xx, chưa kết nối) | không làm gì — sender tự gửi lại theo backoff |
| Chưa rõ kết quả (UNKNOWN), cảnh báo `OUTBOUND_UNKNOWN` | request có thể đã tới Zalo | **không gửi lại mù**: hỏi ứng viên/xem OA; vận hành chọn đánh dấu đã gửi / gửi lại (chấp nhận trùng) / bỏ qua qua API `outbox/:id/mark-sent | retry | dead-letter` |
| Gửi lỗi (DEAD_LETTER) | Zalo từ chối vĩnh viễn | HR tiếp quản, liên hệ ứng viên bằng kênh khác nếu cần |
| `CHANNEL_EVENT_DEAD_LETTER`, `REPEATED_AI_FAILURE` | tin đến xử lý lỗi nhiều lần | xem mã lỗi; nếu do AI/gateway → dừng khẩn AI, báo vận hành; HR trả lời ứng viên thủ công |
| `AI_LIMIT_REACHED` | chạm trần lượt/token → AI tự dừng (failsafe) | đánh giá nguyên nhân; chỉ mở lại khi được duyệt |
| `AI_POLICY_HANDOFF` | câu trả lời AI bị chặn bởi chính sách (lộ thông tin/link lạ) | HR tiếp quản hội thoại |
| `CANDIDATE_MESSAGE_WAITING` | ứng viên vượt trần lượt/người | HR trả lời trực tiếp |

Xác nhận cảnh báo sau khi xử lý (nút ✓ trong Vận hành).

## 5. Dừng khẩn

- **Giao diện**: Vận hành → **Dừng khẩn tất cả** (hoặc từng phạm vi AI / Worker / Gửi Zalo) → nhập lý do → xác nhận. Hiệu lực ≤ 1 chu kỳ;
  tin chờ giữ nguyên, không mất. Mở lại từng phạm vi khi đã rõ nguyên nhân và có duyệt.
- **API** (khi không vào được giao diện): `POST /recruitment/operations/runtime-controls/stop {"scopes":["AI","WORKER","OUTBOUND"],"reason":"…"}` với JWT Nhân sự.
- **Tắt cứng** (khi API lỗi): `integrations/openclaw/production/activate-g8.sh off --go "<lý do>"` (đặt cả ba cờ env = false + restart 3010)
  và/hoặc `docker compose -f integrations/openclaw/production/docker-compose.yml --env-file /opt/kido-recruiter-prod/.env stop openclaw-gateway`.
- Sau khi dừng: HR tiếp quản các hội thoại đang mở; đối soát tin UNKNOWN; không gửi lại mù.

## 6. Rollback

| Thành phần | Lệnh | Ghi chú |
|---|---|---|
| Backend 3010 | `production/rollback-3010.sh` | về `6e79e1b` (artifact `/opt/kido-recruiter/releases/rollback-6e79e1b`, hash `d35c4525df905174`); schema giữ nguyên |
| Frontend | `mv /var/www/kido-app/dist …failed && cp -a /root/kido-app-dist-backups/dist-<ts> /var/www/kido-app/dist` | backup do `deploy-fe.sh` tạo |
| Cấu hình AI 3010 | `activate-g8.sh off --go "<lý do>"` | env pm2 không xoá được khoá → đặt `false` |
| Gateway | `docker compose … down` + 2 lệnh `ufw delete …` trong `production/README.md` | |
| PostgreSQL P1 | `ufw allow from <IP tin cậy> to any port 5432 proto tcp` | không mở lại cho toàn Internet |

## 7. Logging & giám sát

- `production/g8-health.sh` (chỉ đọc): 3010, gateway, cờ env, cờ dừng khẩn, hàng đợi tin đến/đi, chờ duyệt lâu nhất, cảnh báo,
  lượt/token hôm nay, lỗi log. Chạy đầu ca và mỗi 2 giờ trong canary.
- Giao diện: Tuyển dụng → thẻ số liệu, **Mức dùng AI**, **Vận hành** (cảnh báo, hàng đợi, hoạt động gần đây).
- Log: `pm2 logs sales-management` (logrotate); gateway `docker logs kido-recruiter-prod-openclaw-gateway-1` (dòng `kido-trace`
  chỉ có tên tool/endpoint/HTTP status — không nội dung, không key); audit `activity_log` (path `/recruitment-*`).
- Chi phí: trần token ngày/tháng ở backend + hạn mức cứng của project OpenAI production (đặt trên OpenAI, xác nhận trước GO).

## 8. Biến môi trường (3010) — file `/opt/kido-recruiter-prod/3010-g8.env` (600 root, nạp bằng `activate-g8.sh c0`)

| Biến | Giá trị canary | Ghi chú |
|---|---|---|
| `RECRUITMENT_OPENCLAW_URL` | `http://127.0.0.1:18790` | gateway chỉ loopback |
| `RECRUITMENT_OPENCLAW_TOKEN` | (bí mật) | = `OPENCLAW_GATEWAY_TOKEN` của gateway |
| `RECRUITMENT_CHANNEL_API_KEY` | (bí mật) | = key kênh của gateway; production không đặt `RECRUITMENT_AI_API_KEY` |
| `RECRUITMENT_OPENCLAW_AGENT_ID` / `_TIMEOUT_MS` | `main` / `240000` | |
| `RECRUITMENT_WORKER_CONCURRENCY` | `1` | |
| `RECRUITMENT_AI_REQUIRE_SUBJECT` | `true` | production bật AI mà khác `true` ⇒ không khởi động |
| `RECRUITMENT_PILOT_MODE` / `_SENDER_FINGERPRINTS` | `true` / `86e5620e525bfe1a` | 1 tài khoản nội bộ; thêm người = thêm fingerprint `sha256(oa:user)[:16]` |
| `RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR` / `_DAY` | `6` / `15` | mặc định trong mã cũng là giá trị này |
| `RECRUITMENT_AI_MAX_TURNS_PER_DAY` | `25` | |
| `RECRUITMENT_AI_DAILY_TOKEN_BUDGET` / `_MONTHLY_` | `5000000` / `20000000` | vượt ⇒ AI tự dừng |
| `RECRUITMENT_AI_TOKEN_RESERVATION_PER_TURN` | `200000` | |
| `RECRUITMENT_AI_ENABLED` / `RECRUITMENT_WORKER_ENABLED` / `RECRUITMENT_ZALO_OUTBOUND_ENABLED` | `false` | bật lần lượt ở C1 (AI+WORKER), C2 (OUTBOUND) |

Gateway: `/opt/kido-recruiter-prod/.env` (`OPENAI_API_KEY` project riêng, `OPENCLAW_GATEWAY_TOKEN`, `RECRUITMENT_CHANNEL_API_KEY`).

## 9. Checklist go-live (theo thứ tự, mỗi dòng cần người duyệt)

- [ ] 3 chữ ký GO (HR, vận hành, privacy) + danh sách ứng viên pilot đã đồng ý.
- [ ] Hạn mức chi phí cứng của project OpenAI production đã đặt.
- [ ] Deploy backend: `production/deploy-3010.sh --check` → `deploy-3010.sh` (tự rollback nếu smoke hỏng).
- [ ] Deploy frontend: `production/deploy-fe.sh --check` → `deploy-fe.sh`.
- [ ] HR đăng nhập kido-app, thấy tab Duyệt tin AI / Hội thoại Zalo / Vận hành; `g8-health.sh` sạch.
- [ ] Diễn tập dừng khẩn: Vận hành → Dừng khẩn tất cả → kiểm `g8-health.sh` → Mở lại (có lý do).
- [ ] `activate-g8.sh c0 --go …` → HR dừng khẩn **Gửi Zalo** → `activate-g8.sh c1 --go …` → tài khoản nội bộ nhắn 1 tin → bản nháp vào
      Chờ duyệt, Zalo 0 tin.
- [ ] HR duyệt bản nháp → `activate-g8.sh c2 --go …` → HR mở lại **Gửi Zalo** → đúng 1 tin tới đúng tài khoản nội bộ.
- [ ] Mở rộng pilot (≤ 5 ứng viên) chỉ sau báo cáo ngày đầu.
