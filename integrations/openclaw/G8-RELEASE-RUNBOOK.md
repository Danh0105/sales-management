# G8 — Phát hành lên 3010 + canary AI Recruiter (CHƯA THỰC HIỆN)

Trạng thái: **G8 = NO-GO** cho tới khi SYSTEM OWNER cấp GO từng cổng (`production/g8-owner-go.py`, mục 6). Lệnh do Owner / vận hành chạy.
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

## 6. Owner Approval + kích hoạt C0 → C1 → C2

Từ 16/10/2026 quyết định GO thuộc **một người: SYSTEM OWNER** (thay cho 3 chữ ký HR / vận hành / privacy). Cổng duyệt tin
của Nhân sự **không đổi**: mọi tin AI gửi Zalo vẫn phải được HR duyệt trong kido-app.

- GO cấp bằng `python3 -I production/g8-owner-go.py approve c0|c1|c2` — chỉ chạy khi Owner gõ trực tiếp trong terminal
  (agent / pipe không cấp được), Owner gõ họ tên + câu `TOI PHE DUYET <CỔNG>`. Mỗi GO: mã riêng `G8-C<n>-<thời điểm>-<4 hex>`,
  đúng 1 cổng, hiệu lực 12 giờ, dùng 1 lần. Bản ghi `/opt/kido-recruiter-prod/go/<mã>.json` (600 root: người duyệt, thời gian,
  phạm vi, trần, pilot, OpenAI) + `ledger.jsonl` (approve / consume / revoke, sha256 bản ghi). `list` xem, `revoke <mã>` thu hồi.
- C1 và C2: lúc duyệt, Owner đối chiếu khoá OpenAI rút gọn với dashboard và nhập hạn mức USD + gõ `DUNG PROJECT`; xác nhận
  tài khoản Zalo pilot (fingerprint, số tin đã nhắn OA) và gõ 4 ký tự cuối fingerprint.
- `activate-g8.sh <cổng> --go <mã>` từ chối nếu GO không hợp lệ / sai cổng / hết hạn / đã dùng / đã thu hồi; mở cổng xong mới
  đánh dấu GO đã dùng. `activate-g8.sh off` (tắt cứng) không cần GO.

**P0 — một lần, trước C0** (Owner chạy; không in bí mật; agent bị chặn ghi bí mật nên không tự làm bước này):

```bash
# APP_SECRET của app OA tuyển dụng (cần cho refresh token) → cấu hình 3010 chưa nạp
umask 077; C=/opt/kido-recruiter-prod/3010-g8.env; cp -p $C $C.bak-$(date +%Y%m%d-%H%M%S)
grep -q '^RECRUITMENT_ZALO_APP_SECRET=' $C || grep -m1 '^RECRUITMENT_ZALO_APP_SECRET=' /root/recruitment-oa.env >> $C
grep -c '^RECRUITMENT_ZALO_APP_SECRET=' $C                                     # = 1
# credential OA ICHI SKILL (bản mã P3-7.1, giải mã được bằng RECRUITMENT_ZALO_TOKEN_KEY của 3010) → DB
node -e 'const c=require("/root/recruitment-oa.credential.json");const q=v=>"\x27"+String(v).replace(/\x27/g,"\x27\x27")+"\x27";process.stdout.write("INSERT INTO recruitment_zalo_credentials (oa_id, access_token_enc, refresh_token_enc, access_expires_at) VALUES ("+[c.oa_id,c.access_token_enc,c.refresh_token_enc].map(q).join(", ")+", "+q(c.access_expires_at)+"::timestamptz) ON CONFLICT (oa_id) DO NOTHING;\n")' | runuser -u postgres -- psql -XAt -v ON_ERROR_STOP=1 -d sales_db
runuser -u postgres -- psql -XAt -d sales_db -c "select count(*) from recruitment_zalo_credentials"   # = 1
```

**Kích hoạt** (`cd /opt/kido-recruiter/worktrees/release-g8-p32/integrations/openclaw/production`):

