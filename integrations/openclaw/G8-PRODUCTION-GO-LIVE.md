# G8 Production Go-Live — AI Recruiter ICHI SKILL

Trạng thái: **release `release/g8-prod` đã chuẩn bị và kiểm thử, CHƯA deploy. PRODUCTION GO-LIVE = BLOCKED**
cho tới khi: OA ICHI SKILL có gói dịch vụ cho phép gửi Tin Tư vấn qua OpenAPI, lượt gửi nghiệm thu SENT,
và SYSTEM OWNER cấp GO PROD. Mỗi bước dưới đây cần phê duyệt riêng của SYSTEM OWNER.

## 1. Sự cố outbox #6 (đã đối soát)

- 18/10 01:04:50: HR mở lại Gửi Zalo → sender refresh token **thành công** (credential v2) → tiêu grant #1 →
  đúng **1 request** `POST /v3.0/oa/message/cs` → Zalo HTTP 200, `error=-224` sau 202 ms.
- `-224` = "The OA needs to upgrade OA Tier Package" — OA thiếu quyền gói dịch vụ. Không phải lỗi token,
  refresh, mạng hay sender. Không có `message_id`; không có webhook nào từ Zalo sau 00:27 → tin **không tới**.
- Code cũ coi `-224` là từ chối tạm (RETRY 1/3). HR tiếp quản 01:10:53 → #6 `SUPPRESSED`
  (`CONTROL_HUMAN_TAKEOVER`), grant #1 `CONSUMED`. Không gửi lại, không tái cấp grant.
- Phân loại: lỗi quyền dịch vụ OA — cần can thiệp vận hành (Owner nâng cấp gói), không retry.

## 2. Nguồn gốc release

- Commit `9ba0e83` nhập nguyên trạng WIP chưa commit ở `/opt/kido-recruiter/worktrees/g8-production-go-live`
  ("pre-existing local WIP; original author unverified"). Bằng chứng cục bộ (chưa kiểm chứng độc lập): session
  Codex VS Code 18/10 01:12–01:27 (turn aborted) tạo worktree đó; chỉ truy vấn `BEGIN READ ONLY` trên
  production, có ghi vào `sales_db_staging`. Snapshot + bản sao log: `/root/backups/g8-wip-snapshot-20261018-221044`.
  Worktree gốc giữ nguyên.
- Các commit sau là sửa lỗi review + yêu cầu SYSTEM OWNER, mỗi commit một thay đổi, có test.

| Commit | Nội dung |
|---|---|
| `197a60b` | Ledger: tạo dưới `sales_owner`, `sales_app` chỉ SELECT/INSERT/ghi kết quả; trigger append-only (WIP gốc: `sales_app` bị *permission denied*) |
| `b2f2259` | TTL tin HR 60 phút → `DEAD_LETTER HR_MESSAGE_EXPIRED` + audit + cảnh báo; cửa dispatch cũng chặn |
| `27ab48f` | Chạm quota/ngân sách → kết thúc + cảnh báo, không hoãn sang ngày/tháng sau |
| `4867c3a` | API HR huỷ tin HR đang chờ (`POST …/outbox/:id/cancel`), audit bắt buộc cùng transaction |
| `05adb67` | GO PROD: uỷ quyền production trong DB (app chỉ đọc), hạn mức trần, công cụ Owner + `activate-g8.sh prod/pilot` |
| `15c1a66` | `-224` → DEAD_LETTER, tự DỪNG KHẨN outbound (audit), cảnh báo CRITICAL `OUTBOUND_PROVIDER_BLOCKED` |
| `bbd4c6d` | Điều kiện "vị trí đã công bố" chỉ cho tin AI, chỉ vị trí DRAFT/chưa từng công bố |
| `9527c11` | Cửa GO PROD dùng advisory lock chia sẻ (FOR SHARE cần quyền UPDATE — phát hiện bằng test PG) |
| `0f0eca6` | Bộ integration test PostgreSQL thật (15 ca) |
| `f89b8fe` | Migration TypeORM khớp tuyệt đối SQL production |
| `c8cd585` | API usage trả hạn mức hiệu lực = min(env, uỷ quyền) |
| (ops) | `deploy-3010.sh ALLOW_C2=1`, chốt chặn `rollback-3010.sh`, cấu hình mẫu, tài liệu này |

