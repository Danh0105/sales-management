# G8 Production Go-Live — AI Recruiter ICHI SKILL

Trạng thái tài liệu: **release đã chuẩn bị, chưa deploy, outbound production chưa được phép bật**.

## 1. Incident outbox #6

### Kết luận

- Zalo Send API nhận đúng **1 request** cho outbox #6 lúc 01:04:50 ngày 18/10/2026 và trả `error=-224` sau 202 ms.
- Trước đó OAuth refresh thành công, credential store tăng lên version 2 và có access/refresh token mã hoá còn hiệu lực. Vì vậy không phải lỗi access token, refresh token hay mạng.
- Theo bảng mã lỗi chính thức của Zalo, `-224` nghĩa là OA cần nâng cấp OA Tier Package để sử dụng tính năng. Đây là lỗi entitlement/gói OA.
- Request bị Zalo từ chối, không có `message_id`; trạng thái đối soát là **không gửi/không phát tới ứng viên**.
- Grant #1 được tiêu atomically trước kết nối, đúng thiết kế single-use. Không có request gửi thứ hai, không được tái cấp grant.
- Code cũ chưa xếp `-224` vào lỗi vĩnh viễn nên outbox tạm vào `RETRY`. Sau khi HR takeover và thu hồi approval, cửa điều khiển chuyển #6 sang `SUPPRESSED` (`CONTROL_HUMAN_TAKEOVER`). Đây là trạng thái cuối đúng; không resend.

### Dấu vết đã đối soát (không PII/secret)

| Dấu vết | Kết quả |
|---|---|
| Outbox #6 | `SUPPRESSED`, `attempt_count=1`, không `provider_message_id` |
| Grant #1 | `CONSUMED`, `dispatches_used=1/1` |
| OAuth | refresh `ok`, credential version 2 |
| Sender | đúng một dòng `attempt=1 result=RETRY code=ZALO_-224` |
| Zalo | phản hồi nghiệp vụ `-224`, không có message id |
| Hội thoại | `HUMAN_TAKEOVER`; approval #6 đã `REVOKED` |

Không gọi thêm API Zalo để điều tra và không thực hiện lượt gửi thật nào.

## 2. Thay đổi tối thiểu trong release

1. `-224` và các mã từ chối cố định đã công bố được phân loại `DEAD_LETTER` ngay; không retry mù.
2. `RECRUITMENT_PRODUCTION_MODE` loại trừ với pilot. Nếu outbound bật mà không có đúng mode kiểm soát, ứng dụng fail closed.
3. Production bỏ pilot allowlist/single-dispatch grant nhưng thêm cửa transaction ngay trước mạng:
   - AI reply vẫn phải có approval HR còn hạn và khớp content/OA/recipient/control version;
   - tương tác `user_send_text` đã xử lý của đúng user + đúng OA, tối đa 168 giờ;
   - application có job thì job phải `ACTIVE` và đã có `published_at`;
   - quota theo recipient/ngày và toàn hệ thống/ngày;
   - ngân sách ước tính ngày/tháng;
   - runtime/failsafe kill switch được kiểm trong transaction và kiểm lại ngay trước khi mở socket.
4. Mỗi lần chuẩn bị gọi Send API được ghi vào `recruitment_outbound_attempts` trước khi mở mạng. Ledger chỉ có metadata/fingerprint, không nội dung, token hay Zalo user id thô.
5. Kết quả request là `SENT`, `RETRY`, `UNKNOWN`, `REJECTED` hoặc `DEAD_LETTER`. `UNKNOWN` không tự gửi lại; HR/vận hành phải đối soát rồi `MARK_SENT`, xác nhận rủi ro để `RETRY`, hoặc `DEAD_LETTER`.
6. API vận hành mới `GET /recruitment/operations/outbound-usage` trả số request, outcome và chi phí ước tính; overview tách `sendUnknown`, `sendFailed`, `sendRetrying`.
7. `HR_MESSAGE` giữ quy trình hiện hữu: chỉ HR có quyền mới tạo; thao tác tự chuyển hội thoại sang `HUMAN_TAKEOVER`, lưu canonical message + audit, rồi vào cùng interaction/quota/cost/kill-switch gate. Vì nội dung do HR trực tiếp viết, không qua approval AI lần hai.

