# HR migrations

Module HRM có **luồng migration riêng**, tách hẳn khỏi `src/migrations` + `src/data-source.ts`.

|                | Luồng cũ              | Luồng HR                                        |
| -------------- | --------------------- | ----------------------------------------------- |
| DataSource     | `src/data-source.ts`  | `src/hr/database/hr-data-source.ts`             |
| Thư mục        | `src/migrations/*.ts` | `src/hr/migrations/*.ts`                        |
| Bảng theo dõi  | `public.migrations`   | `hr.migrations`                                 |
| Schema runtime | `synchronize: true`   | `@Entity({ schema: 'hr', synchronize: false })` |

## Vì sao tách

- Runtime vẫn `synchronize: true`; schema `public` do synchronize dựng, `src/migrations` không dựng lại được DB
  (migration `Init` đã lỗi thời). Không được chạy `npm run typeorm migration:run` để lấy bảng HR.
- `sales_db` trên server là **DB dùng chung** của `sales-management` (prod) và `sales-be` (dev) —
  xem `src/utils/is-cron-leader.ts`. Trên server không có staging.

## Lệnh

```bash
# Xem trước — session read-only, không ghi gì
HR_MIGRATION_DATABASE_URL=postgres://user:pass@host:5432/sales_db_hr_dev npm run hr:migration:show

# Thực thi — phải gõ đúng tên DB đang kết nối
HR_MIGRATION_DATABASE_URL=... npm run hr:migration:run -- --confirm-db=sales_db_hr_dev
#   thêm --allow-caution nếu có migration CAUTION đã được review
```

Chốt an toàn của runner:

1. Không có URL mặc định — thiếu `HR_MIGRATION_DATABASE_URL` là dừng.
2. Mặc định chỉ xem trước; session mở với `default_transaction_read_only=on`.
3. Thực thi cần `--apply` (đã có trong `hr:migration:run`) **và** `--confirm-db=<tên DB thật>`.
4. `NODE_ENV=production` cần thêm `HR_ALLOW_PRODUCTION_MIGRATION=yes` — người vận hành tự đặt.
5. Từ chối migration DANGEROUS hoặc thiếu nhãn; CAUTION cần `--allow-caution`.
6. `pg_try_advisory_lock` — hai runner không chạy chồng nhau.
7. `lock_timeout=5s`, `statement_timeout=60s`; mỗi migration một transaction.
8. `installExtensions: false` — TypeORM không tự `CREATE EXTENSION`.

## Truy vấn DB test (`hr-dev-sql.ts`)

```bash
npx ts-node -r tsconfig-paths/register src/hr/database/hr-dev-sql.ts "SELECT * FROM hr.migrations"
npx ts-node -r tsconfig-paths/register src/hr/database/hr-dev-sql.ts --write "INSERT INTO hr.x ..."
npx ts-node -r tsconfig-paths/register src/hr/database/hr-dev-sql.ts --file=query.sql
```

Chỉ chạy được khi `HR_MIGRATION_DATABASE_URL` trỏ tới `localhost`/`127.0.0.1`/`::1` **và** database
`sales_db_hr_dev`, URL không có tham số `?...`; sau khi kết nối còn kiểm tra lại `current_database()` và
`inet_server_addr()`. Mặc định read-only, `--write` mới cho ghi. Luôn chặn `DROP/CREATE DATABASE`,
`ALTER SYSTEM`, quản lý ROLE, `COPY` ra file/chương trình, đọc/ghi file hệ thống. Xem `dev-target.ts`.

## Viết migration HR