Frontend: kido-app `release/g8-prod-fe` `fb07295` (từ bản live `ebce3dd`) — lý do lỗi gửi, nút huỷ tin HR,
bảng hạn mức gửi trong ngày, tách "chưa rõ" / "lỗi".

## 3. Cơ chế production

```text
Zalo user_send_text (chữ ký hợp lệ) → inbox bền → worker → OpenClaw (recruitment_*) → bản nháp AI
→ HR duyệt (TTL 30 phút) | HR viết tay (TTL 60 phút)
→ claim (chỉ khi có uỷ quyền GO PROD ACTIVE)
→ cửa dispatch, MỘT transaction: dừng khẩn · điều khiển hội thoại · bản duyệt khớp nội dung/OA/người nhận/version
   · TTL tin HR · uỷ quyền GO PROD (khoá chia sẻ) · tương tác user_send_text ≤ cửa sổ · vị trí đã công bố (tin AI)
   · quota ứng viên/cửa sổ trượt + ứng viên/ngày + toàn hệ thống/ngày + ngân sách
     (ledger bền, khoá toàn cục, ngày theo giờ Việt Nam)
   → ghi dispatched_at + 1 dòng ledger DISPATCHING
→ kiểm dừng khẩn lần cuối → Send API → SENT | RETRY (chắc chắn chưa đi) | UNKNOWN (có thể đã đi, không tự gửi lại) | DEAD_LETTER
```

- Không có uỷ quyền GO PROD → không claim, không gửi (đổi env một mình không bật được production).
- Hạn mức hiệu lực = min(env, uỷ quyền) — env chỉ hạ được. Ledger không xoá/sửa được (kể cả superuser).
- `-224` (cấu hình `RECRUITMENT_ZALO_OA_BLOCKING_ERRORS`) → tin FAILED + dừng khẩn tự động + cảnh báo CRITICAL;
  chỉ mở lại thủ công.
- Trạng thái trên giao diện: Đã gửi / Gửi lại / Chưa rõ — cần đối soát / Gửi lỗi (kèm lý do) / Đã huỷ.

## 4. Hạn mức production đã xác nhận

`/opt/kido-recruiter-prod/3010-production.env` (600 root, không secret) — mẫu: `production/3010-production.env.example`.

| Hạn mức | Giá trị |
|---|---|
| Tin / ứng viên / cửa sổ trượt | 25 / 5 giờ |
| Tin / ứng viên / ngày | 25 |
| Tin / toàn hệ thống / ngày | 100 |
| Ngân sách tin tính phí | 0 VND (ngày + tháng) |
| Cửa sổ tương tác = cửa sổ miễn phí | 48 giờ (chỉ Tin Tư vấn miễn phí) |
| TTL tin HR / bản duyệt AI | 60 / 30 phút |
| AI | 6 lượt/ứng viên/giờ; 25/ứng viên/ngày; 100/toàn hệ thống/ngày; trần token giữ nguyên |

Mọi lần nâng tiếp hoặc mở ngân sách tính phí đều cần GO PROD mới thay uỷ quyền cũ.

## 5. Điều kiện trước khi phục vụ ứng viên thật

1. Release deploy + migration (mục 6, S1–S3) — đã có duyệt.
2. #7 đã kết thúc (TTL tự động sau deploy, hoặc SQL một lần đã duyệt) — preflight đòi 0 dòng PENDING/SENDING/RETRY/UNKNOWN.
3. SYSTEM OWNER nâng cấp gói OA và tự kiểm trên OA Manager: đúng OA ICHI SKILL, gói còn hạn, có quyền OpenAPI /
   Tin Tư vấn, hạn mức và chi phí phù hợp. Thanh toán **không** phải bằng chứng Send API hoạt động.
