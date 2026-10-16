# G8 — Phát hành lên 3010 + canary AI Recruiter (CHƯA THỰC HIỆN)

Trạng thái: **G8 = NO-GO**. Tài liệu này chuẩn bị; mỗi bước production cần duyệt riêng, lệnh do người vận hành chạy.
Không bước nào ở đây tự bật AI, worker, outbound hay gửi Zalo.

## 1. Định danh

| Mục | Giá trị |
|---|---|
| Nhánh / commit mã | `release/g8-p32` — mã runtime **`fdaa3ed`** (= `344befd` [p32 + master `6e79e1b`] + API màn HR + trần canary mặc định); commit sau chỉ đổi `integrations/` |
| Artifact backend | `/opt/kido-recruiter/releases/g8-hrconsole-fdaa3ed/dist` — hash dist `a782a48a1cac837a` (sha256 danh sách file, bỏ `*.tsbuildinfo`); unit 1536/1537 (lỗi duy nhất có sẵn trên master) |
| Artifact frontend | **Đã deploy 16/10 14:39** — kido-app `release/g8-fe-live` `1520f5a` (= `4dd3cc9` + 8 commit WIP đang live từ build 16/10 09:37, chủ WIP đồng ý; asset `public/*` PWA + model FaceId đưa vào git) → `/opt/kido-recruiter/releases/kido-app-g8-1520f5a/dist`, hash `a533c0eacfe19ca4`, bundle `index-CDAzqw7_.js`; build 2 lần từ worktree sạch + `npm ci` trùng hash. Backup bản trước: `/root/kido-app-dist-backups/dist-20261016-143901` (`87449e90…`). Không dùng `dist-g8-hrconsole` / `dist-g8-4dd3cc9` |
| Script | `production/deploy-3010.sh` · `rollback-3010.sh` · `deploy-fe.sh` · `activate-g8.sh c0|c1|c2|off` · `g8-health.sh`; vận hành: `G8-OPERATIONS.md` |
| Đang chạy 3010 | **`fdaa3ed`** từ 16/10 14:09 (`deploy-3010.sh`, dist `a782a48a1cac837a`, backup `/root/backups/g8-release-20261016-140920`); AI / worker / outbound tắt. Bản WIP trên đĩa trước đó chuyển sang `dist-before-g8-20261016-140920` — không dùng để rollback |
| Rollback | `/opt/kido-recruiter/releases/rollback-6e79e1b/dist` — hash `d35c4525df905174` = đúng artifact Codex đã deploy 14/10 |
| Phụ thuộc | `package.json` + `package-lock.json` của release = rollback = repo live ⇒ dùng `node_modules` hiện có |
| Schema | đã đủ: `recruitment_runtime_controls` (+ failsafe), cột `ai_*` của events, enum `DISCARDED_RUNTIME_HALTED`, `AWAITING_APPROVAL`, bảng duyệt — **không cần migration** |
| Chưa gộp | `release/mgmt-expense-periods` `20f4e54` (Chi QL theo HS/số tiết) — chốt: gộp vào release này hoặc deploy trước rồi rebase |

## 2. Kiểm tra trước (đã có bằng chứng)

- Unit 1535/1536 (lỗi duy nhất `suggest/expense-request.spec.ts` có sẵn trên master); typecheck 0; ESLint nguồn tuyển dụng 0.
- Staging image `344befd`: tool-e2e 20/20, an toàn G8 (bản cũ) / R1 18/18 / subject 38/38, **cổng duyệt p32 24/24 × 2**.
- Mặc định OFF: `RECRUITMENT_AI_ENABLED`, `RECRUITMENT_WORKER_ENABLED`, `RECRUITMENT_ZALO_OUTBOUND_ENABLED` chỉ bật khi đúng
  chuỗi `true`; 3010 hiện không đặt ⇒ sau deploy vẫn tắt. 3011 chạy cùng mã p32 ở `NODE_ENV=production` từ 15/10 ⇒ boot đã chứng minh.
