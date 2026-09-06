# Frontend Update Guide - School Expense Module (Backend deployed 2026-06-24)

## Overview

Backend has been updated with:
1. Role-based access control (`accountant` only)
2. Edit history tracking
3. New `content` field on revenue items
4. Decimal support for all numeric fields
5. CSVC formula fix

Frontend needs to update accordingly.

---

## 1. Authentication - Role `accountant`

All school expense APIs now require JWT authentication with `role = "accountant"` hoặc `role = "director"`.

### Affected endpoints

| Method | Endpoint |
|--------|----------|
| ALL | `/school-expenses/**` |
| ALL | `/revenue-items/**` |
| ALL | `/school-expense-items/**` |
| ALL | `/management-expense-items/**` |

### What FE needs to do

- Ensure all requests to these endpoints include `Authorization: Bearer <token>` header
- If the logged-in user's role is NOT `accountant` or `director`, the API will return `403 Forbidden`
- FE should hide/disable the school expense feature for users without these roles
- Handle `401 Unauthorized` (no token / expired) and `403 Forbidden` (wrong role) responses gracefully

---

## 2. New field: `content` (Noi dung)

### API changes

**Request** - `POST /school-expenses/:id/save-all`:

`revenueItems[]` now accepts `content`:

```json
{
  "rowIndex": 0,
  "subjectId": 1,
  "content": "Mo ta noi dung",   // <-- NEW: string, max 500 chars, optional
  "totalPeriods": 10,
  "studentCount": 25,
  "monthsCount": 3,
  "unitPrice": 500000,
  ...
}
```

**Response** - `GET /revenue-items`, `GET /school-expenses/:id/items`:

Each revenue item now returns `content`:

```json
{
  "id": 1,
  "content": "Mo ta noi dung",   // <-- NEW field in response
  "totalPeriods": 10,
  ...
}
```

### What FE needs to do

- Add `content` field to the revenue item data model/interface
- Include `content` in `revenueItems[]` when calling `save-all`
- The `content` field is shared/synced across all 3 tables on FE, but only stored in `revenue_items` on BE
- Display `content` in GET responses
- Max length: 500 characters

---

## 3. Decimal support

All quantity/monetary fields now support decimal values on the backend.

### Affected fields

| Table | Fields |
|-------|--------|
| `revenue_items` | `totalPeriods`, `studentCount`, `monthsCount`, `unitPrice`, `paidAmount` |
| `school_expense_items` | `totalPeriods`, `studentCount`, `monthsCount`, `teacherUnitPrice`, `taxUnitPrice`, `csvcUnitPrice`, `paidAmount` |
| `management_expense_items` | `totalPeriods`, `studentCount`, `monthsCount`, `ql1UnitPrice`, `ql2UnitPrice`, `paidAmount` |

### What FE needs to do

- All these fields are stored as `decimal(15,2)` on BE — supports 2 decimal places
- Ensure input fields allow decimal input (e.g. `monthsCount = 1.5`, `studentCount = 25.5`)
- `monthsCount` minimum is now `0` (was `1`) — BE validation changed
- Send values as `number` type in JSON (not string)

---

## 4. CSVC formula change (BE aligned)

### Old formula

```
csvcAmount = csvcUnitPrice * studentCount
```

### New formula

```
csvcAmount = csvcUnitPrice * monthsCount * studentCount
```

### What FE needs to do

- If FE is computing this formula client-side, update it to include `monthsCount`
- BE now computes with the new formula, so FE and BE will be consistent
- The `csvcUnitPrice` field name: FE can send either `csvc` or `csvcUnitPrice` — BE accepts both

---

## 5. Field name mapping (BE accepts both)

The backend accepts both Vietnamese and English field names. FE can use either:

| FE field name | BE field name | Notes |
|---------------|---------------|-------|
| `teacherUnitPrice` | `giaovien` | BE accepts both |
| `taxUnitPrice` | `thue` | BE accepts both |
| `csvcUnitPrice` | `csvc` | BE accepts both (NEW) |

