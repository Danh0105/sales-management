# PROMPT: XÂY DỰNG GIAO DIỆN MODULE GIẢNG DẠY — NHÂN SỰ & GIÁO VIÊN (FRONTEND)

Bạn là Senior Frontend Developer của dự án này. Hệ thống vừa có **2 role mới** và **1 module mới**: phòng Nhân sự quản lý **lịch dạy** và **chấm công** giáo viên. Hãy dựng UI cho module này.

> ⚠️ **Yêu cầu quan trọng nhất: GIAO DIỆN PHẢI ĐỒNG BỘ với phần đã có.** Đây là module bổ sung vào một ứng dụng đang chạy, **không phải app mới**. Đọc kỹ mục 1 trước khi viết dòng code đầu tiên.

---

## 0. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**. Endpoint là `/teachers/...`, `/teaching-schedules/...`, `/teaching-sessions/...`.
- **Auth**: JWT Bearer. Login `POST /auth/login` body `{ "phone", "password" }` → `{ "access_token", "user" }`. Gắn `Authorization: Bearer <token>` mọi request.
- **Role nằm trong mảng `user.roles`** (không phải `user.role`).
- **Role slug mới**: `nhansu` (phòng Nhân sự), `giaovien` (giáo viên).
- **Tài khoản test** (password `123456`):

| Phone | Role | Dùng để test |
|---|---|---|
| `0900000007` | `nhansu` | Toàn bộ màn quản lý |
| `0900000008` | `giaovien` | Màn "Lịch dạy của tôi" (đã gắn hồ sơ GV id=1, có sẵn buổi dạy) |
| `0900000009` | `giaovien` | Giáo viên thứ hai |
| `0900000002` | `director` | Kiểm tra chế độ chỉ-xem |

- Role cũ để đối chiếu: `sales`, `director`, `director_la`, `saleadmin`, `ketoan_congno`, `thuquy`, `ketoan_truong`, `troly_gd`.

---

## 1. NGUYÊN TẮC ĐỒNG BỘ GIAO DIỆN (bắt buộc)

**Tuyệt đối không dựng "một app con" với phong cách riêng.** Trước khi code, hãy khảo sát codebase FE hiện tại và **tái sử dụng**, không tạo mới:

1. **Layout & điều hướng**: dùng đúng layout/sidebar/breadcrumb/page-header đang dùng ở các module Đề xuất chi, Chính sách, Quản lý thu chi. Thêm menu mới vào đúng cấu trúc menu hiện có, **không** tự tạo shell riêng.
2. **Thư viện UI**: dùng **đúng thư viện component đang có trong dự án** (AntD / MUI / Tailwind + component nội bộ — kiểm tra `package.json` và các màn hiện có rồi theo đúng cái đó). **Không cài thêm** UI library, date picker, table, chart mới.
3. **Component dùng lại**: bảng danh sách, thanh bộ lọc, phân trang, modal xác nhận, form field, upload, empty state, skeleton/loading, toast — dùng lại component sẵn có của dự án. Nếu chưa có component phù hợp thì viết mới **theo đúng style của component cùng loại đang có**.
4. **Bảng màu trạng thái**: theo đúng quy ước badge màu module Đề xuất chi (vàng = chờ, xanh dương = đã duyệt, đỏ = từ chối/vắng, xám = huỷ…). Xem bảng màu cụ thể ở mục 7.
5. **Ngôn ngữ & format**: toàn bộ nhãn tiếng Việt. Ngày hiển thị `DD/MM/YYYY`, gửi API `YYYY-MM-DD`. Giờ `HH:mm`. Số dùng `toLocaleString('vi-VN')`. Dùng đúng thư viện ngày đang có (dayjs) — **không** thêm moment/date-fns nếu dự án chưa dùng.
6. **Gọi API**: dùng đúng axios instance / interceptor sẵn có (tự gắn token, bắt 401/403). **Không** tạo client HTTP riêng.
7. **State**: theo đúng pattern đang dùng (React Query / Redux / Zustand) — không trộn thêm pattern mới.
8. **Kích thước & khoảng cách**: giữ nguyên spacing, bo góc, cỡ chữ, chiều cao input/button của các màn hiện có. Nhìn cạnh màn Đề xuất chi phải thấy **cùng một hệ thiết kế**.