- Gateway production: chạy rỗi, cách ly 20/20, chỉ `127.0.0.1:18790`, token bắt buộc (`production/README.md`).
- R1 xong: hộp đến 0 tin chờ (POST-EXCLUDE-VERIFICATION 33/33).

## 3. Deploy 3010 (bước riêng — đã đóng gói thành `production/deploy-3010.sh`, mô tả thủ công bên dưới để đối chiếu)

```bash
TS=$(date +%Y%m%d-%H%M%S); B=/root/backups/g8-release-$TS; mkdir -m 700 -p $B; umask 077
# 3.1 backup DB + xác minh
runuser -u postgres -- pg_dump -Fc sales_db > $B/sales_db.dump && pg_restore --list $B/sales_db.dump > /dev/null && sha256sum $B/sales_db.dump > $B/SHA256SUMS
pm2 jlist | python3 -c 'import json,sys;[print(p["name"],p["pid"],p["pm2_env"]["restart_time"]) for p in json.load(sys.stdin) if p["name"] in ("sales-management","sales-be-g8")]' > $B/pm2-before.txt
# 3.2 stage cạnh dist (cùng filesystem) + xác minh hash, rồi đổi tên nguyên khối
cp -a /opt/kido-recruiter/releases/g8-p32-344befd/dist /var/www/sales-management/dist-g8-$TS
(cd /var/www/sales-management/dist-g8-$TS && find . -type f ! -name '*.tsbuildinfo' -print0 | sort -z | xargs -0 sha256sum | sha256sum)   # phải 6e9ed78cc906fa76…
mv /var/www/sales-management/dist /var/www/sales-management/dist-wip-before-g8-$TS
mv /var/www/sales-management/dist-g8-$TS /var/www/sales-management/dist
pm2 restart sales-management        # KHÔNG --update-env (giữ env pm2 hiện có)
```

Smoke (dừng + rollback nếu FAIL): pm2 online, log khởi động không lỗi, không `RECRUITMENT_AI_SAFETY_CONFIG_INVALID`;
`/recruitment/ai/jobs/active` 503 `RECRUITMENT_AI_DISABLED`; `/recruitment/operations/runtime-controls` 401 không token;
webhook Zalo không chữ ký 403; đăng nhập + kido-app + `/recruitment/jobs`; 3 cờ dừng khẩn không đổi; outbox 0.
Ghi nhận: sau deploy, khối "Mức dùng AI" trên kido-app bắt đầu hiện (endpoint `ai-usage` có trên 3010).

## 4. Rollback

```bash
mv /var/www/sales-management/dist /var/www/sales-management/dist-g8-failed-$TS
cp -a /opt/kido-recruiter/releases/rollback-6e79e1b/dist /var/www/sales-management/dist   # hash d35c4525df905174
pm2 restart sales-management
```
KHÔNG quay về `dist-wip-before-g8-*` (đó là build WIP, không phải bản từng chạy). Schema giữ nguyên (mã cũ bỏ qua bảng/cột mới).

## 5. Kiểm thử dừng khẩn + failsafe trên production (sau deploy, duyệt riêng — đổi cờ dừng khẩn)

1. HR đăng nhập: `POST /recruitment/operations/runtime-controls/stop {"scopes":["AI","WORKER","OUTBOUND"],"reason":"G8 drill"}`
   ⇒ `GET …/runtime-controls` 3 cờ `true`, audit `RUNTIME_STOP` đúng người.
2. `POST …/resume` từng phạm vi theo cổng canary (không mở cả ba một lần).
3. Failsafe: trần lượt/token ⇒ tự dừng AI (đã nghiệm thu staging `g8-safety-acceptance` 44/44); production chỉ kiểm cấu hình
   trần qua `GET /recruitment/operations/ai-usage`. Không thử chạm trần thật.
4. Dừng khi API lỗi: `docker compose -f production/docker-compose.yml … stop openclaw-gateway` (cắt đường AI), rồi đặt lại
   cờ env `false` cho 3010 qua wrapper + restart.

