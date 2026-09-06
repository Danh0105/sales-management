# PROMPT: CẬP NHẬT FRONTEND — MÔN HỌC CHỌN TỪ DANH MỤC

Bạn là Senior Frontend Developer. Backend đã đổi cách nhập **môn học**: nhân viên kinh doanh **không còn gõ tay tên môn**, mà **chọn từ danh mục môn học** do **sales admin** tạo. Hãy cập nhật UI theo tài liệu này.

## 0. Bối cảnh (đọc kỹ)

Hệ thống có **2 khái niệm khác nhau**, đừng nhầm:

| | **Danh mục môn học** (mới) | **Môn học của trường** (cũ, giữ nguyên) |
|---|---|---|
| Endpoint | `/subject-catalogs` | `/subjects` |
| Là gì | Danh sách option dùng chung: STEM, Kỹ năng sống, Công dân số... | Môn học gắn với 1 trường + hợp đồng, số HS, số tiết, năm học |
| Ai tạo | **Sales admin** (`saleadmin`, `salesadmin_la`) | Nhân viên kinh doanh |

- Khi NVKD tạo môn học cho trường → **chọn 1 môn trong danh mục** (gửi `catalogId`), backend tự lấy tên môn theo danh mục.
- **Dữ liệu cũ được giữ nguyên**: toàn bộ môn học đã tạo trước đây vẫn còn, và tên môn cũ đã được nạp sẵn vào danh mục (các biến thể chỉ khác hoa/thường như `STEM`/`Stem`/`stem` đã gom về 1 dòng).
- Sales admin có thể **tắt** (`isActive = false`) các môn nhập sai/thử nghiệm — môn học cũ đang dùng môn đó **không bị mất**, chỉ là không chọn mới được nữa.

## 1. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**.
- **Auth**: JWT Bearer. Endpoint đọc danh mục không bắt buộc token, endpoint ghi (`POST/PUT/PATCH/DELETE /subject-catalogs`) **bắt buộc** Bearer token của tài khoản `saleadmin` / `salesadmin_la`.

---

## 2. API danh mục môn học

### 2.1 Lấy danh sách môn để chọn

**GET** `/subject-catalogs`

Query params:

| Param | Kiểu | Mô tả |
|---|---|---|
| `includeInactive` | `true`/`1` | Trả cả môn đã ngừng dùng. **Chỉ dùng cho màn quản lý của sales admin.** Dropdown của NVKD **không** truyền param này. |
| `search` | string | Lọc theo tên hoặc mã môn (không phân biệt hoa/thường) |

Response:

```json
[
  {
    "id": 14,
    "name": "STEM",
    "code": null,
    "description": null,
    "isActive": true,
    "sortOrder": 0,
    "usageCount": 119,
    "createdAt": "2026-08-06T01:41:48.056Z",
    "updatedAt": "2026-08-06T01:41:48.056Z"
  }
]
```

- `usageCount` = số môn học của trường đang dùng môn này (hiển thị ở màn quản lý để sales admin biết môn nào đang được dùng).
- Danh sách đã sắp xếp sẵn theo `sortOrder` rồi tới `name` — FE **giữ nguyên thứ tự trả về**.

### 2.2 Xem chi tiết

**GET** `/subject-catalogs/:id` → 1 object như trên. Không tìm thấy → `404`.

### 2.3 Tạo môn (sales admin)

**POST** `/subject-catalogs` (JWT, role `saleadmin` / `salesadmin_la`)

```json
{
  "name": "Robotics nâng cao",   // bắt buộc
  "code": "ROBO-ADV",            // optional
  "description": "Ghi chú",      // optional
  "isActive": true,              // optional, mặc định true
  "sortOrder": 0                 // optional, số nhỏ hiện trước
}
```

- Backend tự bỏ khoảng trắng thừa trong `name`.
- Trùng tên (không phân biệt hoa/thường) → `409` `Môn học "X" đã có trong danh mục`.
- Trùng `code` → `409` `Mã môn "X" đã được dùng cho môn "Y"`.
- Không có token → `401`. Token không phải sales admin → `403`.

### 2.4 Sửa môn (sales admin)

**PUT** `/subject-catalogs/:id` hoặc **PATCH** `/subject-catalogs/:id` — body giống 2.3, mọi field đều optional.

- Dùng `{"isActive": false}` để **ngừng sử dụng** một môn (nút "Tắt"/"Ngừng dùng").
- Đổi `name` sẽ đổi tên môn trong danh mục; **tên môn học đã tạo cho trường trước đó không bị đổi theo**.

### 2.5 Xoá môn (sales admin)

**DELETE** `/subject-catalogs/:id` → `{ "deleted": true, "id": 26 }`

- Nếu môn **đang được trường sử dụng** → `409`:
  `Môn "STEM" đang được 119 môn học của trường sử dụng. Hãy tắt "đang sử dụng" thay vì xoá.`
  → FE hiển thị message này và gợi ý nút **Tắt** thay vì xoá.

---

## 3. Thay đổi ở API môn học của trường (`/subjects`)

### 3.1 Tạo môn học — **BẮT BUỘC ĐỔI**

**POST** `/subjects`

```json
{
  "catalogId": 14,            // MỚI — bắt buộc, id môn lấy từ GET /subject-catalogs
  "schoolId": 529,
  "schoolYear": "2025-2026",
  "studentCount": 30,
  "classCount": 2,
  "totalLessons": 35,
  "contractDuration": 1,
  "appendixDuration": 0,
  "startDate": "2025-09-05"
}
```