4. Lượt gửi nghiệm thu (S5) SENT có `message_id`, Owner xác nhận nhận được trên Zalo của mình.
5. Vị trí cần tuyển đã công bố (ACTIVE + `published_at`); `MVP-SALES-01` hiện vẫn DRAFT.
6. HR trực ca 24 giờ đầu; backup + rollback sẵn sàng.
7. GO PROD do Owner cấp; HR mở lại Gửi Zalo (khoá thứ hai).

## 6. Quy trình (mỗi bước cần GO riêng)

Biến dùng chung:

```bash
REL=/opt/kido-recruiter/releases/g8-prod-<sha>      # artifact backend (xem MANIFEST trong thư mục)
EXPECT=<dist hash 16>                               # trong $REL/DIST_SHA
FE=/opt/kido-recruiter/releases/kido-app-g8-prod-fb07295/dist; FE_EXPECT=<hash 16 trong FE_SHA>
P=/opt/kido-recruiter/worktrees/g8-prod-release/integrations/openclaw/production
```

**S0 — Kiểm trạng thái (chỉ đọc).** Cờ phải là AI/WORKER/OUTBOUND/PILOT/GRANT = true, `outbound_halted=true`:

```bash
$P/g8-health.sh
runuser -u postgres -- psql -XAt -d sales_db -c "select outbound_halted, failsafe_halted from recruitment_runtime_controls"
```

**S1 — Backup** (deploy-3010.sh cũng tự backup):

```bash
B=/root/backups/g8-prod-$(date +%Y%m%d-%H%M%S); install -d -m 700 $B
runuser -u postgres -- pg_dump -Fc sales_db > $B/sales_db.dump && pg_restore --list $B/sales_db.dump >/dev/null
cp -a /root/.pm2/dump.pm2 $B/dump.pm2.bak; sha256sum $B/* > $B/SHA256SUMS; chmod 600 $B/*
```

**S2 — Migration online** (chỉ thêm bảng/enum; staging 0,15 s mỗi file; lock_timeout 5 s):

```bash
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db < $P/sql/g8-production-outbound-ledger-up.sql
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db < $P/sql/g8-production-go-prod-up.sql
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d sales_db < $P/sql/g8-production-recipient-window-up.sql
```

**S3 — Deploy backend + frontend, vẫn pilot + dừng khẩn** (1 restart 3010, ~10–20 s; FE không downtime):

```bash
cd /opt/kido-recruiter/worktrees/g8-prod-release
ALLOW_C2=1 REL=$REL EXPECT=$EXPECT ROLLBACK=/opt/kido-recruiter/releases/g8-guard-591dd90 \
  ROLLBACK_EXPECT=083001e9b044f070 integrations/openclaw/production/deploy-3010.sh --check
ALLOW_C2=1 REL=$REL EXPECT=$EXPECT ROLLBACK=/opt/kido-recruiter/releases/g8-guard-591dd90 \
  ROLLBACK_EXPECT=083001e9b044f070 integrations/openclaw/production/deploy-3010.sh
SRC=$FE EXPECT=$FE_EXPECT integrations/openclaw/production/deploy-fe.sh --check
SRC=$FE EXPECT=$FE_EXPECT integrations/openclaw/production/deploy-fe.sh
```

Sau S3: lượt dọn TTL (≤ 30 s) chuyển #7 → `DEAD_LETTER HR_MESSAGE_EXPIRED` + audit + cảnh báo HR (không gửi).
Nếu Owner muốn kết thúc #7 trước deploy: SQL một lần đã chuẩn bị ở `/root/backups/g8-outbox7-cancel-prep-20261018-225653`
(chạy `backup-before.sh` trước; chỉ khi Owner duyệt).