> Tiêu chí nghiệm thu về mặt thị giác: mở màn mới cạnh màn Đề xuất chi, người dùng **không nhận ra đây là module viết sau**.

---

## 2. KHÁI NIỆM & MÔ HÌNH DỮ LIỆU

```
Giáo viên  ──<  Mẫu lịch (lặp theo tuần)  ──<  Buổi dạy (cụ thể + chấm công)
```

- **Giáo viên** là hồ sơ riêng, **không bắt buộc có tài khoản đăng nhập** (giáo viên thuê ngoài). Nếu là giáo viên cơ hữu thì gắn `employeeId` — tài khoản đó **phải đã có role `giaovien`**, nếu không BE trả 400.
- **Mẫu lịch** = lịch lặp hàng tuần: *"Thứ Ba, 07:30–09:00, từ 01/08/2026 đến 31/08/2026"*. Mẫu **không phải** là buổi dạy.
- **Buổi dạy** = buổi cụ thể theo ngày, được **sinh ra** từ mẫu (nút "Sinh buổi dạy"), hoặc tạo lẻ (buổi dạy bù).
- **Chấm công nằm ngay trên buổi dạy** — không có bảng chấm công riêng. Mỗi buổi có `status` chính là kết quả chấm công.

### `dayOfWeek` — quy ước tiếng Việt

| Giá trị | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|
| Nhãn | Thứ Hai | Thứ Ba | Thứ Tư | Thứ Năm | Thứ Sáu | Thứ Bảy | **Chủ Nhật** |

> ⚠️ **Không có giá trị 1.** Chủ Nhật là **8**, không phải 0. API cũng trả sẵn `dayOfWeekLabel` — ưu tiên hiển thị field này thay vì tự map.

### `status` của buổi dạy = trạng thái chấm công

| Giá trị | Nhãn (`statusLabel` từ API) | Ý nghĩa |
|---|---|---|
| `SCHEDULED` | Chưa chấm | Đã lên lịch, Nhân sự chưa chốt |
| `PRESENT` | Có dạy | |
| `ABSENT` | Vắng | Vắng không phép |
| `EXCUSED` | Nghỉ có phép | |
| `CANCELLED` | Huỷ buổi | Trường nghỉ / đổi lịch — không tính công |

**Dạy bù** không phải một status. Dạy bù là **một buổi mới** với `isMakeup: true` và `makeupForSessionId` trỏ về buổi gốc; bản thân buổi bù cũng được chấm công bình thường.

---

## 3. PHÂN QUYỀN & MENU

| Role | Thấy gì | Làm được gì |
|---|---|---|
| `nhansu` | Menu **"Giảng dạy"** với 3 mục: Giáo viên · Lịch dạy · Chấm công | **Toàn quyền** |
| `director`, `director_la`, `troly_gd`, `ketoan_truong` | Cùng 3 mục | **Chỉ xem** — ẩn toàn bộ nút tạo/sửa/xoá/chấm công/sinh buổi |
| `giaovien` | Chỉ 1 mục: **"Lịch dạy của tôi"** | Chỉ xem lịch của chính mình |
| Role còn lại (`sales`, `thuquy`, `saleadmin`…) | **Ẩn hoàn toàn** menu Giảng dạy | — |

```ts
const canManageTeaching = (u) => u?.roles?.includes('nhansu');
const canViewTeaching   = (u) => u?.roles?.some(r =>
  ['nhansu','director','director_la','troly_gd','ketoan_truong'].includes(r));
const isTeacher         = (u) => u?.roles?.includes('giaovien');
```

- User có nhiều role → lấy quyền **rộng nhất** (vừa `giaovien` vừa `nhansu` → dùng giao diện Nhân sự).
- Chặn route: gõ URL tay vào màn ngoài quyền → redirect về trang đầu tiên được phép.
- BE đã chặn cứng: role chỉ-xem gọi API ghi luôn nhận **403**. FE vẫn phải **ẩn nút từ đầu**, đừng để bấm rồi mới báo lỗi.