## 3. Hạn mức đề xuất cho ngày đầu

Khởi đầu bảo thủ, không gửi tin có thể tính phí:

```dotenv
RECRUITMENT_PRODUCTION_MODE=true
RECRUITMENT_PILOT_MODE=false
RECRUITMENT_PILOT_SENDER_FINGERPRINTS=
RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED=false
RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS=168
RECRUITMENT_ZALO_FREE_WINDOW_HOURS=48
RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY=3
RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY=50
RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND=0
RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND=0
RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND=<DON_GIA_HIEN_HANH_LON_HON_0>
RECRUITMENT_AI_ENABLED=true
RECRUITMENT_WORKER_ENABLED=true
RECRUITMENT_ZALO_OUTBOUND_ENABLED=false
```

Budget `0` làm mọi tin ngoài 48 giờ bị giữ `RETRY` mà không gọi mạng. Sau khi Owner đối chiếu biểu phí/gói OA, tăng budget là một thay đổi cấu hình riêng có audit/phê duyệt; không gộp vào go-live đầu tiên. Chi phí ở ledger là ước tính bảo thủ, không thay thế hoá đơn Zalo.

Giữ nguyên các giới hạn OpenAI hiện có theo ứng viên/giờ, ứng viên/ngày, toàn hệ thống/ngày và token ngày/tháng. SYSTEM OWNER phải xác nhận project OpenAI riêng có hard limit trước GO.

## 4. Điều kiện bắt buộc trước triển khai

- Zalo xác nhận OA tuyển dụng đã kích hoạt Tier Package hỗ trợ Send API; lỗi `-224` không còn là blocker. Không kiểm bằng cách gửi thử thật.
- SYSTEM OWNER duyệt bằng văn bản: release SHA/hash, các hạn mức trên, OpenAI hard limit, người HR trực ca, cửa sổ bảo trì và rollback.
- HR xử lý outbox #7 và mọi `PENDING/SENDING/RETRY/UNKNOWN` khác; preflight yêu cầu bằng 0 để không có tin cũ bất ngờ đi sau cutover.
- Danh sách job `ACTIVE` được HR rà soát; không có job `ACTIVE` thiếu `published_at`.
- Runtime `outbound_halted=true`; env `RECRUITMENT_ZALO_OUTBOUND_ENABLED=false` trong suốt migration/deploy/config.
- Backup DB đọc được bằng `pg_restore --list`; artifact và rollback artifact có SHA-256.
- Gateway healthy, chỉ bind `127.0.0.1:18790`; tool allowlist vẫn chỉ `recruitment_*`.
- Không dùng real candidate làm smoke test. Không gọi Send API Zalo trong kiểm tra kỹ thuật.

## 5. Lệnh chuẩn bị và triển khai

Các lệnh dưới đây chỉ được chạy sau khi SYSTEM OWNER cấp quyền cho đúng bước. Thay `<RELEASE>` và `<ROLLBACK>` bằng đường dẫn artifact đã chốt; không đặt secret trên command line.

### 5.1 Pre-deploy — chỉ đọc

```bash
cd /opt/kido-recruiter/worktrees/g8-production-go-live
git status --short
git rev-parse HEAD

CONF=/opt/kido-recruiter-prod/3010-production.env \
  integrations/openclaw/production/g8-production-preflight.sh
```

Preflight trước migration sẽ dừng ở “thiếu migration”; đó là expected. Mọi blocker khác phải được xử lý trước.

### 5.2 Dừng outbound và backup

Dùng HR console chọn **Dừng khẩn → OUTBOUND** và xác nhận audit. Sau đó:

```bash
runuser -u postgres -- psql -XAt -d sales_db \
  -c "select outbound_halted from recruitment_runtime_controls where id=1"

cd /opt/kido-recruiter/worktrees/g8-production-go-live/integrations/openclaw/production
./activate-g8.sh off --go "production cutover"

BACKUP=/root/backups/g8-production-$(date +%Y%m%d-%H%M%S)
install -d -m 700 "$BACKUP"
runuser -u postgres -- pg_dump -Fc sales_db > "$BACKUP/sales_db.dump"
pg_restore --list "$BACKUP/sales_db.dump" >/dev/null
pm2 jlist | python3 -c 'import json,sys; p=[x for x in json.load(sys.stdin) if x["name"]=="sales-management"][0]; print(p["pid"], p["pm2_env"]["status"], p["pm2_env"]["restart_time"], p["pm2_env"]["pm_exec_path"])' > "$BACKUP/pm2-before.txt"
sha256sum "$BACKUP/sales_db.dump" > "$BACKUP/SHA256SUMS"
chmod 600 "$BACKUP"/*
```