- Tên file `<timestamp>-hr-<mo-ta>.ts`, timestamp `>= 1791700000000`, không trùng; tên class kết thúc bằng timestamp đó.
- Khai báo `static readonly risk: MigrationRisk = 'SAFE' | 'CAUTION'` + comment mô tả và cách rollback.
- Mọi DDL/DML ghi rõ schema `"hr".`. Ngoài `hr`, chỉ được `REFERENCES "public"."employee"("id")` (nên `ON DELETE RESTRICT`).
- Idempotent: `IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS` trước `CREATE TRIGGER`.
- Cấm: `TRUNCATE`, `DROP SCHEMA/DATABASE/COLUMN`, `CASCADE`, `ALTER COLUMN ... TYPE`, `RENAME`, ghi vào `public.*`.
- `down()` chỉ gỡ đối tượng vừa tạo, và phải có guard không xoá dữ liệu:
  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM "hr"."x") THEN RAISE EXCEPTION 'hr.x có dữ liệu — rollback tay sau khi backup'; END IF;
  END $$;
  DROP TABLE IF EXISTS "hr"."x";
  ```
- Thay đổi cấu trúc theo expand/contract: thêm cột nullable → backfill (migration riêng) → NOT NULL (CAUTION).
- Extension (`btree_gist`, `pgcrypto`) và `ALTER TYPE ... ADD VALUE` (khai báo `transaction = false`) là CAUTION, migration riêng.

`src/hr/database/migration-risk.spec.ts` kiểm tra các luật trên cho mọi file trong thư mục;
`src/hr/common/hr-entity-guard.spec.ts` chặn entity HR thiếu `schema: 'hr'` / `synchronize: false`.

## Thứ tự trên production (người vận hành làm tay)

1. Backup (`scripts/backup-db-to-nas.sh`).
2. `hr:migration:show` → đọc danh sách + nhãn rủi ro.
3. `NODE_ENV=production HR_ALLOW_PRODUCTION_MIGRATION=yes ... hr:migration:run -- --confirm-db=sales_db`.
4. Sau đó mới deploy code dùng entity HR. Code deploy trước khi có bảng thì chỉ API HR lỗi, module cũ không ảnh hưởng.
5. Chạy từ bản build: `node dist/hr/database/run-hr-migrations.js [--apply --confirm-db=...]`.

Rollback: gỡ `HrModule` khỏi `AppModule` (bảng `hr.*` còn nguyên, không ai dùng). Không bao giờ `DROP SCHEMA hr` tự động.

## Bootstrap quản trị HR đầu tiên

Chưa ai có `ACCESS_ADMIN` sau khi chạy migration — không ai gọi được API cấp quyền. Người vận hành cấp
HR role quản trị đầu tiên bằng script (ghi assignment + audit trong một transaction, actor = script):

```bash
# Xem trước (read-only)
HR_MIGRATION_DATABASE_URL=... npm run hr:access:bootstrap -- --account-id=<id> --reason="<lý do>"
# Thực thi — production còn cần HR_ALLOW_PRODUCTION_MIGRATION=yes
HR_MIGRATION_DATABASE_URL=... npm run hr:access:bootstrap -- --account-id=<id> --reason="<lý do>" --apply --confirm-db=<tên_db>
```

Mặc định `--role=HR_ADMIN --scope=COMPANY`; chỉ nhận scope COMPANY/ALL. Từ đó trở đi mọi việc cấp/thu hồi
đi qua API `/api/hr/v1/access/...` (không tự cấp/thu hồi cho chính mình → nên bootstrap ít nhất 2 người).

### Bootstrap là break-glass

`hr:access:bootstrap` chỉ dùng cho **thiết lập ban đầu / khôi phục thảm hoạ** — không phải cách xử lý
thông thường khi thiếu quản trị. Bảo vệ chính là `--confirm-db=<tên DB chính xác>` (khác một ký tự là
ABORT); `NODE_ENV` chỉ là lớp phụ. Mọi lần bootstrap ghi audit `ACCESS_GRANT` (actor = script).

## Quota quản trị HR (HrAccessSafetyService)

Mỗi công ty phải còn tối thiểu **2 protected HR administrator** — tài khoản active có HR role assignment
chưa thu hồi, đã hiệu lực, **không có `effective_to`**, role đang bật, role có `ACCESS_ADMIN`, scope
COMPANY/ALL. Thu hồi / đổi assignment (API HR), khoá / xoá tài khoản (`EmployeeService`) đều đi qua
`HrAccessSafetyService` dưới `pg_advisory_xact_lock(791700301)`; làm quota tụt dưới 2 → `409 HR_ADMIN_MINIMUM`.
`GET /api/hr/v1/access/admin-status` để giám sát.

### Bootstrap quyền nhạy cảm ban đầu (Task 0.3.1)

M1 không cho ai cấp quyền mà chính mình chưa có, nên quyền xem dữ liệu nhạy cảm đầu tiên chỉ có thể đến từ
bootstrap — và luôn CÓ THỜI HẠN:

```bash
npm run hr:access:bootstrap -- --account-id=<id> --role=HR_SENSITIVE_VIEWER \
  --effective-to=<YYYY-MM-DD> --reason="Initial sensitive access" --apply --confirm-db=<tên_db>