---

## 4. API

Tất cả đều cần Bearer token. Response lỗi dạng `{ "message": string | string[], "error": string, "statusCode": number }`.

### 4.1 Giáo viên — `/teachers`

| Method | Path | Role | Ghi chú |
|---|---|---|---|
| GET | `/teachers` | xem | Query: `search`, `isActive`, `schoolId`, `page` (1), `limit` (20, max 100) |
| GET | `/teachers/:id` | xem | |
| GET | `/teachers/me` | `giaovien` | Hồ sơ của tài khoản đang đăng nhập |
| POST | `/teachers` | `nhansu` | |
| PATCH | `/teachers/:id` | `nhansu` | |
| DELETE | `/teachers/:id` | `nhansu` | **409** nếu GV đã có buổi dạy |

**Item giáo viên** (GET list, GET chi tiết, POST, PATCH đều trả **cùng shape này**):

```json
{
  "id": 1,
  "name": "Giáo viên A (test)",
  "phone": "0900000008",
  "email": "giaovien.a@test.local",
  "employeeId": 141,
  "employeeName": "Giáo viên A (test)",
  "isActive": true,
  "note": null
}
```

`employeeId: null` = giáo viên thuê ngoài, không có tài khoản đăng nhập.

**Body tạo/sửa**: `{ name (bắt buộc, 2–150 ký tự), phone?, email?, employeeId?, isActive?, note? }`

Danh sách trả kèm `pagination`:
```json
{ "data": [ ... ], "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 } }
```

### 4.2 Mẫu lịch (lặp tuần) — `/teaching-schedules`

| Method | Path | Role | Ghi chú |
|---|---|---|---|
| GET | `/teaching-schedules` | xem | Query: `teacherId`, `schoolId`, `subjectId`, `dayOfWeek`, `isActive`, `page`, `limit` |
| GET | `/teaching-schedules/:id` | xem | |
| POST | `/teaching-schedules` | `nhansu` | **409** nếu trùng lịch giáo viên |
| PATCH | `/teaching-schedules/:id` | `nhansu` | |
| DELETE | `/teaching-schedules/:id` | `nhansu` | Xoá luôn buổi đã sinh. **409** nếu đã có buổi được chấm công |
| POST | `/teaching-schedules/:id/generate-sessions` | `nhansu` | Body `{ fromDate, toDate }` |

**Body tạo mẫu lịch**:
```json
{
  "teacherId": 1,
  "schoolId": 494,
  "subjectId": 794,
  "dayOfWeek": 3,
  "startTime": "07:30",
  "endTime": "09:00",
  "effectiveFrom": "2026-08-01",
  "effectiveTo": "2026-08-31"
}
```
`effectiveTo` bỏ trống = chưa có ngày kết thúc. `subjectId` **phải thuộc** `schoolId` (BE trả 400 nếu sai).

**Item mẫu lịch** (GET/POST/PATCH cùng shape):
```json
{
  "id": 3, "teacherId": 2, "teacherName": "Giáo viên B (test)",
  "schoolId": 494, "schoolName": "TIỂU HỌC THẮNG NHÌ",
  "subjectId": 794, "subjectName": "Stem", "schoolYear": "2026-2027",
  "dayOfWeek": 5, "dayOfWeekLabel": "Thứ Năm",
  "startTime": "13:00", "endTime": "14:30",
  "effectiveFrom": "2026-09-01", "effectiveTo": null,
  "isActive": true, "note": null
}
```

**Sinh buổi dạy** — `POST /teaching-schedules/:id/generate-sessions`:
```jsonc
// request
{ "fromDate": "2026-08-01", "toDate": "2026-08-31" }
// response
{ "created": 4, "skipped": 0, "dates": ["2026-08-04","2026-08-11","2026-08-18","2026-08-25"] }
```
- **Idempotent** — bấm lại nhiều lần không nhân đôi, buổi đã có rơi vào `skipped`.
- Chỉ sinh trong phần **giao** giữa khoảng yêu cầu và khoảng hiệu lực của mẫu.
- Tối đa **400 ngày** mỗi lần (quá → 400).