Không đưa backup/log chứa env lên Git hoặc report.

### 5.3 Migration online

```bash
cd /opt/kido-recruiter/worktrees/g8-production-go-live
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db \
  < integrations/openclaw/production/sql/g8-production-outbound-ledger-up.sql
```

Migration chỉ tạo bảng/index/FK mới, không rewrite hay update dữ liệu nghiệp vụ. Staging đo được 0,15 giây. Dành maintenance budget 1 phút cho DB production.

### 5.4 Deploy artifact, vẫn giữ outbound tắt

```bash
REL=<RELEASE> EXPECT=<DIST_HASH> \
ROLLBACK=<ROLLBACK> ROLLBACK_EXPECT=<ROLLBACK_DIST_HASH> \
integrations/openclaw/production/deploy-3010.sh --check

REL=<RELEASE> EXPECT=<DIST_HASH> \
ROLLBACK=<ROLLBACK> ROLLBACK_EXPECT=<ROLLBACK_DIST_HASH> \
integrations/openclaw/production/deploy-3010.sh
```

Nạp file production `600 root` vào duy nhất process `sales-management`, với outbound vẫn false:

```bash
cd /var/www/sales-management
node /opt/kido-recruiter/worktrees/g8-production-go-live/integrations/openclaw/scripts/p372b-pm2-env.js \
  --app sales-management \
  --env-file /opt/kido-recruiter-prod/3010-production.env \
  --keys RECRUITMENT_PRODUCTION_MODE,RECRUITMENT_PILOT_MODE,RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED,RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS,RECRUITMENT_ZALO_FREE_WINDOW_HOURS,RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY,RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY,RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND,RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND,RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND,RECRUITMENT_AI_ENABLED,RECRUITMENT_WORKER_ENABLED,RECRUITMENT_ZALO_OUTBOUND_ENABLED
```

`PILOT_SENDER_FINGERPRINTS` cố ý không nạp; `PILOT_MODE=false` khiến ứng dụng không dùng allowlist.

### 5.5 Preflight cuối — vẫn không gửi

```bash
CONF=/opt/kido-recruiter-prod/3010-production.env \
  /opt/kido-recruiter/worktrees/g8-production-go-live/integrations/openclaw/production/g8-production-preflight.sh

/opt/kido-recruiter/worktrees/g8-production-go-live/integrations/openclaw/production/g8-health.sh
```

SYSTEM OWNER xem report và trả lời GO riêng. GO này không phải grant outbox cũ và tuyệt đối không tái cấp grant #1.

### 5.6 GO production — hai khoá

Chỉ sau GO cuối:

```bash
cd /var/www/sales-management
node /opt/kido-recruiter/worktrees/g8-production-go-live/integrations/openclaw/scripts/p372b-pm2-env.js \
  --app sales-management --set RECRUITMENT_ZALO_OUTBOUND_ENABLED=true
```

Kiểm log phải có `mode=production dispatchGuard=off`, migration ready và không có config error. Sau đó SYSTEM OWNER/HR dùng HR console mở runtime **OUTBOUND** với lý do go-live. Hai bước tách biệt: env cho phép sender chạy, runtime gate mới cho phép request mạng.

Không gửi “smoke message” thật. Lượt thật đầu tiên chỉ phát sinh từ ứng viên đã chủ động nhắn OA, AI tạo draft, HR đọc và duyệt.

## 6. Luồng vận hành thật

```text
Zalo user_send_text có chữ ký hợp lệ
→ inbox event lưu bền / session theo OA + sender
→ worker gọi OpenClaw recruitment_* và lưu mọi turn
→ AI reply thành AWAITING_APPROVAL
→ HR duyệt đúng nội dung/OA/recipient/version
→ PENDING
→ production admission + ledger DISPATCHING
→ Send API
→ SENT | RETRY | UNKNOWN | DEAD_LETTER
```