```

Role chứa `SALARY_VIEW` / `IDENTITY_REVEAL` / `BANK_REVEAL` bắt buộc `--effective-to`, tối đa
`MAX_SENSITIVE_ACCESS_DAYS` ngày **tính cả ngày đầu và ngày cuối** (`effectiveTo <= effectiveFrom + 179`).
Bước xem trước đã kiểm tra luật này; chạy lại cùng role + scope bị từ chối (không tạo trùng).
Mọi mốc ngày HR tính theo giờ Việt Nam do ứng dụng truyền vào — không dùng `CURRENT_DATE` của DB
(DB local đang ở múi giờ America/Los_Angeles).

## Backfill lịch sử cơ cấu tổ chức (Phase 1.2.2 — chỉ khi thiết lập)

API thường không cho lùi ngày revision/lãnh đạo. Tái dựng lịch sử dùng CLI riêng:

```bash
# Xem trước — session chỉ đọc, mô phỏng trong bộ nhớ, kiểm tra toàn bộ cấu trúc tại mọi mốc thời gian
HR_MIGRATION_DATABASE_URL=... npm run hr:org:backfill -- --plan=org-history.json --reason="<lý do>"
# Thực thi — cần HR_SETUP_MODE=yes (người vận hành tự đặt) + đúng tên DB; production thêm HR_ALLOW_PRODUCTION_MIGRATION=yes
HR_SETUP_MODE=yes HR_MIGRATION_DATABASE_URL=... npm run hr:org:backfill -- --plan=org-history.json --reason="<lý do>" --apply --confirm-db=<tên_db>
```

File kế hoạch (JSON). Đơn vị MỚI khai bằng `ref` tạm — **không tự chọn mã**: hệ thống sinh `DV####`.
Đơn vị ĐÃ CÓ tham chiếu bằng mã thật (`DV0001`…).

```json
{
  "history": [
    { "code": "DV0003", "revisions": [
      { "effectiveFrom": "2022-01-01", "unitType": "DEPARTMENT", "name": "Phòng Bán hàng", "parentCode": "DV0002" }
    ] }
  ],
  "units": [
    { "ref": "branch_long_an", "revisions": [
      { "effectiveFrom": "2023-01-01", "unitType": "BRANCH", "name": "Chi nhánh Long An", "parentCode": "DV0001" },
      { "effectiveFrom": "2025-12-31", "unitType": "BRANCH", "name": "Chi nhánh Long An", "parentCode": "DV0001", "status": "INACTIVE" }
    ] },
    { "ref": "hr_long_an", "revisions": [
      { "effectiveFrom": "2023-02-01", "unitType": "DEPARTMENT", "name": "Phòng Nhân sự", "parentRef": "branch_long_an" }
    ] }
  ],
  "leaders": [
    { "unitCode": "DV0002", "employeeCode": "NV000012", "leaderRole": "BRANCH_DIRECTOR",
      "isApprovalAuthority": true, "effectiveFrom": "2021-03-01", "effectiveTo": "2024-12-31", "positionCode": "CD0001" },
    { "unitRef": "hr_long_an", "employeeCode": "NV000020", "leaderRole": "DEPARTMENT_HEAD",
      "isApprovalAuthority": true, "effectiveFrom": "2023-02-01", "effectiveTo": "2024-06-30" }
  ]
}
```

- `history`: revision CHÈN TRƯỚC revision đầu tiên của đơn vị đã có (revision cuối tự kết thúc ngay trước revision hiện có).
- `units`: đơn vị mới hoàn toàn; `ref` gồm chữ thường, số, `_` (2–64 ký tự, bắt đầu bằng chữ), duy nhất.
  Cha là đơn vị đã có → `parentCode`; cha là đơn vị mới trong cùng kế hoạch → `parentRef` (chỉ một trong hai).
  Lãnh đạo: `unitCode` (đơn vị đã có) hoặc `unitRef` (đơn vị mới).