### 4.3 Buổi dạy & chấm công — `/teaching-sessions`

| Method | Path | Role | Ghi chú |
|---|---|---|---|
| GET | `/teaching-sessions` | xem | Query bên dưới |
| GET | `/teaching-sessions/:id` | xem | |
| GET | `/teaching-sessions/me` | `giaovien` | Lịch của chính mình |
| GET | `/teaching-sessions/attendance/summary` | xem | `fromDate`, `toDate` **bắt buộc**; `teacherId?`, `schoolId?` |
| POST | `/teaching-sessions` | `nhansu` | Buổi lẻ / buổi dạy bù |
| PATCH | `/teaching-sessions/:id` | `nhansu` | Đổi giờ/ngày/giáo viên dạy thay |
| DELETE | `/teaching-sessions/:id` | `nhansu` | **409** nếu đã chấm công |
| PATCH | `/teaching-sessions/:id/attendance` | `nhansu` | **Chấm công 1 buổi** |
| PATCH | `/teaching-sessions/attendance/bulk` | `nhansu` | **Chấm công hàng loạt**, tối đa 200 buổi |

**Query danh sách buổi**: `teacherId`, `schoolId`, `subjectId`, `scheduleId`, `status`, `unchecked` (true = chỉ buổi chưa chấm), `fromDate`, `toDate`, `page` (1), `limit` (50, max 200).

**Item buổi dạy**:
```json
{
  "id": 1,
  "scheduleId": 1,
  "teacherId": 1, "teacherName": "Giáo viên A (test)",
  "schoolId": 494, "schoolName": "TIỂU HỌC THẮNG NHÌ",
  "subjectId": 794, "subjectName": "Stem", "schoolYear": "2026-2027",
  "date": "2026-08-04",
  "dayOfWeek": 3, "dayOfWeekLabel": "Thứ Ba",
  "startTime": "07:30", "endTime": "09:00",
  "status": "PRESENT", "statusLabel": "Có dạy",
  "isMakeup": false, "makeupForSessionId": null,
  "attendanceNote": null,
  "checkedById": 140, "checkedByName": "Nhân sự (test)",
  "checkedAt": "2026-08-04T08:32:55.159Z",
  "note": null
}
```
`scheduleId: null` = buổi lẻ / buổi dạy bù, không sinh từ mẫu.

**Tạo buổi lẻ hoặc dạy bù**:
```json
{
  "teacherId": 1, "schoolId": 494, "subjectId": 794,
  "date": "2026-08-13", "startTime": "14:00", "endTime": "15:30",
  "makeupForSessionId": 2,
  "note": "Dạy bù buổi 11/8"
}
```
Có `makeupForSessionId` → BE tự bật `isMakeup: true`.

**Chấm công 1 buổi** — `PATCH /teaching-sessions/:id/attendance`:
```json
{ "status": "EXCUSED", "attendanceNote": "Xin phép ốm" }
```
Trả về item buổi dạy đầy đủ (đã có `checkedById`/`checkedByName`/`checkedAt`).
Đưa `status` về `SCHEDULED` = **bỏ chấm**, BE xoá luôn `checkedBy`/`checkedAt`.

**Chấm công hàng loạt** — `PATCH /teaching-sessions/attendance/bulk`:
```jsonc
// request
{ "items": [
  { "sessionId": 2, "status": "ABSENT" },
  { "sessionId": 3, "status": "EXCUSED", "attendanceNote": "Xin phép ốm" },
  { "sessionId": 4, "status": "CANCELLED", "attendanceNote": "Trường nghỉ lễ" }
] }
// response
{ "updated": 3, "sessionIds": [2, 3, 4] }
```
`sessionId` trùng nhau trong 1 request → **400**. Có id không tồn tại → **404** kèm danh sách id thiếu.