---

## 6. Error responses to handle

### 401 Unauthorized

```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

No token or expired token. Redirect to login.

### 403 Forbidden

```json
{
  "statusCode": 403,
  "message": "Forbidden resource"
}
```

User role is not `accountant` or `director`. Show appropriate message or hide the feature.

---

## 7. No FE changes needed for history

Edit history is tracked automatically on the backend. Every create/update/delete/save-all operation logs:
- Who made the change (`updatedById`, `updatedByName` from JWT)
- What changed (`oldData`, `newData` as JSON)
- When (`createdAt` timestamp)
- What type of operation (`action`: CREATE, UPDATE, DELETE, SAVE_ALL)

FE does NOT need to send any extra data for history tracking. It's fully automatic based on the JWT token.

If you want to display edit history in the future, a GET endpoint can be added later.

---

## Summary checklist

- [ ] Add `Authorization: Bearer <token>` header to all school expense API calls
- [ ] Handle 401/403 responses — hide feature for users without `accountant` or `director` role
- [ ] Add `content` field to revenue item model and include in save-all payload
- [ ] Display `content` from GET responses
- [ ] Allow decimal input for all numeric fields
- [ ] Update CSVC formula: `csvcUnitPrice * monthsCount * studentCount`
- [ ] No changes needed for history tracking (automatic on BE)

---

# Frontend Update Guide - Director Edit Policy (Backend deployed 2026-06-29)

## Overview

Backend đã bổ sung tính năng cho phép **Giám đốc chỉnh sửa trực tiếp data chính sách**. Khi giám đốc chỉnh sửa:
- Lưu lịch sử thay đổi (oldData, newData, diff)
- Trả về toàn bộ lịch sử để FE hiển thị diff
- Tự động thông báo đến employee (FCM push + DB notification + WebSocket realtime)

---

## 1. API mới: Giám đốc chỉnh sửa chính sách

### `PATCH /policies/:policyId/director-update`

**Headers bắt buộc:**
```
Authorization: Bearer <director_token>
```

**Roles được phép:** `director`, `director_la`

### Request body

```json
{
  "employeeId": 5,
  "data": {
    "giaTriHopDong": 50000000,
    "soTietThucDay": 120,
    "donGia": 416667,
    "ghiChu": "Đã điều chỉnh đơn giá"
  },
  "note": "Điều chỉnh đơn giá theo quy định mới",
  "durationMonths": 12
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `employeeId` | `number` | **Yes** | ID của employee sở hữu chính sách (người sẽ nhận thông báo) |
| `data` | `object` | **Yes** | Data chính sách mới (toàn bộ object, không phải chỉ phần thay đổi) |
| `note` | `string` | No | Ghi chú lý do chỉnh sửa |
| `durationMonths` | `number` | No | Số tháng áp dụng (min: 1) |

### Response — `200 OK`

```json
{
  "policy": {
    "id": 1,
    "subjectId": 10,
    "data": { "giaTriHopDong": 50000000, "soTietThucDay": 120, "donGia": 416667, "ghiChu": "Đã điều chỉnh đơn giá" },
    "status": "DIRECTOR_APPROVED",
    "note": null,
    "currentHistoryId": 25,
    "durationMonths": 12,
    "createdAt": "2026-06-20T10:00:00.000Z"
  },
  "histories": [
    {
      "id": 25,
      "policyId": 1,
      "action": "DIRECTOR_UPDATE",
      "updatedBy": "Nguyễn Văn A",
      "oldData": { "giaTriHopDong": 45000000, "soTietThucDay": 100, "donGia": 450000 },
      "newData": { "giaTriHopDong": 50000000, "soTietThucDay": 120, "donGia": 416667, "ghiChu": "Đã điều chỉnh đơn giá" },
      "diff": {
        "giaTriHopDong": { "old": 45000000, "new": 50000000 },
        "soTietThucDay": { "old": 100, "new": 120 },
        "donGia": { "old": 450000, "new": 416667 },
        "ghiChu": { "old": null, "new": "Đã điều chỉnh đơn giá" }
      },
      "note": "Điều chỉnh đơn giá theo quy định mới",
      "status": "DIRECTOR_APPROVED",
      "createdAt": "2026-06-29T14:30:00.000Z"
    },
    {
      "id": 20,
      "policyId": 1,
      "action": "CREATE",
      "updatedBy": "Trần Thị B",
      "oldData": null,
      "newData": { "giaTriHopDong": 45000000, "soTietThucDay": 100, "donGia": 450000 },
      "diff": null,
      "note": null,
      "status": "PENDING",
      "createdAt": "2026-06-20T10:00:00.000Z"
    }
  ]
}
```

### Error responses

| Status | Khi nào |
|--------|---------|
| `401 Unauthorized` | Không có token hoặc token hết hạn |
| `403 Forbidden` | Role không phải `director` / `director_la` |
| `404 Not Found` | `policyId` không tồn tại, hoặc `employeeId` không tồn tại |

---

## 2. Cách hiển thị Diff trên FE

Response trả về mảng `histories` (mới nhất trước). Mỗi history có field `diff` chứa các field đã thay đổi:

```typescript
// Cấu trúc diff
interface DiffValue {
  old: any;  // giá trị cũ
  new: any;  // giá trị mới
}

interface PolicyDiff {
  [fieldName: string]: DiffValue | PolicyDiff; // có thể nested
}
```

**Ví dụ hiển thị diff:**
- Duyệt qua các key trong `diff`
- Với mỗi key, hiển thị `old` (đỏ/gạch ngang) và `new` (xanh/highlight)
- Nếu value là object (không có `old`/`new`), đó là nested diff — đệ quy vào trong
- Nếu `diff` là `null` hoặc `{}` → không có thay đổi

**Lọc history theo action:**
- `DIRECTOR_UPDATE` — giám đốc chỉnh sửa
- `CREATE` — tạo mới
- `UPDATE` — employee cập nhật
- `ADMIN_UPDATE` — admin duyệt/từ chối
- `AUTO_APPROVED` — tự động duyệt
- `SAVE_DRAFT` — lưu nháp

---

## 3. API xem lịch sử (đã có sẵn)

Ngoài response từ director-update, FE có thể gọi riêng để xem lịch sử:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/policies/history/policy/:policyId` | Lấy toàn bộ lịch sử của 1 policy |
| `GET` | `/policies/history?subjectId=X` | Lấy lịch sử theo subject |

---

## 4. Thông báo realtime cho Employee

Khi giám đốc chỉnh sửa, employee sẽ nhận thông báo qua 3 kênh:

### 4.1 FCM Push Notification
- Title: `"📄 Chính sách đã được chỉnh sửa"`
- Body: `"${directorName} đã chỉnh sửa chính sách môn ${subjectName} năm học ${schoolYear}"`
- Data: `{ type: "policy", id: policyId, subjectId, url: "/employee/policy/{policyId}" }`

### 4.2 WebSocket Event
- Event name: `notification:new`
- Payload:
```json
{
  "id": 100,
  "type": "POLICY",
  "entityId": 1,
  "message": "Nguyễn Văn A đã chỉnh sửa chính sách môn Toán năm học 2026-2027",
  "isRead": false,
  "createdAt": "2026-06-29T14:30:00.000Z",
  "subjectId": 10,
  "createdBy": 2,
  "meta": {
    "regionName": "Hà Nội",
    "schoolName": "THCS Nguyễn Du",
    "subjectName": "Toán",
    "schoolYear": "2026-2027"
  }
}
```

### 4.3 DB Notification
- Lưu trong bảng `notification`, FE lấy qua các API notification hiện có
- Type: `POLICY`

---

## 5. Gợi ý UI cho FE

### Màn hình Giám đốc
- Thêm nút "Chỉnh sửa chính sách" trên trang chi tiết policy
- Khi click → mở form edit với data hiện tại (pre-filled)
- Khi submit → gọi `PATCH /policies/:id/director-update`
- Sau khi thành công → hiển thị danh sách lịch sử từ response, highlight diff

### Màn hình Employee
- Khi nhận notification (WebSocket/FCM) với action `DIRECTOR_UPDATE` → hiển thị badge/toast
- Click vào notification → navigate đến trang chi tiết policy
- Hiển thị lịch sử thay đổi với diff (dùng `GET /policies/history/policy/:policyId`)

---

## Summary checklist

- [ ] Tạo form chỉnh sửa chính sách cho giám đốc (pre-fill data hiện tại)
- [ ] Gọi `PATCH /policies/:policyId/director-update` với `{ employeeId, data, note?, durationMonths? }`
- [ ] Gửi `Authorization: Bearer <token>` header (JWT của giám đốc)
- [ ] Hiển thị diff từ response `histories[].diff` (old vs new)
- [ ] Lọc/hiển thị history theo `action` type
- [ ] Xử lý WebSocket event `notification:new` phía employee để hiển thị thông báo realtime
- [ ] Handle error responses: 401, 403, 404

---

# Frontend Update Guide - Annual Policy (Chính sách năm) (Backend deployed 2026-06-30)

## Overview

Backend bổ sung module **mới hoàn toàn**, độc lập với module Policy hiện có: **"Chính sách năm"** (Annual Policy), cho phép Sales tạo yêu cầu chính sách năm cho một trường, Director duyệt/từ chối, có thông báo 2 chiều.

**Luồng nghiệp vụ:**
1. Sales tìm và chọn trường thuộc nhân viên (dùng API search trường có sẵn)
2. Chọn năm học, nhập số tiền và nội dung
3. Gửi yêu cầu → trạng thái `PENDING` → Director nhận thông báo
4. Director duyệt (`APPROVED`) hoặc từ chối (`REJECTED`), có thể kèm ghi chú
5. Sales (người tạo) nhận thông báo kết quả

---

## 1. Tìm kiếm / chọn trường

**Không có API mới** — tái sử dụng các API trường đã có sẵn:

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| `GET` | `/schools/by-employee/:employeeId` | Lấy danh sách trường thuộc 1 nhân viên |
| `GET` | `/schools/search/:keyword` | Tìm trường theo tên/SĐT/địa chỉ/mã số thuế/người đại diện |

FE dùng 1 trong 2 API này để hiển thị dropdown/autocomplete chọn trường. Năm học (`schoolYear`) là input tự do dạng string, ví dụ: `"2026-2027"` (không có danh sách cố định ở BE).

---

## 2. Tạo yêu cầu chính sách năm (Sales)

### `POST /annual-policies`

**Headers:**
```
Authorization: Bearer <token>
```

**Roles:** bất kỳ employee đã đăng nhập (không giới hạn role cụ thể — người tạo lấy từ JWT, không lấy từ body).

### Request body

```json
{
  "schoolId": 12,
  "schoolYear": "2026-2027",
  "amount": 5000000,
  "content": "Hỗ trợ chính sách năm học mới cho trường"
}
```

| Field | Type | Required | Note |
|-------|------|----------|------|
| `schoolId` | `number` | **Yes** | ID trường đã chọn ở bước trên |
| `schoolYear` | `string` | **Yes** | Ví dụ `"2026-2027"` |
| `amount` | `number` | **Yes** | Số tiền, ≥ 0 |
| `content` | `string` | **Yes** | Nội dung chính sách |

### Response — `201 Created`

```json
{
  "id": 1,
  "schoolId": 12,
  "schoolYear": "2026-2027",
  "amount": "5000000.00",
  "content": "Hỗ trợ chính sách năm học mới cho trường",
  "status": "PENDING",
  "note": null,
  "createdById": 8,
  "createdByName": "Nguyễn Văn A",
  "reviewedById": null,
  "reviewedByName": null,
  "createdAt": "2026-06-30T10:00:00.000Z",
  "updatedAt": "2026-06-30T10:00:00.000Z"
}
```

> Lưu ý: `amount` là kiểu `decimal` ở BE nên trả về dạng **string** (`"5000000.00"`), FE cần `Number()` khi tính toán/hiển thị.

---

## 3. Director duyệt / từ chối

### `PATCH /annual-policies/:id/review`

**Roles:** `director`, `director_la` (FE ẩn nút này với role khác)

### Request body

```json
{
  "status": "APPROVED",
  "note": "Đã kiểm tra, đồng ý hỗ trợ"
}
```

| Field | Type | Required | Note |
|-------|------|----------|------|
| `status` | `"APPROVED" \| "REJECTED"` | **Yes** | |
| `note` | `string` | No | Ghi chú của director |

### Response — `200 OK`

Trả về object `AnnualPolicy` đã cập nhật (giống cấu trúc ở mục 2, với `status`, `note`, `reviewedById`, `reviewedByName` đã điền).

### Error responses

| Status | Khi nào |
|--------|---------|
| `400 Bad Request` | Yêu cầu đã được duyệt/từ chối trước đó (chỉ review được khi `status = PENDING`) |
| `403 Forbidden` | Role không phải `director`/`director_la` |
| `404 Not Found` | `id` không tồn tại |

---

## 4. Danh sách & chi tiết

### `GET /annual-policies`

Query params (tất cả optional, có thể kết hợp):

| Param | Type | Mô tả |
|-------|------|-------|
| `employeeId` | `number` | Lọc theo người tạo (sales) |
| `schoolId` | `number` | Lọc theo trường |
| `status` | `PENDING \| APPROVED \| REJECTED` | Lọc theo trạng thái |
| `schoolYear` | `string` | Lọc theo năm học |

Ví dụ: `GET /annual-policies?status=PENDING` → màn hình Director xem danh sách chờ duyệt.
Ví dụ: `GET /annual-policies?employeeId=8` → màn hình Sales xem các yêu cầu mình đã tạo.

Response: array các `AnnualPolicy`, mỗi item có kèm field `school` (relation đầy đủ thông tin trường).

### `GET /annual-policies/:id`

Trả về chi tiết 1 chính sách năm (kèm `school`).

---

## 5. Thông báo realtime

Giống cơ chế notification của module Policy — dùng chung `NotificationType.POLICY`, 3 kênh:

### 5.1 Khi Sales tạo mới (PENDING) → thông báo đến Director
- FCM title: `"📄 Có yêu cầu duyệt chính sách năm"`
- WebSocket event: `notification:new` (qua kênh `policy-notification:new` nếu FE đang nghe theo type)
- `meta`: `{ schoolName, schoolYear, amount, regionName }`

### 5.2 Khi Director duyệt/từ chối → thông báo đến Sales (người tạo)
- FCM title: `"📄 Chính sách năm đã được duyệt"` hoặc `"📄 Chính sách năm bị từ chối"`
- `meta`: `{ schoolName, schoolYear, amount, note }`

FE xử lý tương tự các notification `POLICY` đã có — không cần thêm logic mới cho loại notification.

---

## 6. Gợi ý UI

### Màn hình Sales
- Nút "Tạo chính sách năm" → form: chọn trường (autocomplete dùng API search/by-employee) → chọn/nhập năm học → nhập số tiền + nội dung → submit `POST /annual-policies`
- Tab "Yêu cầu của tôi" → `GET /annual-policies?employeeId=<myId>`, hiển thị badge trạng thái (Chờ duyệt/Đã duyệt/Bị từ chối)

### Màn hình Director
- Tab "Chờ duyệt chính sách năm" → `GET /annual-policies?status=PENDING`
- Mỗi item có nút Duyệt/Từ chối → mở modal nhập `note` (optional) → `PATCH /annual-policies/:id/review`

---

## Summary checklist

- [ ] Form tạo chính sách năm: chọn trường (search/by-employee), nhập năm học, số tiền, nội dung
- [ ] Gọi `POST /annual-policies` với `{ schoolId, schoolYear, amount, content }` + JWT header
- [ ] Parse `amount` từ string sang number khi hiển thị/tính toán
- [ ] Màn hình Director: danh sách `status=PENDING`, nút duyệt/từ chối gọi `PATCH /annual-policies/:id/review`
- [ ] Màn hình Sales: xem danh sách yêu cầu của mình qua `employeeId` filter
- [ ] Hiển thị trạng thái: `PENDING` (chờ duyệt), `APPROVED` (đã duyệt), `REJECTED` (từ chối)
- [ ] Xử lý thông báo realtime (dùng chung cơ chế notification POLICY đã có)
- [ ] Handle lỗi: 400 (đã review rồi), 403 (sai role), 404 (không tồn tại)

---

# Frontend Update Guide - School Search Updates (Backend deployed 2026-06-30)

## Overview

Backend bổ sung 2 nhóm thay đổi cho module `schools`:

1. **API tìm trường có giới hạn theo nhân viên đăng nhập** (bảo mật — nhân viên chỉ thấy trường của chính mình)
2. **Lọc/tìm trường theo tên nhân viên quản lý** (cho màn hình admin/director)

---

## 1. API mới: Tìm trường của chính mình (bảo mật theo JWT)

### `GET /schools/my/search?keyword=...`

**Headers bắt buộc:**
```
Authorization: Bearer <token>
```

**Quan trọng:** `employeeId` được BE lấy từ JWT (`req.user.id`), **không** nhận từ query string. Nhân viên gọi API này chỉ luôn thấy trường do chính mình quản lý, không thể xem trường người khác dù cố truyền tham số.

| Query param | Type | Required | Note |
|-------------|------|----------|------|
| `keyword` | `string` | No | Bỏ trống → trả về toàn bộ trường của nhân viên đang đăng nhập |

Tìm theo: tên trường, mã số thuế, SĐT, địa chỉ, người đại diện.

**Response:** mảng `School[]` (kèm `employee`, `ward`, `subjects`).

### Khi nào dùng API này?

Dùng cho màn hình **Sales tự chọn trường của mình** — ví dụ form "Tạo chính sách năm" (xem phần Annual Policy ở trên), thay vì gọi `GET /schools/by-employee/:employeeId` (API cũ không có xác thực, FE có thể vô tình/cố ý truyền `employeeId` của người khác). 

**Khuyến nghị:** chuyển các màn hình Sales đang dùng `GET /schools/by-employee/:employeeId` (với `employeeId` lấy từ local state/profile) sang dùng `GET /schools/my/search` để tăng bảo mật — BE tự xác định danh tính qua token.

API cũ `GET /schools/search/:keyword` (không giới hạn, không cần JWT) vẫn giữ nguyên — dùng cho các màn hình admin/director cần tìm trên toàn bộ trường.

---

## 2. Lọc / tìm trường theo tên nhân viên quản lý

Dành cho màn hình quản trị (admin/director) cần tìm các trường theo người phụ trách.

### 2.1. Thêm filter vào danh sách trường có phân trang

`GET /schools?employeeName=Nguyễn&page=1&limit=10`

| Query param | Type | Note |
|-------------|------|------|
| `employeeName` | `string` | **Mới** — lọc theo tên nhân viên quản lý trường (ILIKE, không phân biệt hoa thường, khớp một phần) |
| `hasRemainingExpense` | `boolean` | Đã có sẵn, dùng kết hợp được với `employeeName` |
| `page`, `limit` | `number` | Đã có sẵn |

Response giữ nguyên cấu trúc cũ (`data`, `statistics`, `pagination`).

### 2.2. Full-text search đã bao gồm tên nhân viên

`GET /schools/search/:keyword` (API có sẵn) — **không đổi URL**, nhưng nay tìm thêm trên `employee.name`. Ví dụ: gõ `"Nguyễn Văn A"` sẽ trả về tất cả trường do nhân viên có tên khớp quản lý, ngoài việc khớp tên/SĐT/địa chỉ/MST/người đại diện trường như trước.

### 2.3. API riêng: tìm trường theo tên nhân viên

`GET /schools/by-employee-name/:name`

Ví dụ: `GET /schools/by-employee-name/Nguyễn%20Văn%20A`

**Response:** mảng `School[]` (kèm `employee`, `ward`, `subjects`) — tất cả trường có nhân viên quản lý tên khớp một phần (ILIKE), không phân trang, không giới hạn quyền (dùng cho admin/director).

---

## Summary checklist

- [ ] Chuyển màn hình Sales chọn trường sang `GET /schools/my/search?keyword=` (JWT-based, an toàn hơn `by-employee/:employeeId`)
- [ ] Thêm input "Lọc theo tên nhân viên" vào màn hình danh sách trường (admin/director) → dùng `GET /schools?employeeName=...`
- [ ] Không cần thay đổi gì nếu đang dùng `GET /schools/search/:keyword` — tự động tìm thêm theo tên nhân viên
- [ ] (Optional) Dùng `GET /schools/by-employee-name/:name` nếu cần API riêng không phân trang

---

---

# BREAKING CHANGE: `role` → `roles` (Multi-role refactor — 2026-07-01)

## Tổng quan

Backend đã thiết kế lại DB để **một nhân viên có thể có nhiều chức vụ cùng lúc**.

| Trước | Sau |
|-------|-----|
| `role: string` | `roles: string[]` |
| `"role": "director"` | `"roles": ["director", "saleadmin"]` |

**Đây là breaking change** — FE cần cập nhật toàn bộ các nơi dùng `role`.

---

## 1. JWT / Auth response thay đổi

### Login (`POST /auth/login`) — response mới:
```json
{
  "access_token": "eyJ...",
  "user": {
    "id": 5,
    "name": "Nguyễn Văn A",
    "roles": ["director", "saleadmin"]
  }
}
```

### Face login — tương tự, response có `roles: string[]` thay vì `role: string`.

### JWT payload (sau khi decode):
```json
{
  "sub": 5,
  "roles": ["director", "saleadmin"],
  "name": "Nguyễn Văn A",
  "iat": ...,
  "exp": ...
}
```

**Action:** Bất kỳ nơi nào FE lưu `user.role` vào localStorage / Redux / Context → đổi thành `user.roles` (mảng).

---

## 2. Kiểm tra quyền phía FE

### Trước:
```js
if (user.role === 'director') { ... }
if (user.role === 'saleadmin' || user.role === 'director') { ... }
```

### Sau:
```js
if (user.roles?.includes('director')) { ... }
if (['saleadmin', 'director'].some(r => user.roles?.includes(r))) { ... }
```

**Gợi ý** — viết một helper dùng chung:
```ts
// utils/auth.ts
export const hasRole = (user: { roles?: string[] }, ...roles: string[]) =>
  roles.some(r => user?.roles?.includes(r));

// Sử dụng:
if (hasRole(user, 'director')) { ... }
if (hasRole(user, 'director', 'saleadmin')) { ... }
```

**Các màn hình cần kiểm tra:**
- Ẩn/hiện nút "Duyệt", "Từ chối" → kiểm tra `roles.includes('director')`
- Ẩn/hiện tab quản lý → kiểm tra `roles.includes('saleadmin')`
- Điều hướng sau login → dựa trên `roles[0]` (role chính) hoặc logic ưu tiên
- Guard route → dùng helper `hasRole()`

---

## 3. API nhân viên thay đổi

### Tạo nhân viên (`POST /employees`)

**Trước:**
```json
{ "name": "Trần B", "role": "sales" }
```

**Sau:**
```json
{ "name": "Trần B", "roles": ["sales"] }
```

Vẫn chấp nhận `role` (string) làm fallback để tương thích, nhưng khuyến nghị dùng `roles` (array).

---

### Cập nhật roles (`PATCH /employees/:id`)

Endpoint có sẵn, dùng để gán/sửa roles:

```http
PATCH /employees/5
Authorization: Bearer <token>
Content-Type: application/json

{
  "roles": ["director", "saleadmin"]
}
```

**Response:**
```json
{
  "id": 5,
  "name": "Nguyễn Văn A",
  "roles": ["director", "saleadmin"],
  "email": "...",
  "phone": "..."
}
```

---

### Danh sách nhân viên (`GET /employees`)

Response mỗi item giờ có `roles: string[]` thay vì `role: string`:

```json
[
  {
    "id": 5,
    "name": "Nguyễn Văn A",
    "email": "...",
    "phone": "...",
    "roles": ["director", "saleadmin"]
  }
]
```

---

## 4. UI gợi ý — Màn hình quản lý nhân viên

### Hiển thị roles
Thay vì hiển thị một badge role, hiển thị nhiều badge:

```jsx
// Trước
<Badge>{employee.role}</Badge>

// Sau
{employee.roles?.map(role => (
  <Badge key={role} color={roleColor(role)}>{roleLabel(role)}</Badge>
))}
```

**Mapping tên hiển thị gợi ý:**
```ts
const roleLabel: Record<string, string> = {
  sales: 'Sales',
  saleadmin: 'Sale Admin',
  saleadmin_la: 'Sale Admin LA',
  director: 'Giám đốc',
  director_la: 'Giám đốc LA',
  ketoan_congno: 'Kế toán công nợ',
  thuquy: 'Thủ quỹ',
  employee: 'Nhân viên',
};
```

### Form gán roles (thay dropdown đơn → multi-select)

```jsx
// Trước: <Select name="role" options={roleOptions} />

// Sau: multi-select
<Select
  name="roles"
  mode="multiple"   // nếu dùng Ant Design
  options={roleOptions}
  defaultValue={employee.roles}
/>
```

---

## 5. Xử lý "role chính" khi cần hiển thị một role

Một số chỗ UI chỉ có thể hiển thị một role (ví dụ: avatar badge, tiêu đề). Dùng `roles[0]` làm role chính:

```ts
const primaryRole = user.roles?.[0] ?? 'employee';
```

Hoặc định nghĩa thứ tự ưu tiên:
```ts
const ROLE_PRIORITY = ['director', 'director_la', 'saleadmin', 'saleadmin_la',
                       'ketoan_congno', 'thuquy', 'sales', 'employee'];

const getPrimaryRole = (roles: string[]) =>
  ROLE_PRIORITY.find(r => roles.includes(r)) ?? roles[0] ?? 'employee';
```

---

## 6. Lưu ý quan trọng — Data migration

**Tất cả nhân viên hiện tại đang có `roles = []`** (mảng rỗng) do cột `role` cũ đã bị xoá khi deploy. Admin cần vào màn hình quản lý nhân viên và **gán lại roles** cho từng người qua `PATCH /employees/:id`.

Nếu FE chưa có màn hình gán roles, cần làm gấp để không bị mất quyền truy cập.

---

## Summary checklist

- [ ] Đổi `user.role` → `user.roles` ở tất cả nơi lưu state (localStorage, Redux, Context, Zustand…)
- [ ] Đổi `user.role === 'X'` → `user.roles?.includes('X')` ở tất cả guard/điều kiện render
- [ ] Viết helper `hasRole(user, ...roles)` dùng chung toàn app
- [ ] Màn hình tạo nhân viên: đổi input `role` (dropdown đơn) → `roles` (multi-select)
- [ ] Màn hình danh sách nhân viên: hiển thị nhiều badge thay vì một
- [ ] Màn hình chi tiết nhân viên: thêm nút/form chỉnh sửa roles
- [ ] Sau deploy: admin gán lại roles cho tất cả nhân viên qua UI hoặc `PATCH /employees/:id`