- Mã cấp theo thứ tự phụ thuộc: cha trước con, hoà thì theo thứ tự khai — cùng kế hoạch luôn cùng thứ tự.
  Xem trước in bảng `ref → mã DỰ KIẾN`; sau khi ghi in `mã ĐÃ CẤP` (khác dự kiến nếu có người tạo đơn vị
  trong lúc đó — CLI ghi chú). Vòng tham chiếu `parentRef`, ref trùng, `parentRef`/`unitRef` không có → lỗi.
- Mọi ngày ≤ hôm nay. Ghi trong một transaction dưới advisory lock, đọc lại trạng thái và kiểm tra lại
  trước khi ghi; audit `source: BACKFILL_CLI` (kèm `planHash`, `ref`, mã thật), actor = script.
- **Idempotency** (`hr.org_backfill_runs`, migration 0900):
  - chạy lại ĐÚNG kế hoạch đã áp dụng (so theo SHA-256 của JSON chuẩn hoá — đổi thứ tự khoá/khoảng trắng
    vẫn là cùng kế hoạch) → "ĐÃ được áp dụng", không làm gì, exit 0;
  - kế hoạch khác khai lại một `ref` đã tạo → lỗi, chỉ ra mã đã cấp; tham chiếu bằng mã đó.

## Mã do hệ thống sinh (migration 0900)

| Loại | Định dạng | Sequence |
|---|---|---|
| Nhân viên | `NV` + 6 số | `hr.employee_code_seq` (0600) |
| Đơn vị | `DV` + 4 số | `hr.org_unit_code_seq` |
| Chức danh | `CD` + 4 số | `hr.position_code_seq` |

Người dùng không nhập/sửa mã (API tạo/sửa gửi `code` → 400). Mã unique, bất biến, không tái sử dụng;
có thể có khoảng trống khi transaction rollback. Sequence bắt đầu sau mã cùng định dạng lớn nhất đang có;
mã tạo tay trước đây (kể cả trùng định dạng) giữ nguyên và được bỏ qua khi cấp.

## Hồ sơ nhân viên cơ bản (Phase 1.2.3 — migration 0800)

`1791700000800-hr-employee-core-profile` (SAFE) chỉ THÊM cột vào `hr.employees`:
`attendance_mode` (mặc định `UNASSIGNED`), `date_of_birth`, `gender`, `phone`,
`work_email`, `personal_email`, `full_name_search` (nội bộ, NOT NULL, backfill).

- Hồ sơ đang có → `attendance_mode = UNASSIGNED` (chưa phân loại). Không tự đổi
  sang `SHIFT`; import 1.2.4 phân loại theo decision file. Trước khi dùng chấm
  công (Phase 3) mọi hồ sơ ACTIVE phải được phân loại.
- `hr.employees.status` (ACTIVE/INACTIVE) là trạng thái HỒ SƠ, KHÔNG phải trạng
  thái việc làm. Từ Phase 1.4, Employment History là nguồn sự thật đó.
- `full_name_search` luôn do server tính (`normalizeVietnameseName`). Ghi thẳng
  SQL vào `hr.employees` mà thiếu cột này sẽ bị NOT NULL chặn — cố ý.
- Cần database encoding **UTF8** (hàm `normalize()`); sai encoding → migration lỗi, rollback.
- `down()` chỉ gỡ index và bỏ NOT NULL của `full_name_search` (để code cũ ghi được);
  không xoá cột — xoá cột là mất dữ liệu, DBA làm tay sau khi backup.

Sau khi chạy migration trên DB nào (dev, staging, production), kiểm tra hợp đồng
chuẩn hoá trên chính DB đó (CHỈ ĐỌC; không in họ tên):

```bash
HR_MIGRATION_DATABASE_URL=... npm run hr:employees:verify-search
# exit 0 = khớp; 1 = có lệch (in id hồ sơ lệch); 2 = lỗi cấu hình
```

Backlog hiệu năng: tìm "chứa" (`LIKE '%x%'`) không dùng được index B-tree. Chấp
nhận ở quy mô hiện tại; khi dữ liệu lớn cân nhắc `pg_trgm` + GIN bằng migration riêng.