**Tổng hợp công** — `GET /teaching-sessions/attendance/summary?fromDate=2026-08-01&toDate=2026-08-31`:
```json
{
  "fromDate": "2026-08-01", "toDate": "2026-08-31",
  "data": [
    { "teacherId": 1, "teacherName": "Giáo viên A (test)",
      "totalSessions": 4, "present": 1, "absent": 1,
      "excused": 1, "cancelled": 1, "unchecked": 0, "makeup": 0 }
  ]
}
```

---

## 5. CÁC MÀN HÌNH CẦN DỰNG

### 5.1 Giáo viên (`/nhan-su/giao-vien`)

- **Bảng danh sách**: Tên · SĐT · Email · Tài khoản (`employeeName` hoặc chip "Thuê ngoài" khi `employeeId = null`) · Trạng thái (chip Đang dạy / Ngừng) · Thao tác.
- **Thanh lọc**: ô tìm kiếm (`search`, debounce ~300ms), select Trạng thái (`isActive`), select Trường (`schoolId`), nút Xoá lọc.
- **Nút "Thêm giáo viên"** → modal form: Tên (bắt buộc) · SĐT · Email · **Vị trí Google Maps** (`googleMapsUrl`) · **Các trường có thể dạy** (multi-select, gửi `schoolIds`) · **Các môn có thể dạy** (multi-select từ danh mục môn dùng chung, gửi `subjectCatalogIds`) · **Gắn tài khoản đăng nhập** (select nhân viên, ghi chú rõ *"chỉ hiện tài khoản đã có role giáo viên"*) · Ghi chú · Đang hoạt động. Khi sửa, gửi `[]` để xoá hết lựa chọn trường/môn; bỏ field để giữ nguyên.
- **Xoá**: modal xác nhận. Nếu nhận **409** → hiện đúng message BE trả về và **gợi ý chuyển sang tắt "Đang hoạt động"** thay vì xoá.
- Empty state khi chưa có giáo viên nào, kèm nút thêm.

### 5.2 Lịch dạy (`/nhan-su/lich-day`)

Đây là màn quan trọng nhất, gồm **2 tab**:

**Tab A — "Mẫu lịch tuần"**
- Bảng mẫu lịch: Giáo viên · Trường · Môn · Thứ (`dayOfWeekLabel`) · Khung giờ (`startTime–endTime`) · Hiệu lực (`effectiveFrom → effectiveTo` hoặc "Không thời hạn") · Trạng thái · Thao tác.
- Lọc theo Giáo viên / Trường / Môn / Thứ / Trạng thái.
- **Nút "Thêm mẫu lịch"** → form: Giáo viên · Trường · **Môn (select phụ thuộc Trường — đổi Trường phải load lại môn và reset môn đã chọn)** · Thứ (2–8) · Giờ bắt đầu/kết thúc (time picker, bước 5 hoặc 15 phút) · Hiệu lực từ/đến · Ghi chú.
- **Nút "Sinh buổi dạy"** trên từng dòng → modal chọn khoảng ngày (mặc định: tháng hiện tại) → gọi `generate-sessions` → toast kết quả dạng **"Đã sinh 4 buổi, bỏ qua 2 buổi đã có"**. Nếu `created = 0 && skipped = 0` thì báo *"Không có buổi nào trong khoảng đã chọn"*.

**Tab B — "Buổi dạy"** (lịch thực tế)
- **Ưu tiên xem dạng lưới tuần**: cột = Thứ 2 → Chủ Nhật, hàng = khung giờ hoặc giáo viên; mỗi ô là thẻ buổi dạy (môn · trường · giờ · badge trạng thái). Kèm nút chuyển **Tuần / Tháng / Danh sách**; dạng Danh sách dùng bảng chuẩn của dự án.
- Thanh điều hướng tuần: `< Tuần trước | 04/08 – 10/08/2026 | Tuần sau >` + nút "Hôm nay".
- Lọc: Giáo viên · Trường · Môn · Trạng thái · **Chỉ buổi chưa chấm** (toggle `unchecked`).
- Buổi có `isMakeup: true` → gắn chip **"Dạy bù"**, tooltip trỏ tới buổi gốc (`makeupForSessionId`).
- Click buổi → drawer/modal chi tiết: đầy đủ thông tin + khối chấm công + nút Sửa / Xoá / Tạo buổi bù.
- **Nút "Thêm buổi lẻ"** và, trong chi tiết một buổi `ABSENT`/`CANCELLED`, nút **"Tạo buổi dạy bù"** (mở form tạo buổi với `makeupForSessionId` điền sẵn).

