# API DANH SÁCH TẤT CẢ CHÍNH SÁCH (DIRECTOR)

API tổng hợp cho tab **"Tất cả chính sách"** ở `/director/nhan-vien`. Thay thế việc gọi `GET /policies/stats?employeeId=...` lặp theo từng nhân viên (N+1) bằng **một request duy nhất**, lọc / phân trang / sắp xếp **hoàn toàn dưới database**.

> Code nằm trong [src/policy/](src/policy/). Không tạo module mới — bổ sung vào `PolicyController` / `PolicyService` sẵn có.

---

## 1. Endpoints

`GET /policies` đã được dùng cho `findAll()` cũ (trả toàn bộ policy thô, không filter) nên **giữ nguyên** để không phá FE hiện tại. Endpoint mới:

| Method | Path | Mô tả |
|---|---|---|
| GET | `/policies/all` | **Contract FE chốt cho tab "Tất cả chính sách"** — phân trang, `limit` mặc định 12, wrapper `pagination` |
| GET | `/policies/admin/all` | Bản đầy đủ — thêm `search`, `sortBy`/`sortOrder`, `policyData`, `hasNextPage`/`hasPreviousPage` |
| GET | `/policies/filter-options` | Tùy chọn cho 6 bộ lọc, giới hạn theo phạm vi user |

Base path không có prefix `/api`. Bắt buộc `Authorization: Bearer <access_token>`.

> **Chọn endpoint nào?** Hai endpoint dùng chung query builder, chung bộ filter và chung quy tắc phân quyền — chỉ khác projection + phân trang. Dùng `/policies/all` cho tab danh sách (payload nhẹ hơn ~8 lần vì không kèm `policyData`). Dùng `/policies/admin/all` khi cần ô tìm kiếm, đổi cột sắp xếp, hoặc cần `policyData` ngay trong thẻ.

### ⚠️ Khác biệt tên field giữa hai endpoint

Hai endpoint **cố ý** dùng hai bộ tên khác nhau, mỗi endpoint nhất quán trong phạm vi của nó — **không trộn**:

| `/policies/all` | `/policies/admin/all` |
|---|---|
| `policyId` | `policyId` |
| `policyStatus` | `status` |
| `policyCreatedAt` | `createdAt` |
| `pagination` | `meta` |

`/policies/all` theo đúng `PolicyListItem` FE chốt (tiền tố `policy*`); `/policies/admin/all` giữ contract đã bàn giao trước đó. Nếu FE muốn gộp về một bộ tên duy nhất, báo lại để tôi đổi một trong hai.

---

## 2. Phân quyền

Phạm vi dữ liệu **luôn suy ra từ access token** ([src/policy/policy-scope.ts](src/policy/policy-scope.ts)). `employeeId` trong query **chỉ là bộ lọc**, không bao giờ dùng để xác định quyền — nó được AND thêm vào điều kiện phạm vi, nên không thể dùng để xem dữ liệu ngoài phạm vi.

| Role slug | Phạm vi | Điều kiện SQL thêm vào |
|---|---|---|
| `director`, `saleadmin`, `troly_gd`, `ketoan_truong` | Toàn bộ chính sách | (không) |
| `director_la`, `salesadmin_la` | Chỉ tỉnh **7** (cùng quy ước `employee.service.ts` / `province.service.ts`) | `provinces.id = 7` |
| `sales` | Chỉ trường mình phụ trách | `schools.employee_id = <id trong token>` |
| role khác (`thuquy`, `ketoan_congno`, …) | Không có quyền | → **403** |

- User có nhiều role → lấy phạm vi **rộng nhất**.
- `ketoan_truong` là role chỉ-xem (`READ_ONLY_ROLES`); đây là endpoint đọc nên được phép, và `BlockReadOnlyGuard` vẫn chặn mọi endpoint ghi như cũ.
- Không token → **401**. Sai role → **403** (chặn ở `RolesGuard` trước khi vào service).
- Response **không** chứa cột nhạy cảm của employee (`password`, `phone`, `email`, `fcmToken`) — chỉ `id` + `name`.