## Import hồ sơ nhân viên từ decision file (Phase 1.2.4 — migration 1000)

Chỉ **Employee Core** (mã NV hệ thống sinh, tài khoản liên kết, họ tên, SĐT, email, ngày sinh, giới tính,
kiểu chấm công, trạng thái hồ sơ). KHÔNG đơn vị, chức danh, quản lý, ngày vào làm, thử việc, lương, hợp đồng,
trạng thái việc làm (Phase 1.4 / module tương ứng). Không nhập dữ liệu định danh nhạy cảm.

```bash
# 1. Phân tích (chỉ đọc) → CSV phân tích + BẢN NHÁP decision file trong backup/hr-import/ (đã .gitignore)
HR_MIGRATION_DATABASE_URL=... npm run hr:employees:analyze
# 2. Người duyệt sửa cột `decision` từng dòng: IMPORT / SKIP (bản nháp: NO → SKIP, còn lại → REVIEW)
# 3. Xem trước (mặc định, session chỉ đọc) — kiểm tra TOÀN BỘ file
HR_MIGRATION_DATABASE_URL=... npm run hr:employees:import -- --file=<decisions.csv> --reason="<lý do>"
# 4. Thực thi — production còn cần HR_ALLOW_PRODUCTION_MIGRATION=yes
HR_MIGRATION_DATABASE_URL=... npm run hr:employees:import -- --file=<decisions.csv> --reason="<lý do>" --apply --confirm-db=<tên_db>
```

Cột decision file: `accountId, decision, fullName, attendanceMode, phone, workEmail, personalEmail, dateOfBirth,
gender, orgUnitCode, note` (+ các cột tham khảo `legacy*`, `category`, `analysis*` — bỏ qua). Cột khác → lỗi.

- Chỉ `IMPORT` được ghi. Còn `REVIEW`, giá trị lạ, hoặc BẤT KỲ lỗi nào → không ghi gì.
- `attendanceMode` bắt buộc với IMPORT: `SHIFT` / `TEACHING_SESSION` / `UNASSIGNED` (chưa chắc → UNASSIGNED).
- Tài khoản phải tồn tại, chưa gắn hồ sơ, không trùng trong file. SĐT/email trùng → chỉ cảnh báo.
  Dữ liệu kiểm tra bằng đúng luật của API tạo hồ sơ (DTO). Tài khoản khoá → hồ sơ INACTIVE.