### 5.3 Chấm công (`/nhan-su/cham-cong`)

- **Chọn khoảng ngày** (mặc định tuần hiện tại) + lọc Giáo viên / Trường.
- **Bảng chấm công hàng loạt**: mỗi dòng là 1 buổi — Ngày (+ `dayOfWeekLabel`) · Giờ · Giáo viên · Trường · Môn · **Cột trạng thái là nhóm nút/segmented control** (Có dạy · Vắng · Nghỉ phép · Huỷ) · ô Ghi chú.
- Cho sửa nhiều dòng rồi bấm **"Lưu chấm công"** một lần → gọi `attendance/bulk` với **chỉ những dòng đã đổi**. Hiện số dòng đang chờ lưu trên nút.
- Có nút **"Đánh dấu tất cả là Có dạy"** cho các dòng chưa chấm (thao tác phổ biến nhất).
- Chấm nhanh 1 dòng (không qua batch) thì gọi `PATCH /teaching-sessions/:id/attendance`.
- Dòng đã chấm hiện `checkedByName` + `checkedAt` (dạng "Nhân sự (test) · 04/08 15:32") và cho **bỏ chấm** (đưa về `SCHEDULED`).
- **Khối tổng hợp** phía trên hoặc tab riêng: bảng từ `attendance/summary` — Giáo viên · Tổng buổi · Có dạy · Vắng · Nghỉ phép · Huỷ · Chưa chấm · Dạy bù. Mỗi ô số nên click được để lọc xuống danh sách buổi tương ứng.

### 5.4 Lịch dạy của tôi — role `giaovien` (`/giao-vien/lich-day`)

- Chỉ đọc, gọi `GET /teaching-sessions/me`.
- Mặc định xem tuần hiện tại, có chuyển tuần/tháng.
- Mỗi buổi: ngày + thứ · giờ · trường · môn · badge trạng thái · chip "Dạy bù" nếu có.
- Ghi rõ trạng thái chấm công của mình, nhưng **không có bất kỳ nút thao tác nào**.
- Nếu API trả **404** (`"Tài khoản này chưa được gắn với hồ sơ giáo viên nào"`) → hiện empty state thân thiện: *"Tài khoản của bạn chưa được phòng Nhân sự gắn với hồ sơ giáo viên. Vui lòng liên hệ phòng Nhân sự."* — **không** hiện màn hình lỗi đỏ.

---

## 6. VALIDATE & XỬ LÝ LỖI

Validate ngay trên form (mirror BE) để người dùng không phải chờ round-trip:

| Quy tắc | Thông báo gợi ý |
|---|---|
| Giờ bắt đầu < giờ kết thúc | "Giờ bắt đầu phải nhỏ hơn giờ kết thúc" |
| `effectiveFrom` ≤ `effectiveTo`; `fromDate` ≤ `toDate` | "Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc" |
| `dayOfWeek` chỉ nhận 2–8 | Dùng select cố định, không cho nhập tay |
| Ngày phải có thật | Dùng date picker, không cho gõ tay tự do |
| Tên giáo viên 2–150 ký tự | |
| Môn phải thuộc trường đã chọn | Select môn phụ thuộc trường (xem 5.2) |

**Mã lỗi cần xử lý đúng — message tiếng Việt BE trả về đã dùng được luôn cho toast:**