---

## 3. `GET /policies/all` — tab "Tất cả chính sách"

### Query parameters

| Param | Kiểu | Mặc định | Sai giá trị thì sao |
|---|---|---|---|
| `page` | int | `1` | **Clamp** về khoảng hợp lệ |
| `limit` | int 1–100 | `12` | **Clamp** về khoảng hợp lệ |
| `status` | `PolicyStatus` | – | 400 |
| `schoolId` | int ≥ 1 | – | 400 |
| `subjectId` | int ≥ 1 | – | 400 |
| `schoolYear` | `"2026-2027"` \| `"Hè 2026-2027"` | – | 400 |
| `employeeId` | int ≥ 1 | – | 400 |
| `fromDate` | `YYYY-MM-DD` | – | 400 |
| `toDate` | `YYYY-MM-DD` | – | 400 |

Quy tắc clamp đúng công thức FE chốt (`clampPage` / `clampLimit` trong [query-policies-page.dto.ts](src/policy/dto/query-policies-page.dto.ts)):

```ts
page  = Math.trunc(Math.max(Number(page)  || 1,  1));
limit = Math.trunc(Math.min(Math.max(Number(limit) || 12, 1), 100));
totalPages = Math.ceil(total / limit);
```

| Input | Kết quả | | Input | Kết quả |
|---|---|---|---|---|
| `page=0` / `-5` / `abc` | `1` | | `limit=0` / `abc` | `12` |
| `page=2.7` | `2` | | `limit=-1` | `1` (`-1` truthy nên không rơi vào `\|\| 12`) |
| `page=99` (quá trang cuối) | `data: []`, `total` vẫn đúng | | `limit=5000` | `100` |

Tham số lạ (vd `sortBy`, `search`) **bị bỏ qua**, không trả 400 — sắp xếp cố định `policy.createdAt DESC, policy.id DESC`. `fromDate > toDate` → 400.

### Request / response mẫu (dữ liệu thật)

```http
GET /policies/all?page=1&limit=12&status=DIRECTOR_APPROVED&employeeId=17
Authorization: Bearer <token>
```

```json
{
  "data": [
    {
      "policyId": 1055,
      "policyStatus": "DRAFT",
      "policyCreatedAt": "2026-08-04T03:33:58.051Z",
      "schoolId": 529,
      "schoolName": "Trường TEST",
      "subjectId": 795,
      "subjectName": "TEST",
      "schoolYear": "Hè 2026-2027",
      "employeeId": 28,
      "employeeName": "USER TEST"
    }
  ],
  "pagination": { "page": 1, "limit": 12, "total": 518, "totalPages": 44 }
}
```

Không có dữ liệu:

```json
{ "data": [], "pagination": { "page": 1, "limit": 12, "total": 0, "totalPages": 0 } }
```

`employeeId`, `employeeName`, `schoolYear` trả `null` khi thiếu dữ liệu. `policyCreatedAt` là ISO 8601 UTC. Mở chi tiết: `/director/policy/:policyId` → `GET /policies/:id`.

---

## 4. `GET /policies/admin/all`

### Query parameters

Tất cả đều optional. Sai kiểu / ngoài whitelist → **400** kèm message tiếng Việt. Tham số lạ cũng bị từ chối (`forbidNonWhitelisted`).