- `orgUnitCode` (DV####, đơn vị đang hoạt động) chỉ là ĐỀ XUẤT: lưu ở `hr.employee_import_items` cho Phase 1.4,
  không ghi vào `hr.employees`.
- ALL-OR-NOTHING: một transaction cho cả file, dưới advisory lock (import đồng thời chạy tuần tự), đọc lại
  trạng thái và kiểm tra lại trước khi ghi. Mã NV có thể nhảy số khi rollback — chấp nhận.
- Idempotency: `hr.employee_import_batches.checksum` (SHA-256 file) — chạy lại đúng file → "ĐÃ được áp dụng".
- Audit: `EMPLOYEE_IMPORT` (batchId, checksum, số IMPORT/SKIP, mã NV đầu/cuối) + `EMPLOYEE_CREATE` từng hồ sơ
  (`source: IMPORT`). Console/audit không in họ tên, email, SĐT, nội dung hay đường dẫn file.

## Hồ sơ tài liệu (Phase 1.3 — migration 1100, 1110, 1130, 1140)

Dùng lại hoàn toàn Private Files 0.4C: mỗi phiên bản tài liệu là một dòng `hr.files`; xem/tải qua
`POST files/:id/access` → `GET files/:id/content` sẵn có (không có kho, endpoint tải hay token mới).

- `1100` (SAFE): `hr.employee_documents`, `hr.employee_document_versions`; quyền `DOCUMENT_VIEW`,
  `DOCUMENT_MANAGE` (HR_OFFICER + role cũ `nhansu` COMPANY), `HEALTH_DOCUMENT_VIEW` (nhạy cảm, không gán).
- `1110` (**CAUTION**, cần `--allow-caution`): CHECK `hr.files.document_type` nhận thêm RESUME, DEGREE,
  CERTIFICATE, HEALTH_CERTIFICATE (thêm CHECK mới NOT VALID → VALIDATE → bỏ CHECK cũ; không đổi dòng nào).
- `1130` (**CAUTION**): file của phiên bản cũ (không phải `current_version_id`) còn ACTIVE → ARCHIVED
  (`version + 1`, lý do "Phiên bản cũ — đã có phiên bản mới"). Idempotent; `down()` không hoàn tác (dữ liệu
  vẫn còn, chỉ đổi trạng thái).
- `1140` (SAFE): `hr.account_permission_grants` thêm `revoked_at`, `revoked_by`, `revoke_reason` (CHECK đi
  cặp) + index grant còn hiệu lực. Grant đã thu hồi hết hiệu lực từ ngày thu hồi (giờ VN).

**Không có role riêng cho giấy khám** (giữ 6 HR role). `HEALTH_DOCUMENT_VIEW` là quyền nhạy cảm duy nhất của
giấy khám (không có `..._REVEAL`), cấp **quyền lẻ** từng người qua Access Admin — cùng luật với cấp role:
không tự cấp, phạm vi/đơn vị hợp lệ, M1 (không vượt quyền mình), M2 (bắt buộc hạn, ≤ 180 ngày), audit
`ACCESS_GRANT` / `ACCESS_REVOKE` (entity `account_permission_grant`). `ACCESS_ADMIN` không cấp lẻ (400
`HR_DIRECT_GRANT_NOT_ALLOWED`) — quản trị chỉ qua role HR_ADMIN.

API (`/api/hr/v1/access`): `GET accounts/:id/permission-grants` (ACCESS_VIEW),
`POST accounts/:id/permission-grants` (ACCESS_ADMIN; body như cấp role, `permissionCode` thay `roleCode`;
trùng còn hiệu lực → 409), `POST permission-grants/:id/revoke` (`{ reason, version }`). UI: trang Phân quyền
→ khu "Quyền lẻ".

Người giữ đầu tiên (break-glass, chỉ phạm vi COMPANY):

```bash
npm run hr:access:bootstrap -- --account-id=<id> --permission=HEALTH_DOCUMENT_VIEW   --effective-to=<YYYY-MM-DD> --reason="Initial health document access" --apply --confirm-db=<tên_db>
```

DB đã chạy migration `1120` (role `HEALTH_DOCUMENT_VIEWER`, file đã bỏ khỏi repo) → dọn bằng lệnh riêng,
không dùng `migration:revert`. Mặc định chỉ xem trước; **dừng nếu role còn bất kỳ assignment nào** (kể cả đã
thu hồi/hết hạn — lịch sử phải giữ). Khi áp dụng: xoá quyền của role, role, và dòng `hr.migrations` của 1120;
audit `HR_ROLE_REMOVE`. Chạy lại an toàn ("Không còn gì để dọn").

```bash
npm run hr:access:cleanup-health-role                      # xem trước
npm run hr:access:cleanup-health-role -- --reason="Bỏ role theo quyết định 1.3" --apply --confirm-db=<tên_db>
```

Loại tài liệu: RESUME, DEGREE (CONFIDENTIAL, không có hạn), CERTIFICATE (CONFIDENTIAL, hạn tuỳ chọn),
HEALTH_CERTIFICATE (RESTRICTED, hạn bắt buộc), OTHER (INTERNAL — lưu file loại `GENERAL` có sẵn; file GENERAL
cũ hiển thị là "Tài liệu khác"). Không lưu số hiệu giấy tờ; không có lý lịch tư pháp.
Thêm phiên bản → file của bản hiện hành cũ chuyển ARCHIVED; ACTIVE chỉ còn nghĩa là bản hiện hành. Bản cũ vẫn
xem/tải lại được (người có quyền xem loại đó) khi tài liệu còn ACTIVE. Lưu trữ tài liệu → lưu trữ mọi file, không
tải được nữa. Không có quyền xem giấy khám: backend không trả ghi chú/tên file/nút tải và từ chối sửa ghi chú
(403 `HR_DOCUMENT_NOTE_FORBIDDEN`).