## 6. Kế hoạch canary (sau khi đủ điều kiện mục 7 và 3 chữ ký GO)

| Giai đoạn | Thao tác | Điều kiện qua |
|---|---|---|
| C0 cấu hình (AI vẫn tắt) | 3010 qua `p372b-pm2-env.js --keys`: `RECRUITMENT_OPENCLAW_URL=http://127.0.0.1:18790`, `RECRUITMENT_OPENCLAW_TOKEN`, `RECRUITMENT_CHANNEL_API_KEY` (từ `/opt/kido-recruiter-prod/.env`), `RECRUITMENT_AI_REQUIRE_SUBJECT=true`, `RECRUITMENT_PILOT_MODE=true`, `RECRUITMENT_PILOT_SENDER_FINGERPRINTS=86e5620e525bfe1a` (tài khoản nội bộ), trần: `…_MAX_TURNS_PER_SENDER_HOUR=6`, `…_PER_SENDER_DAY=15`, `…_MAX_TURNS_PER_DAY=25`, `…_TOKEN_RESERVATION_PER_TURN=200000`, `…_DAILY_TOKEN_BUDGET=5000000`, `…_MONTHLY_TOKEN_BUDGET=20000000`; HR dừng OUTBOUND (runtime) | boot sạch, `ai-usage` đúng trần, pilot 1 người |
| C1 shadow | `RECRUITMENT_AI_ENABLED=true`, `RECRUITMENT_WORKER_ENABLED=true` (OUTBOUND env vẫn `false`); tài khoản nội bộ nhắn 1 tin | tin AI `AWAITING_APPROVAL`, không kết nối Zalo; usage/audit đúng; nội dung không lộ log |
| C2 gửi 1 tin | HR duyệt bản nháp; `RECRUITMENT_ZALO_OUTBOUND_ENABLED=true`; HR mở OUTBOUND | đúng 1 tin tới đúng tài khoản nội bộ; audit duyệt + gửi |
| C3 pilot | thêm ≤ 5 ứng viên đã đồng ý (fingerprint), khung giờ có HR trực | mỗi tin qua duyệt; báo cáo cuối ngày |

Giới hạn gửi: mọi tin AI phải được HR duyệt (TTL 30 phút); tối đa 25 lượt AI/ngày toàn hệ thống, 6/giờ & 15/ngày mỗi người;
chỉ người trong allowlist nhận tin AI. Dừng ngay khi: tin đi không có duyệt hợp lệ, sai người nhận/OA, lẫn phiên, dùng thông tin
nhạy cảm, AI tuyên bố tuyển/loại, audit thiếu, outbox `UNKNOWN`, chạm trần, kill switch chậm hơn một chu kỳ poll. Thao tác dừng:
HR `runtime-controls/stop` 3 phạm vi → xác nhận audit + 0 request mới → nếu API lỗi thì dừng gateway → HR tiếp quản hội thoại.

## 7. Điều kiện còn thiếu trước canary (không chặn deploy mục 3)

1. ~~Màn duyệt tin cho HR~~ — đã lên production 16/10 14:39; còn HR #158 xác minh bằng tài khoản thật: `python3 -I production/hr-verify-3010.py` (chỉ GET, mật khẩu ẩn, không in token).
   hình (hoặc công cụ dòng lệnh có đăng nhập HR) trước C1.
2. Xác nhận trần chi phí cứng của project OpenAI production (khoá đã ở `/opt/kido-recruiter-prod/.env`).
3. Cập nhật 4 bộ nghiệm thu cũ (control / outbound / worker / g8-safety) thêm bước HR duyệt; hội thoại model thật trên staging `344befd`.
4. P1 Postgres (an toàn production) — phiếu `/root/pg-p1-change-request-20261016.md`.
5. Danh sách ứng viên pilot đã đồng ý + 3 chữ ký GO (HR, vận hành, privacy).