| Mã | Khi nào | FE làm gì |
|---|---|---|
| **400** | Dữ liệu sai, môn không thuộc trường, GV ngừng hoạt động, tài khoản chưa có role `giaovien`, khoảng sinh buổi > 400 ngày | Hiện lỗi tại field nếu map được, nếu không thì toast. `message` có thể là **mảng string** — hiện từng dòng. |
| **401** | Token hết hạn | Theo xử lý chung sẵn có (redirect login) |
| **403** | Role không đủ quyền | Toast "Bạn chỉ có quyền xem" — và rà lại vì lẽ ra nút đó phải bị ẩn |
| **404** | Bản ghi không tồn tại / tài khoản chưa gắn hồ sơ GV | Empty state, không phải màn lỗi |
| **409** | **Trùng lịch giáo viên**, xoá bản ghi đã có dữ liệu | **Hiện nguyên message BE** — đã nêu rõ trường/giờ trùng. Ví dụ: *"Giáo viên đã có lịch Thứ Ba 07:30–09:00 tại TIỂU HỌC THẮNG NHÌ trong khoảng thời gian này"* |

Hai loại trùng lịch BE chặn (FE nên báo trước nếu phát hiện được, nhưng **không được bỏ** xử lý 409):
- Một giáo viên không có 2 **mẫu lịch** cùng thứ + giao giờ + giao khoảng hiệu lực.
- Một giáo viên không có 2 **buổi dạy** giao giờ trong cùng một ngày.
- Chạm biên **không** tính là trùng: buổi 07:30–09:00 và 09:00–10:30 hợp lệ.
- Buổi `CANCELLED` **không** chiếm chỗ — vẫn xếp buổi khác vào đúng khung giờ đó được.

---

## 7. BADGE TRẠNG THÁI (đồng bộ bảng màu Đề xuất chi)

| Status | Nhãn | Màu |
|---|---|---|
| `SCHEDULED` | Chưa chấm | Xám / mặc định |
| `PRESENT` | Có dạy | Xanh lá ✓ |
| `ABSENT` | Vắng | Đỏ ✗ |
| `EXCUSED` | Nghỉ có phép | Vàng / hổ phách |
| `CANCELLED` | Huỷ buổi | Xám gạch ngang (kèm `text-decoration: line-through` cho giờ) |

Chip phụ: **"Dạy bù"** dùng màu tím (đồng bộ với `PAYMENT_ORDERED` bên Đề xuất chi); **"Thuê ngoài"** dùng chip viền xám.

Luôn ưu tiên `statusLabel` / `dayOfWeekLabel` do API trả về; chỉ tự map khi cần màu.

---

## 8. GỢI Ý TRIỂN KHAI

```ts
export type SessionStatus = 'SCHEDULED' | 'PRESENT' | 'ABSENT' | 'EXCUSED' | 'CANCELLED';

export interface Teacher {
  id: number; name: string;
  phone: string | null; email: string | null;
  employeeId: number | null; employeeName: string | null;
  isActive: boolean; note: string | null;
}

export interface TeachingSchedule {
  id: number;
  teacherId: number; teacherName: string;
  schoolId: number; schoolName: string;
  subjectId: number; subjectName: string; schoolYear: string | null;
  dayOfWeek: number; dayOfWeekLabel: string | null;
  startTime: string; endTime: string;            // "07:30"
  effectiveFrom: string; effectiveTo: string | null;
  isActive: boolean; note: string | null;
}

export interface TeachingSession {
  id: number;
  scheduleId: number | null;                     // null = buổi lẻ / dạy bù
  teacherId: number; teacherName: string;
  schoolId: number; schoolName: string;
  subjectId: number; subjectName: string; schoolYear: string | null;
  date: string;                                  // "2026-08-04"
  dayOfWeek: number; dayOfWeekLabel: string | null;
  startTime: string; endTime: string;
  status: SessionStatus; statusLabel: string | null;
  isMakeup: boolean; makeupForSessionId: number | null;
  attendanceNote: string | null;
  checkedById: number | null; checkedByName: string | null;
  checkedAt: string | null;                      // ISO
  note: string | null;
}

export interface Pagination { page: number; limit: number; total: number; totalPages: number }
```