**S4 — Owner nâng cấp gói OA** (ngoài hệ thống; Owner tự chọn/thanh toán) và kiểm theo mục 5.3.

**S5 — Lượt gửi nghiệm thu tới Zalo của Owner** (pilot, single dispatch guard — 1 tin, chỉ khi Owner xác nhận
nội dung + người nhận): Owner nhắn OA → AI tạo nháp → HR duyệt (guard pilot chỉ gửi tin AI có grant; tin HR
không gửi được ở pilot) →

```bash
python3 -I $P/g8-owner-go.py approve c2s <outbox_id>          # Owner gõ trong terminal
python3 -I $P/g8-owner-go.py grant-dispatch <GO C2S> <outbox_id>
# HR: Vận hành → Mở lại OUTBOUND (lý do nghiệm thu) → kiểm SENT → HR: Dừng khẩn OUTBOUND lại
runuser -u postgres -- psql -XAt -d sales_db -c "select status, provider_message_id is not null from recruitment_channel_outbox where id=<outbox_id>"
```

Nếu vẫn `-224`: tin FAILED, outbound tự dừng khẩn, cảnh báo CRITICAL — dừng, Owner kiểm lại gói.

**S6 — GO PROD + chuyển production** (1 restart 3010; Gửi Zalo vẫn dừng):

```bash
install -m 600 -o root $P/3010-production.env.example /opt/kido-recruiter-prod/3010-production.env  # rồi điền đơn giá
CONF=/opt/kido-recruiter-prod/3010-production.env $P/g8-production-preflight.sh
python3 -I $P/g8-owner-go.py approve prod                    # Owner: outbox nghiệm thu, gói OA, hạn mức, rollback
cd $P && ./activate-g8.sh prod --go <GO PROD>                # authorize-prod → env → restart → kiểm mode=production
```

**S7 — Khoá thứ hai:** HR (Vận hành → Mở lại OUTBOUND, lý do "go-live production") khi Owner cho phép.
Lượt thật đầu tiên chỉ phát sinh từ ứng viên đã nhắn OA, AI tạo nháp, HR duyệt. Không gửi "tin thử".

**S8 — PM2 persistence** (mục 9) — chỉ sau khi xác nhận cờ/hạn mức/dừng khẩn đúng.

Downtime: S3 và S6 mỗi bước 1 restart 3010 (~10–20 s API tuyển dụng + các API khác của 3010).
Migration quota lấy khoá ngắn trên bảng uỷ quyền (lock timeout 5 giây), nên chỉ chạy khi OUTBOUND đang dừng.
Gateway OpenClaw và FE (nginx tĩnh) không gián đoạn.

## 7. Theo dõi 24 giờ đầu

```bash
$P/g8-health.sh                                              # cờ, hàng đợi, request tháng, chi phí ước tính
python3 -I $P/g8-owner-go.py list-prod                       # uỷ quyền đang hiệu lực + hạn mức
runuser -u postgres -- psql -XAt -d sales_db -c "select outcome, count(*) from recruitment_outbound_attempts where started_at >= date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh' group by 1"
pm2 logs sales-management --nostream --lines 300 | grep -E "sender outbox=|OUTBOUND DỪNG|runtime STOP"
```

HR console: thẻ "Gửi Zalo (production) — hôm nay", cảnh báo, hàng đợi (Chưa rõ — cần đối soát).

## 8. Dừng khẩn, thu hồi, rollback

- Dừng ngay: HR console → Dừng khẩn → OUTBOUND (có hiệu lực trong transaction dispatch + kiểm lại trước socket).
- Thu hồi production (không cần restart): `python3 -I $P/g8-owner-go.py revoke-prod <id>` — chờ dispatch đang
  chạy commit rồi chặn mọi request mới.