| Param | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|
| `status` | `DRAFT` \| `PENDING` \| `SALE_ADMIN_APPROVED` \| `DIRECTOR_APPROVED` \| `REJECTED` | – | |
| `schoolId` | int ≥ 1 | – | |
| `subjectId` | int ≥ 1 | – | |
| `schoolYear` | string | – | `"2026-2027"` hoặc `"Hè 2026-2027"` |
| `employeeId` | int ≥ 1 | – | Nhân viên phụ trách trường (`schools.employee_id`) |
| `fromDate` | `YYYY-MM-DD` | – | Tính từ `00:00:00.000` giờ hệ thống (Asia/Ho_Chi_Minh) |
| `toDate` | `YYYY-MM-DD` | – | Tính đến `23:59:59.999` giờ hệ thống |
| `search` | string ≤ 100 | – | Không phân biệt hoa thường, có dấu tiếng Việt |
| `page` | int ≥ 1 | `1` | |
| `limit` | int 1–100 | `20` | |
| `sortBy` | `createdAt` \| `updatedAt` \| `schoolName` \| `employeeName` | `createdAt` | Whitelist, chống SQL injection |
| `sortOrder` | `asc` \| `desc` | `desc` | |

**Quy tắc lọc**

- Không truyền filter → trả tất cả chính sách trong phạm vi user.
- Các filter kết hợp bằng **AND**.
- Chỉ truyền một đầu khoảng ngày vẫn lọc bình thường; `fromDate > toDate` → **400**.
- `search` quét 4 cột: tên trường, tên môn, tên nhân viên, mã hợp đồng (`OR` trong ngoặc, AND với các filter còn lại). Ký tự `%` `_` `\` do người dùng nhập được escape.
- Sắp xếp luôn kèm tie-breaker `policy.id DESC` để phân trang không lặp/sót bản ghi khi cột sort trùng giá trị.

### Request mẫu

```http
GET /policies/admin/all?status=DIRECTOR_APPROVED&employeeId=17&fromDate=2026-01-01&limit=5&sortBy=createdAt&sortOrder=desc
Authorization: Bearer <token>
```

### Response mẫu (dữ liệu thật, rút gọn `policyData`)

```json
{
  "data": [
    {
      "policyId": 1055,
      "status": "DRAFT",
      "createdAt": "2026-08-04T03:33:58.051Z",
      "updatedAt": "2026-08-04T03:33:58.051Z",
      "employeeId": 28,
      "employeeName": "USER TEST",
      "schoolId": 529,
      "schoolName": "Trường TEST",
      "subjectId": 795,
      "subjectName": "TEST",
      "schoolYear": "Hè 2026-2027",
      "contractNumber": "T795|2026",
      "studentCount": 30,
      "totalLessons": 30,
      "policyData": {
        "fee": 600000,
        "durationMonths": 9,
        "studentPerClass": 36,
        "companyProfit": -358666.3,
        "companyProfitPerHS": -39851.81111111111,
        "csvc": 200000,
        "thue": 20000,
        "ttcs": [],
        "httienmat": [],
        "htthietbi": []
      },
      "currentHistoryId": 1146
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 518,
    "totalPages": 26,
    "hasNextPage": true,
    "hasPreviousPage": false
  }
}
```

**Lưu ý schema** (FE không cần normalize):

- Tên trường cố định: `policyId` (không phải `id`), `status` (không phải `policyStatus`), `createdAt` (không phải `policyCreatedAt`), `employeeName` (không phải `consultantName`).
- `createdAt` / `updatedAt` là ISO 8601 UTC (`...Z`). DB lưu giờ local `+07`, driver tự chuyển khi serialize.
- `policyData` là **nguyên vẹn** cột `policy.data` (trung bình ~750 byte/bản ghi), gồm sẵn `fee`, `durationMonths`, `studentPerClass`, `companyProfit`, `companyProfitPerHS` như FE cần.
- Trường thiếu dữ liệu trả `null`, không trả `undefined`: `employeeId`, `employeeName`, `schoolYear`, `contractNumber`, `studentCount`, `totalLessons`, `policyData`, `currentHistoryId`.
- `totalPages = 0` khi `total = 0`.
- Mở chi tiết: `policyId` dùng trực tiếp cho `/director/policy/:policyId` (`GET /policies/:id` sẵn có).

### Lỗi

| HTTP | Khi nào |
|---|---|
| 400 | Query sai kiểu/định dạng, `limit > 100`, `sortBy` ngoài whitelist, ngày không có thật (`2026-02-31`), `fromDate > toDate`, tham số lạ |
| 401 | Thiếu / sai token |
| 403 | Role không có quyền xem |

---

## 5. `GET /policies/filter-options`

```json
{
  "statuses": [
    { "value": "PENDING", "label": "Chờ duyệt" },
    { "value": "SALE_ADMIN_APPROVED", "label": "Sale admin đã duyệt" },
    { "value": "DIRECTOR_APPROVED", "label": "Giám đốc đã duyệt" },
    { "value": "REJECTED", "label": "Từ chối" },
    { "value": "DRAFT", "label": "Nháp" }
  ],
  "schools": [{ "id": 529, "name": "Trường TEST" }],
  "subjects": [{ "id": 795, "name": "Kỹ năng sống" }],
  "schoolYears": ["2026-2027", "Hè 2026-2027", "2025-2026", "Hè 2025-2026", "2024-2025"],
  "employees": [{ "id": 17, "name": "Bùi Huy Hoàng" }]
}
```

- `schools` / `subjects` / `employees` / `schoolYears` chỉ gồm giá trị **có ít nhất 1 chính sách trong phạm vi user** (`GROUP BY` dưới DB). Ví dụ: `director` thấy 235 trường / 369 môn / 12 nhân viên; `sales` chỉ thấy 35 trường / 57 môn / 1 nhân viên.
- `statuses` là enum đầy đủ kèm label tiếng Việt.
- `schoolYears` sắp xếp năm mới nhất trước, cùng năm thì năm học chính trước "Hè".

---

## 6. Truy vấn & hiệu năng

- **Không N+1**: mỗi request đúng **2 query** — `COUNT` + `SELECT` một trang. Toàn bộ quan hệ lấy bằng `INNER JOIN` / `LEFT JOIN` trong cùng câu lệnh (`policy → subjects → schools → employee → wards → provinces`), tất cả đều many-to-one nên 1 policy = 1 dòng, không cần `DISTINCT`.
- `LIMIT` / `OFFSET` / `WHERE` / `ORDER BY` chạy ở database, không tải toàn bộ rồi lọc trong code.
- Đo trên dữ liệu thật (518 chính sách): `limit=20` **~25ms**, `limit=100` ~15ms, `filter-options` ~29ms. Payload 1 trang 20 bản ghi ≈ 23 KB.

### Query plan

```
Limit  (cost=2.12..33.32 rows=20) (actual time=0.241..0.245 rows=20)
  ->  Incremental Sort (Sort Key: p.created_at DESC, p.id DESC)
        ->  Nested Loop
              ->  Index Scan Backward using "IDX_policy_created_at" on policy p
              ->  Memoize -> Index Scan using PK on subjects sub
              ->  Memoize -> Index Scan using PK on schools sc
Execution Time: 0.334 ms
```

Không có seq scan; sắp xếp theo `created_at` đọc thẳng từ index.

---

## 7. Migration / Index

[src/migrations/1785400000000-add-policy-list-indexes.ts](src/migrations/1785400000000-add-policy-list-indexes.ts) — **đã áp dụng vào `sales_db`** (idempotent, `IF NOT EXISTS`):

| Đối tượng | Lý do |
|---|---|
| `policy.updated_at` (cột mới, backfill `= created_at`) | Cần cho `sortBy=updatedAt`; entity dùng `@UpdateDateColumn` |
| `IDX_policy_status` | Lọc theo trạng thái |
| `IDX_policy_created_at` | Sắp xếp mặc định + lọc khoảng ngày |
| `IDX_policy_status_created_at` | Composite cho case phổ biến nhất: lọc status + sort createdAt |
| `IDX_policy_subject_id` | Join `policy → subjects` |
| `IDX_subjects_school_id` | Join `subjects → schools` |
| `IDX_subjects_school_year` | Lọc theo năm học |
| `IDX_schools_employee_id` | Lọc/phạm vi theo nhân viên |

Runtime chạy `synchronize: true` nên các index/cột này cũng được TypeORM tạo tự động khi khởi động lại; migration dành cho môi trường tắt synchronize và để backfill `updated_at` đúng bằng `created_at` thay vì `now()`.

> Trên dữ liệu hiện tại (518 dòng) planner ưu tiên `IDX_policy_created_at` hơn composite vì bảng còn nhỏ — composite sẽ có ích khi status trở nên chọn lọc hơn ở quy mô lớn. `search` dùng `LIKE '%...%'` nên không dùng được index; ở quy mô hiện tại (235 trường / 369 môn) chi phí không đáng kể — nếu dữ liệu tăng mạnh thì cân nhắc `pg_trgm`.

---

## 8. Test

```bash
npx jest src/policy/policy-all-pagination.spec.ts   # 47 test — GET /policies/all
npx jest src/policy/policy-admin-list.spec.ts       # 69 test — GET /policies/admin/all
npx jest                                            # 158 test / 6 suite, pass
```

### `GET /policies/all` — [policy-all-pagination.spec.ts](src/policy/policy-all-pagination.spec.ts)

| Nhóm | Nội dung |
|---|---|
| Clamp page/limit | 11 case: `page` 0/âm/`abc`/thập phân/hợp lệ, `limit` 0/âm/`abc`/5000/100/24; mặc định 1 & 12 |
| Validate | Tham số lạ bị bỏ qua (không 400); 8 case trả 400 (ID không phải số / = 0 / âm / thập phân, status ngoài enum, ngày sai định dạng, `2026-02-31`, năm học sai) |
| Phân trang | Lọc trước rồi mới `OFFSET`, `page=4&limit=12` → offset 36, `page=1&limit=12` trả 12 bản ghi, trang cuối trả 4 bản ghi còn lại |
| Sắp xếp | Cố định `createdAt DESC` + `id DESC` |
| Chống trùng | Join many-to-one, không `DISTINCT`, ID không lặp |
| N+1 | Đúng 1 query builder, 1 `COUNT`, 1 `SELECT` |
| Bộ lọc | 5 filter đơn lẻ; 7 filter kết hợp AND vẫn đúng `total`/`totalPages` |
| Khoảng ngày | `00:00:00.000` → `23:59:59.999`, một đầu khoảng, `from > to` → 400 |
| Phân quyền | scope all / province / own; `employeeId` từ FE không mở rộng phạm vi |
| Response | Đúng `policyId`/`policyStatus`/`policyCreatedAt`, không lộ cột nhạy cảm, `null` khi thiếu dữ liệu, rỗng vẫn trả pagination hợp lệ |

### E2E `GET /policies/all` (instance test port 3021, DB `sales_db`, 518 chính sách)

| Acceptance criteria | Kết quả |
|---|---|
| `page=1&limit=12` trả tối đa 12 bản ghi | 12 bản ghi, `totalPages: 44` |
| Trang cuối trả đúng số còn lại | `page=44` → **2** bản ghi (518 = 43×12 + 2) |
| Kết hợp nhiều filter đúng `total`/`totalPages` | 5 tổ hợp đều khớp `ceil(total/12)` |
| Đổi filter không lọt bản ghi ngoài điều kiện | `status=PENDING` → chỉ `PENDING`; `employeeId=17` → chỉ id 17 |
| Một chính sách chỉ xuất hiện một lần | Duyệt cả 44 trang: **518 dòng / 518 id duy nhất**, khớp `COUNT(*)` trong DB |
| Thứ tự ổn định khi chuyển trang | Toàn bộ 518 id giảm dần liên tục qua các trang |
| Không có dữ liệu | `{"data":[],"pagination":{"page":1,"limit":12,"total":0,"totalPages":0}}` |
| Clamp | `page=0/-5/abc`→1, `page=2.7`→2, `limit=0/abc`→12, `limit=-1`→1, `limit=5000`→100 |
| Phân quyền | không token 401, `thuquy` 403, `sales` 87, `sales` + `employeeId=28` → **0**, `director_la` 2 |
| Query sai | 6 case đều 400 kèm message tiếng Việt |

### `GET /policies/admin/all` — [policy-admin-list.spec.ts](src/policy/policy-admin-list.spec.ts)

| Nhóm | Nội dung |
|---|---|
| Validate query | Mặc định page/limit/sort, ép kiểu số, trim `search`, `sortOrder` viết hoa, 13 case trả 400 (status lạ, ngày sai định dạng, `2026-02-31`, `2026-13-01`, limit 0/101, page 0, sortBy/sortOrder ngoài whitelist, SQL injection qua `sortBy`, tham số lạ) |
| Phân quyền | 4 role toàn quyền, 2 role theo tỉnh, `sales` theo trường mình, ưu tiên phạm vi rộng nhất, role không quyền → 403, thiếu user → 401 |
| Không filter | Chỉ join, không thêm điều kiện nào |
| Từng filter | `status`, `schoolId`, `subjectId`, `schoolYear`, `employeeId`, `fromDate`, `toDate`, `search` (4 cột + escape `%_`) |
| Kết hợp filter | 7 filter cùng lúc, đều AND |
| Khoảng ngày | Chỉ from, chỉ to, from = to (00:00:00.000 → 23:59:59.999), from > to → 400 |
| Phân trang | Mặc định 20/offset 0, page 3 limit 50 → offset 100, chặn limit > 100, meta trang giữa / trang cuối, đếm total trước khi gắn LIMIT |
| Sắp xếp | 4 cột whitelist, mặc định `createdAt DESC`, tie-breaker `p.id DESC` |
| Schema response | Đúng tên trường chuẩn, không lộ cột nhạy cảm, `null` thay vì `undefined` |
| Không kết quả | `data: []`, `total: 0`, `totalPages: 0` |
| N+1 | Đúng 2 query mỗi request |
| filter-options | Đủ 5 nhóm, sắp xếp năm học, áp scope tỉnh/own cho cả 4 nhóm query, gom nhóm bằng `GROUP BY` |

### E2E `GET /policies/admin/all` (instance test port 3021, DB `sales_db`)

| Case | Kết quả |
|---|---|
| Không token / role `thuquy` | 401 / 403 |
| `director` không filter | 518 bản ghi, meta `totalPages: 26` |
| `sales` (id 17) | 87 bản ghi, chỉ `employeeId: 17` |
| `director_la` | 2 bản ghi (tỉnh 7) |
| `sales` truyền `employeeId=28` | `total: 0` — không leo được phạm vi |
| Từng filter | status 350, schoolId 5, `Hè 2026-2027` 56, employeeId 87, khoảng ngày 41, search "trường test" 5 |
| Phân trang | page 1 và page 2 không trùng id; trang cuối 18 bản ghi, `hasNextPage: false` |
| Sắp xếp | 4 cột × asc/desc đúng thứ tự |
| 13 query sai | Đều 400 kèm message tiếng Việt |
| Route cũ | `GET /policies/:id`, `GET /policies/stats` vẫn 200 |

---

## 9. FE gọi

Tab "Tất cả chính sách" — dùng `/policies/all`:

```ts
policiesApi.getAll({
  page, limit,                 // mặc định 1 / 12
  status, schoolId, subjectId, schoolYear, employeeId, fromDate, toDate,
});
// -> GET /policies/all?...
// -> { data: PolicyListItem[], pagination: { page, limit, total, totalPages } }
```

`sortBy` / `sortOrder` gửi kèm sẽ bị bỏ qua (endpoint này cố định `createdAt DESC, id DESC`) — không gây 400. Khi cần đổi cột sắp xếp hoặc có ô tìm kiếm thì chuyển sang `/policies/admin/all`.

OpenAPI 3.1: [openapi/policies-admin-list.yaml](openapi/policies-admin-list.yaml) — 3 path, import được vào Swagger UI / Postman / orval.