| Cổng | Owner cấp GO | Lệnh | Sau đó |
|---|---|---|---|
| C0 | `python3 -I g8-owner-go.py approve c0` | `./activate-g8.sh c0 --go <mã C0>` | HR: Vận hành → Dừng khẩn **Gửi Zalo**; `./g8-health.sh` |
| C1 | `python3 -I g8-owner-go.py approve c1` (OpenAI + pilot) | `./activate-g8.sh c1 --go <mã C1>` | tài khoản pilot nhắn 1 tin → HR thấy 1 bản nháp ở **Duyệt tin AI**, Zalo 0 tin |
| C2 | `python3 -I g8-owner-go.py approve c2` (OpenAI + pilot) — GO C2 **chỉ kích hoạt**, không cấp quyền gửi | `./activate-g8.sh c2 --go <mã C2>` | HR duyệt đúng 1 bản nháp → Owner `python3 -I g8-owner-go.py approve c2s <outbox_id>` (GO C2S gắn đúng tin đó) → `python3 -I g8-owner-go.py grant-dispatch <mã C2S> <outbox_id>` → HR mở lại **Gửi Zalo** → đúng 1 dispatch tới tài khoản pilot |

C2 bật OUTBOUND env **trước** khi HR duyệt (Gửi Zalo vẫn đang dừng khẩn nên chưa gửi) để hạn 30 phút của bản duyệt không trôi
trong lúc restart. Chưa `pm2 save` tới khi ổn định (reboot ⇒ 3010 về cấu hình tắt AI).

### Single dispatch guard (bắt buộc trước C2)

Không dựa vào việc HR bấm dừng khẩn sau khi gửi. Pilot mode bật ⇒ sender chỉ gửi tin có **grant dispatch** của Owner:

- Bảng `recruitment_outbound_dispatch_grants` (migration `1793000000000`, production: `production/sql/g8-dispatch-guard-up.sql`,
  rollback `…-down.sql`). Mỗi grant gắn **1 outbox AI**, ghi OA, fingerprint người nhận, sha256 nội dung đã duyệt, version điều
  khiển, `max_dispatches = 1`, hạn ≤ 2 giờ (công cụ cấp ≤ 30 phút, không quá hạn bản duyệt). Unique theo outbox (không bao giờ cấp
  lại), unique index chỉ 1 grant `ACTIVE` toàn hệ thống. Trigger một chiều: chỉ grant `ACTIVE` đổi được, không giảm số lần đã
  dùng ("hoàn" hạn mức), phạm vi bất biến, không xoá grant đã tiêu — áp cả superuser. `sales_app` chỉ SELECT + UPDATE 4 cột tiêu
  hạn mức, **không INSERT/DELETE** ⇒ ứng dụng không tự tạo / bổ sung hạn mức; chỉ Owner (postgres) qua `grant-dispatch`.
- Claim: chỉ tin `AI_REPLY` có grant `ACTIVE` còn hạn. Cửa kiểm cuối: khoá advisory toàn cục + grant `FOR UPDATE`, kiểm khớp đầy
  đủ (outbox, OA cấu hình, người nhận pilot, hash nội dung, version, hạn) cùng các kiểm sẵn có (dừng khẩn/failsafe, HR tiếp quản,
  bản duyệt còn hạn + hash + người nhận), rồi ghi `dispatched_at` và tiêu grant **trong cùng transaction** — commit xong mới gọi
  Zalo; tiêu không được ⇒ rollback cả hai. Không khớp ⇒ giữ chờ (`HELD`, `DISPATCH_GRANT_*`), không gọi mạng.
- Sau khi tiêu: RETRY, gửi lại của vận hành (UNKNOWN → PENDING), restart, crash, redeploy đều không có grant ⇒ không dispatch.
  Crash sau dispatch ⇒ `UNKNOWN` (không tự gửi lại). Ngoại lệ duy nhất: gửi lại MỘT lần trong cùng lease khi Zalo từ chối
  token (lần đầu chắc chắn chưa tới) — grant ghi `consumed_lease_owner`, lease khác bị từ chối.