- **Bỏ ô input nhập tên môn**, thay bằng **select/autocomplete** lấy từ `GET /subject-catalogs`.
- **Không gửi `name` nữa.** Tên môn trong response lấy theo danh mục (VD chọn môn `STEM` → `name = "STEM"`).
- Nếu FE cũ vẫn gửi `name`: backend chỉ chấp nhận khi tên **khớp một môn có trong danh mục**, còn lại trả `400`. Đây chỉ là đường lùi tạm thời — hãy chuyển sang `catalogId`.

Lỗi cần hiển thị nguyên message:

| HTTP | Message | Khi nào |
|---|---|---|
| `400` | `Vui lòng chọn môn học từ danh mục` | Không gửi `catalogId` lẫn `name` |
| `400` | `Môn học không tồn tại trong danh mục. Vui lòng chọn lại.` | `catalogId` sai |
| `400` | `Môn "X" đã ngừng sử dụng. Vui lòng chọn môn khác.` | Chọn môn đã tắt |
| `400` | `Môn "X" chưa có trong danh mục môn học. Vui lòng chọn môn có sẵn hoặc liên hệ sales admin để thêm môn mới.` | Gửi `name` tự do |

### 3.2 Sửa môn học

**PUT** `/subjects/:id`

- Muốn **đổi môn** → gửi `catalogId` mới (áp dụng cùng các lỗi ở 3.1).
- **Không gửi** `catalogId`/`name` → môn giữ nguyên (kể cả môn cũ chưa map vào danh mục). Các form sửa số HS/số tiết/hợp đồng **không cần** gửi field môn.

### 3.3 Đọc môn học — có thêm field

`GET /subjects`, `GET /subjects/:id`, `GET /subjects?schoolId=...`, `GET /subjects/school/:schoolYear?schoolId=...`, `GET /subjects/finance/:schoolId` đều trả thêm:

```json
{
  "id": 797,
  "name": "Kỹ năng sống",
  "catalogId": 6,
  "catalog": { "id": 6, "name": "Kỹ năng sống", "code": null, "isActive": true, "...": "..." }
}
```

- `catalog` có thể `null` với dữ liệu cũ chưa map được → FE fallback hiển thị `name`.
- Khi mở form sửa, **set giá trị select theo `catalogId`** (không so khớp theo `name`).

### 3.4 Lọc trường theo môn

**GET** `/subjects/by-subject?schoolYear=2025-2026&catalogId=14`

- `catalogId` (mới) — lọc chính xác theo môn trong danh mục. **Ưu tiên dùng cái này** cho bộ lọc dạng select.
- `name` (cũ) — vẫn còn, lọc gần đúng theo tên.

---

## 4. Việc cần làm ở UI

### 4.1 Màn "Danh mục môn học" (mới — chỉ sales admin)

- Vào bằng menu quản trị, chỉ hiện với role `saleadmin` / `salesadmin_la`.
- Bảng: Tên môn · Mã · Mô tả · Trạng thái (Đang dùng / Ngừng dùng) · `usageCount` (Số trường đang dùng) · Thao tác.
- Load bằng `GET /subject-catalogs?includeInactive=true`, ô tìm kiếm bind vào `search`.
- Nút **Thêm môn**, **Sửa**, **Ngừng dùng / Bật lại** (`PATCH { isActive }`), **Xoá** (chỉ nên hiện khi `usageCount = 0`; nếu vẫn bấm và nhận `409` thì hiện message của backend).

### 4.2 Form tạo/sửa môn học của trường (NVKD)

- Thay ô text tên môn bằng **select tìm kiếm được**, data từ `GET /subject-catalogs` (chỉ môn đang dùng).
- Gửi `catalogId`, **không gửi `name`**.
- Khi sửa: preselect theo `catalogId`. Nếu môn học cũ có `catalogId = null` hoặc môn đã bị tắt → hiển thị tên cũ dạng chỉ đọc kèm nhắc "Môn này không còn trong danh mục, hãy chọn lại môn mới" và **bắt chọn lại khi user muốn đổi**.
- Nếu danh mục rỗng → hiện trạng thái trống: "Chưa có môn học nào trong danh mục. Liên hệ sales admin để thêm."

### 4.3 Bộ lọc/report có chọn môn

- Mọi chỗ đang cho gõ tên môn để lọc → đổi thành select lấy từ `/subject-catalogs`, gửi `catalogId`.

---

## 5. Checklist nghiệm thu

- [ ] NVKD **không còn** gõ tay được tên môn ở bất kỳ form nào.
- [ ] Sales admin thêm 1 môn mới → NVKD thấy ngay trong dropdown (chỉ cần reload danh sách).
- [ ] Sales admin tắt 1 môn → môn đó biến mất khỏi dropdown của NVKD, nhưng môn học cũ dùng môn đó vẫn hiển thị bình thường.
- [ ] Sửa số HS của môn học cũ (không đổi môn) → lưu được, tên môn không đổi.
- [ ] Xoá môn đang được dùng → hiện message `409` và gợi ý tắt thay vì xoá.
- [ ] Tài khoản không phải sales admin không thấy màn danh mục và nhận `403` nếu gọi API ghi.