- `SENT`: Zalo trả success; lưu `message_id` rồi redaction bản sao outbox.
- `RETRY`: chắc chắn chưa gửi hoặc provider từ chối tạm thời; backoff an toàn.
- `UNKNOWN`: request có thể đã tới nhưng mất/timeout response; khóa FIFO, không auto resend.
- `DEAD_LETTER`/UI `FAILED`: lỗi cố định hoặc quá số lần; không tự gửi lại.
- `REJECTED`: một request bị từ chối token trước khi refresh; request kế tiếp (nếu có) có ledger riêng.

Đối soát `UNKNOWN`: vận hành kiểm tra Zalo OA, rồi dùng một trong ba thao tác audited: `MARK_SENT`, `RETRY` kèm xác nhận duplicate risk, hoặc `DEAD_LETTER`. Hiện Zalo không cung cấp trong integration này một API tra cứu message-by-client-id, nên đối soát UNKNOWN vẫn là tác vụ người vận hành.

## 7. Dừng khẩn và rollback

### Dừng ngay

Ưu tiên HR console **Dừng khẩn → OUTBOUND**. Gate transaction và check trước socket ngăn request mới sau khi flag commit; request đã ở trên mạng không thể thu hồi.

Nếu console/API lỗi, lớp tắt cứng:

```bash
cd /opt/kido-recruiter/worktrees/g8-production-go-live/integrations/openclaw/production
./activate-g8.sh off --go "production incident"
```

### Rollback ứng dụng

1. Giữ runtime outbound halt và env outbound false.
2. Đổi về artifact `<ROLLBACK>`, restart 3010, smoke API.
3. **Giữ bảng ledger** nếu đã có bất kỳ request nào; rollback code không cần xoá schema.
4. Chỉ khi chưa từng có request và Owner quyết định hủy migration:

```bash
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db \
  < integrations/openclaw/production/sql/g8-production-outbound-ledger-down.sql
```

Down migration tự từ chối nếu ledger có dữ liệu. Không restore toàn DB trừ thảm hoạ dữ liệu được Owner phê duyệt, vì restore sẽ làm mất ứng viên/tin/audit mới phát sinh.

## 8. Downtime và tiêu chí phục vụ thật

- Migration staging: 0,15 giây; rollback 0,14 giây. Production budget: tối đa 1 phút cho schema step.
- Mỗi restart 3010: dự kiến 10–20 giây theo script hiện hữu. Cutover có ba restart (hard-off, deploy, nạp config), tổng gián đoạn API dự kiến **30–60 giây** trong cửa sổ bảo trì **tối đa 2 phút**; outbound bị dừng xuyên suốt. Bật env outbound ở bước GO gây thêm một restart 10–20 giây nhưng runtime gate vẫn đóng.
- Gateway OpenClaw không cần public port và không cần restart nếu image/config không đổi.

Bắt đầu phục vụ ứng viên thật chỉ khi toàn bộ điều kiện sau xanh:

```text
OA Tier Package confirmed
production migration present
release hash verified
PILOT=false, PRODUCTION=true, grant=false
AI/worker healthy
HR approval gate verified by mock tests
runtime outbound halted until final GO
no unfinished legacy outbox
published jobs reviewed
OpenAI hard limit confirmed
HR on duty
backup + rollback verified
SYSTEM OWNER final GO recorded
```

Nếu thiếu một điều kiện: **PRODUCTION GO-LIVE = BLOCKED**.

## 9. Tài liệu Zalo đã đối chiếu

- [Bảng mã lỗi Official Account](https://stc-developers.zdn.vn/docs/v2/official-account/phu-luc/ma-loi): `-224` yêu cầu nâng cấp OA Tier Package; `-230` là ngoài điều kiện tương tác.
- [Tin Tư vấn](https://oa.zalo.me/home/documents/guides/tin-tu-van): cửa sổ OpenAPI tối đa 7 ngày, chính sách miễn phí trong 48 giờ.
- [Chính sách tương tác OA với người dùng](https://oa.zalo.me/home/documents/vie/policy/tuong-tac-cua-oa-voi-nguoi-dung): chỉ gửi đúng người nhận, nội dung phù hợp với tương tác.