- Danh sách nào cũng trả `{ data, pagination }` → viết **một** hook phân trang dùng chung cho cả 3 màn.
- Lưới tuần: gọi `GET /teaching-sessions?fromDate=<T2>&toDate=<CN>&limit=200` **một lần cho cả tuần**, rồi group theo `date` ở client. **Đừng** gọi 7 request theo ngày, cũng đừng gọi từng request theo giáo viên — BE đã tối ưu để trả cả tuần trong 1 query.
- Sau khi `generate-sessions` thành công → invalidate cache danh sách buổi dạy.
- Sau khi chấm công → cập nhật lạc quan (optimistic) rồi đồng bộ lại, giữ đúng pattern các màn hiện có.

---

## 9. CHECKLIST NGHIỆM THU

**Đồng bộ giao diện**
- [ ] Không cài thêm thư viện UI/date/table nào mới.
- [ ] Menu, layout, bảng, form, modal, toast dùng lại component sẵn có; đặt cạnh màn Đề xuất chi thấy cùng một hệ thiết kế.
- [ ] Ngày hiển thị `DD/MM/YYYY`, gửi API `YYYY-MM-DD`; giờ `HH:mm`.

**Phân quyền**
- [ ] `0900000007` (nhansu) → thấy đủ 3 mục, thao tác được tất cả.
- [ ] `0900000002` (director) → thấy đủ 3 mục nhưng **không có** nút tạo/sửa/xoá/chấm công/sinh buổi.
- [ ] `0900000008` (giaovien) → chỉ thấy "Lịch dạy của tôi", không có nút thao tác nào.
- [ ] Đăng nhập role `sales`/`thuquy` → **không thấy** menu Giảng dạy.
- [ ] Gõ URL tay vào màn ngoài quyền → bị chặn/redirect.

**Giáo viên**
- [ ] Tạo được giáo viên thuê ngoài (không chọn tài khoản).
- [ ] Chọn tài khoản chưa có role `giaovien` → nhận 400 và hiện đúng message.
- [ ] Xoá giáo viên đã có buổi dạy → 409, hiện gợi ý tắt "Đang hoạt động".

**Lịch dạy**
- [ ] Tạo mẫu lịch Thứ Ba 07:30–09:00 → sinh buổi tháng đó ra đúng **4 buổi thứ Ba**.
- [ ] Bấm "Sinh buổi dạy" lần 2 cùng khoảng → toast báo **bỏ qua**, danh sách **không nhân đôi**.
- [ ] Tạo mẫu trùng giờ cùng giáo viên/cùng thứ → 409, hiện nguyên message BE.
- [ ] Tạo mẫu 09:00–10:30 sát ngay buổi 07:30–09:00 → **thành công** (chạm biên không phải trùng).
- [ ] Đổi Trường trong form → danh sách Môn load lại và môn đã chọn bị reset.
- [ ] Lưới tuần chuyển tuần trước/sau/hôm nay đúng; mỗi tuần chỉ gọi **1 request**.

**Chấm công**
- [ ] Chấm nhiều dòng rồi "Lưu chấm công" → 1 request bulk, chỉ gửi dòng đã đổi.
- [ ] Dòng đã chấm hiện tên người chấm + thời điểm.
- [ ] Bỏ chấm (về "Chưa chấm") → tên người chấm biến mất.
- [ ] Xoá buổi đã chấm công → 409, gợi ý chuyển sang "Huỷ buổi".
- [ ] Tạo buổi dạy bù từ buổi Vắng → buổi mới có chip "Dạy bù".
- [ ] Bảng tổng hợp khớp với số buổi trong danh sách.

**Trạng thái rỗng / lỗi**
- [ ] Khoảng ngày không có buổi nào → empty state, không phải bảng trắng.
- [ ] Giáo viên chưa được gắn hồ sơ → empty state thân thiện, không phải màn lỗi.
- [ ] Mọi lỗi 400/403/409 đều hiện message tiếng Việt của BE qua toast.

---

## 10. THAM CHIẾU

- Tài liệu BE đầy đủ: [TEACHING-MODULE-API.md](TEACHING-MODULE-API.md)
- OpenAPI 3.1 (import được vào Postman/Swagger UI để sinh client): [openapi/teaching.yaml](openapi/teaching.yaml)