- Guard bật mà thiếu bảng ⇒ sender không chạy (fail-closed). `activate-g8.sh c2` kiểm migration + bản build + log
  `dispatchGuard=on`.
- `grant-dispatch` chỉ cấp khi: GO C2 hợp lệ và chưa dùng để cấp grant; hàng đợi có ĐÚNG 1 dòng chưa xong là tin đó (PENDING,
  AI_REPLY, chưa dispatch); bản duyệt APPROVED còn ≥ 2 phút, khớp hash/OA/người nhận/version; hội thoại `AI_ACTIVE`; người nhận
  thuộc pilot; **Gửi Zalo đang dừng khẩn**; chưa có grant ACTIVE còn hạn. INSERT kiểm lại toàn bộ trong cùng transaction.

**Hai GO tách biệt (C2S, migration `1793100000000`):**

- **GO C2** (`approve c2`): CHỈ cho `activate-g8.sh c2`, một lần (VALID → USED). Không cấp được grant.
- **GO C2S** (`approve c2s <outbox_id>`, tạo SAU khi HR duyệt): gắn đúng outbox + OA + fingerprint pilot + sha256 nội dung
  + version điều khiển + version bản duyệt HR; hạn = min(hạn bản duyệt, 30 phút); chỉ tạo khi điều kiện grant đã đạt (hàng
  đợi đúng 1 dòng là tin đó, Gửi Zalo đang dừng khẩn, bản duyệt còn ≥ 2 phút…). `grant-dispatch` CHỈ nhận GO C2S VALID,
  đúng outbox đã gắn, so lại mọi trường đã gắn (đổi nội dung / người nhận / OA / version / bản duyệt bị sửa, thu hồi, hết hạn
  ⇒ từ chối) và INSERT bằng chính các giá trị đã gắn, cùng transaction với audit.
- Một GO C2S → tối đa một grant: DB `UQ_dispatch_grant_go` + trigger `TRG_dispatch_grant_c2s_only` (grant MỚI chỉ nhận mã
  `G8-C2S-…`; grant cũ mã `G8-C2-…` giữ nguyên) + khoá file `go/.dispatch.lock`. Trạng thái GO C2S tính theo DB (đã có grant
  mang mã ⇒ USED) nên crash giữa chừng không làm GO trở lại VALID.
- Audit: `ledger.jsonl` + `activity_log` (`OWNER_GO_C2S_APPROVE`, `OWNER_DISPATCH_GRANT_CREATE`/`_REVOKE`,
  `OWNER_GO_C2S_REVOKE`, `OWNER_DISPATCH_REJECT` kèm lý do) — chỉ ghi sha256 của mã GO, không ghi mã; nhật ký
  `activate-g8.sh` ghi `go_fp` thay mã.
- Triển khai C2S (cần duyệt riêng, không deploy backend — cổng gửi không đọc `go_code`): (1) `runuser -u postgres -- psql -X
  -v ON_ERROR_STOP=1 -d sales_db -f production/sql/g8-dispatch-guard-c2s-up.sql` → (2) đưa nhánh `feat/g8-c2s` vào worktree
  công cụ (`release/g8-p32`). Rollback: worktree về commit cũ + `…-c2s-down.sql` (tự chặn khi đã có grant C2S).

**Triển khai guard (đã làm 17/10):** (1) `runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db -f production/sql/g8-dispatch-guard-up.sql`
(tạo bảng rỗng — mã đang chạy bỏ qua bảng) → (2) `REL=…/g8-guard-<sha> EXPECT=<hash> ROLLBACK=…/g8-expiry-9fb92e7
ROLLBACK_EXPECT=c54dd7e78ef6cdc1 ALLOW_C1=1 production/deploy-3010.sh`. Rollback ứng dụng không cần gỡ bảng; gỡ bảng
(`…-down.sql`) tự chặn khi đã có grant được tiêu.