- Tắt cứng khi API không dùng được: `./activate-g8.sh off --go "<lý do>"`.
- Về pilot: `./activate-g8.sh pilot --go "<lý do>"` (kết thúc uỷ quyền trước, rồi PILOT=true + guard).
- Rollback ứng dụng — **thứ tự bắt buộc**: `activate-g8.sh pilot` (hoặc `off`) → rồi
  `ROLLBACK=/opt/kido-recruiter/releases/g8-guard-591dd90 ROLLBACK_EXPECT=083001e9b044f070 $P/rollback-3010.sh`
  (script tự chặn nếu env còn production: code cũ không biết `PRODUCTION_MODE`). FE: `deploy-fe.sh` với
  `/opt/kido-recruiter/releases/kido-app-g8-ebce3dd/dist`.
- Schema: giữ bảng ledger + uỷ quyền khi đã có dữ liệu (down SQL tự từ chối). Không restore toàn DB trừ thảm hoạ
  được Owner duyệt (mất dữ liệu phát sinh sau backup).

## 9. Reboot và PM2

- `pm2-root.service` (enabled) chạy `pm2 resurrect` từ `/root/.pm2/dump.pm2`. Hiện dump lưu **14/10**: chỉ 6
  biến `RECRUITMENT_*` (đang chạy 26) → reboot làm 3010 mất cấu hình G8 (AI/outbound tắt — fail-closed, nhưng mất
  C0/C1).
- Trạng thái bền ở DB qua reboot: dừng khẩn (`recruitment_runtime_controls`), uỷ quyền GO PROD, ledger/quota, bản
  duyệt — reboot không mở gửi và không reset quota.
- `pm2 save` ghi trạng thái của **toàn bộ 26 tiến trình** (cả hệ thống khác). Chỉ chạy khi: cờ 3010 đúng mục 4,
  sender log đúng mode, và người phụ trách các tiến trình khác xác nhận trạng thái hiện tại của họ là mong muốn:

```bash
cp -a /root/.pm2/dump.pm2 /root/.pm2/dump.pm2.bak-$(date +%Y%m%d-%H%M%S)
pm2 jlist | python3 -c "import json,sys;[print(p['name'],p['pm2_env']['status'],p['pm2_env']['restart_time']) for p in json.load(sys.stdin)]"
pm2 save && chmod 600 /root/.pm2/dump.pm2
```

- Sau reboot (kế hoạch hoặc không): `g8-health.sh`, `list-prod`, kiểm dòng `sender start … mode=… authorization=…`.

## 10. Đối soát UNKNOWN

Tin `UNKNOWN` (có thể đã tới Zalo) không bao giờ tự gửi lại; khoá đầu hàng của ứng viên. HR kiểm OA Manager rồi
chọn: Đã gửi (MARK_SENT) / Gửi lại (xác nhận rủi ro trùng) / Bỏ (DEAD_LETTER) — đều có audit.

## 11. Giới hạn đã biết

- Cửa sổ tương tác chỉ tính `user_send_text` đã xử lý (ảnh/sticker không làm mới cửa sổ) — bảo thủ.
- Kiểm TTY của `g8-owner-go.py` là rào thủ tục, không phải ranh giới bảo mật với root.
- Cảnh báo chỉ trên HR console (không email/SMS).
- Danh tính người gửi do webhook OA (chữ ký) gắn; đa OA chưa hỗ trợ (backlog Phase 3).

## 12. Tài liệu Zalo

- [Mã lỗi OA](https://developers.zalo.me/community/detail/180158e464a18dffd4b0): `-224` OA cần nâng cấp gói.
- [Tin Tư vấn](https://oa.zalo.me/home/documents/guides/tin-tu-van): OpenAPI tối đa 7 ngày từ tương tác cuối, miễn phí 48 giờ.
- [Tổng quan tin OA](https://oa.zalo.me/home/documents/guides/tong-quan-cac-loai-tin-nhan-tren-zalo-official-account-_3651713298729094511).