### Kế hoạch canary

| Giai đoạn | Thao tác | Điều kiện qua |
|---|---|---|
| C0 cấu hình (AI vẫn tắt) | 3010 qua `p372b-pm2-env.js --keys`: `RECRUITMENT_OPENCLAW_URL=http://127.0.0.1:18790`, `RECRUITMENT_OPENCLAW_TOKEN`, `RECRUITMENT_CHANNEL_API_KEY` (từ `/opt/kido-recruiter-prod/.env`), `RECRUITMENT_AI_REQUIRE_SUBJECT=true`, `RECRUITMENT_PILOT_MODE=true`, `RECRUITMENT_PILOT_SENDER_FINGERPRINTS=86e5620e525bfe1a` (tài khoản nội bộ), trần: `…_MAX_TURNS_PER_SENDER_HOUR=6`, `…_PER_SENDER_DAY=15`, `…_MAX_TURNS_PER_DAY=25`, `…_TOKEN_RESERVATION_PER_TURN=200000`, `…_DAILY_TOKEN_BUDGET=5000000`, `…_MONTHLY_TOKEN_BUDGET=20000000`; HR dừng OUTBOUND (runtime) | boot sạch, `ai-usage` đúng trần, pilot 1 người |
| C1 shadow | `RECRUITMENT_AI_ENABLED=true`, `RECRUITMENT_WORKER_ENABLED=true` (OUTBOUND env vẫn `false`); tài khoản nội bộ nhắn 1 tin | tin AI `AWAITING_APPROVAL`, không kết nối Zalo; usage/audit đúng; nội dung không lộ log |
| C2 gửi 1 tin | HR duyệt bản nháp; `RECRUITMENT_ZALO_OUTBOUND_ENABLED=true` + single dispatch guard; Owner `grant-dispatch`; HR mở OUTBOUND | đúng 1 dispatch tới đúng tài khoản nội bộ; grant `CONSUMED`; audit duyệt + gửi |
| C3 pilot | thêm ≤ 5 ứng viên đã đồng ý (fingerprint), khung giờ có HR trực | mỗi tin qua duyệt; báo cáo cuối ngày |

Giới hạn gửi: mọi tin AI phải được HR duyệt (TTL 30 phút); tối đa 25 lượt AI/ngày toàn hệ thống, 6/giờ & 15/ngày mỗi người;
chỉ người trong allowlist nhận tin AI. Dừng ngay khi: tin đi không có duyệt hợp lệ, sai người nhận/OA, lẫn phiên, dùng thông tin
nhạy cảm, AI tuyên bố tuyển/loại, audit thiếu, outbox `UNKNOWN`, chạm trần, kill switch chậm hơn một chu kỳ poll. Thao tác dừng:
HR `runtime-controls/stop` 3 phạm vi → xác nhận audit + 0 request mới → nếu API lỗi thì dừng gateway → HR tiếp quản hội thoại.

## 7. Điều kiện còn thiếu trước canary (không chặn deploy mục 3)

1. ~~Màn duyệt tin cho HR~~ — production 16/10 14:39; HR verify `production/hr-verify-3010.py` 6/6 PASS (Owner xác nhận).
2. Hạn mức OpenAI: Owner báo 100 USD/chu kỳ, hard limit — xác nhận lại đúng project trong `approve c1` / `approve c2`.
3. Cập nhật 4 bộ nghiệm thu cũ (control / outbound / worker / g8-safety) thêm bước HR duyệt; hội thoại model thật trên staging `344befd`.
4. P1 Postgres (an toàn production) — phiếu `/root/pg-p1-change-request-20261016.md`.
5. GO của SYSTEM OWNER cho từng cổng (mục 6). Pilot giai đoạn đầu: chỉ tài khoản nội bộ `86e5620e525bfe1a`; C3 cần quyết định riêng.
