# PROMPT: CẬP NHẬT FRONTEND — CHUÔNG THÔNG BÁO ĐỀ XUẤT CHI (GOM NHÓM THEO NHÂN VIÊN + TAB QUÁ HẠN)

Bạn là Senior Frontend Developer. Backend vừa bổ sung nhóm API **thông báo đề xuất chi** phục vụ chuông thông báo. Yêu cầu FE:

1. Trong phần thông báo đề xuất chi, **gom nhóm theo nhân viên kinh doanh** (người tạo đề xuất).
2. **Cảnh báo đề xuất quá hạn** tách thành **1 tab riêng**.

Giữ nguyên các phần thông báo khác; chỉ thêm/sửa phần đề xuất chi.

---

## 0. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**.
- **Auth**: JWT Bearer mọi request.
- Thông báo đề xuất chi được lưu chung `type = SUGGEST`, phân biệt bằng `meta.suggestType = "EXPENSE_REQUEST"`.
- **"Nhân viên kinh doanh"** của 1 thông báo = **`meta.employeeId`** (người tạo đề xuất).

### 0.1 `meta` của thông báo đề xuất chi (đã bổ sung)

```jsonc
{
  "suggestType": "EXPENSE_REQUEST",
  "suggestId": 1234,
  "suggestCode": "DXC-000123",
  "employeeId": 17,                 // NEW — nhân viên kinh doanh tạo đề xuất
  "employeeName": "Bùi Huy Hoàng",  // NEW — tên (đã fix dấu)
  "employeePhone": "0975555676",    // NEW
  "kind": "overdue",                // reminder | due_today | overdue | created | ... (phân loại)
  "status": "APPROVED",             // trạng thái đề xuất khi bắn thông báo
  "daysLate": 3                     // chỉ có khi kind = overdue
}
```

> Thông báo cũ (trước thay đổi) **không có** `employeeId` → BE tự loại khỏi phần gom nhóm. FE không cần xử lý gì thêm.

### 0.2 Khái niệm `scope`

Mọi endpoint dưới đây nhận query `scope`:

| `scope` | Ý nghĩa | Dùng cho |
|---|---|---|
| `general` (mặc định) | Tất cả thông báo **TRỪ** quá hạn | Tab "Theo nhân viên" |
| `overdue` | **Chỉ** cảnh báo quá hạn (`meta.kind = "overdue"`) | Tab "Quá hạn" |
| `all` | Không lọc theo `kind` | (tùy chọn) |

`tab` (khác `scope`) lọc trạng thái đọc: `unread` | `read`. Bỏ trống = tất cả.

---

## 1. ENDPOINTS

### 1.1 Badge các tab

**GET** `/notifications/expense/summary`

```json
{
  "general": { "total": 12, "unread": 5 },
  "overdue": { "total": 3,  "unread": 3 }
}
```

Dùng để hiện **số chưa đọc** trên 2 tab: "Theo nhân viên" (`general.unread`) và "Quá hạn" (`overdue.unread`).

### 1.2 Gom nhóm theo nhân viên kinh doanh

**GET** `/notifications/expense/grouped-by-employee?scope=general&tab=&page=1&limit=20`

- **Phân trang theo NHÂN VIÊN** (`limit` nhân viên/trang). `total`/`totalPages` là theo số nhân viên.
- Sắp theo **thông báo mới nhất của mỗi nhân viên** (giảm dần), rồi số chưa đọc giảm dần.

```json
{
  "scope": "general",
  "data": [
    {
      "employeeId": 17,
      "employeeName": "Bùi Huy Hoàng",
      "phone": "0975555676",
      "total": 2,          // số thông báo (đã áp scope/tab)
      "unreadCount": 1,
      "latestAt": "2026-07-11T08:00:00.000Z"
    }
  ],
  "total": 2,   // tổng số nhân viên
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

> `employeeName`/`phone` lấy trực tiếp từ bảng nhân viên (luôn mới nhất), không phải từ `meta`.

### 1.3 Danh sách phẳng (bung 1 nhân viên / tab quá hạn)

**GET** `/notifications/expense?scope=&tab=&employeeId=&page=1&limit=20`

- `employeeId` (optional): chỉ thông báo của 1 nhân viên → dùng khi **bung 1 nhóm**.
- Không truyền `employeeId` + `scope=overdue` → danh sách phẳng cho **tab Quá hạn**.
- Trả về notification đầy đủ (`id, message, isRead, createdAt, meta, entityId, ...`), sắp `createdAt` giảm dần.

```json
{
  "scope": "overdue",
  "data": [
    {
      "id": 555,
      "receiverId": 136,
      "type": "SUGGEST",
      "entityId": 9004,
      "message": "Đề xuất DXC-... đã quá ngày dự kiến chi 1 ngày ...",
      "isRead": false,
      "createdAt": "2026-07-11T08:12:00.000Z",
      "meta": { "suggestType": "EXPENSE_REQUEST", "suggestId": 9004, "employeeId": 18, "kind": "overdue", "daysLate": 1, "status": "ORDER_CREATED" }
    }
  ],
  "total": 3, "page": 1, "limit": 20, "totalPages": 1
}
```

### 1.4 Đánh dấu đã đọc

- **PATCH** `/notifications/expense/:id/read` — đọc 1 thông báo.
- **PATCH** `/notifications/expense/read-all?scope=&employeeId=` — đọc hàng loạt:
  - `read-all?scope=overdue` → đọc hết tab Quá hạn.
  - `read-all?scope=general&employeeId=17` → đọc hết thông báo (thường) của nhân viên 17.
  - `read-all` (không tham số) → đọc hết phần **general**.

Cả hai trả `{ "success": true }`. Sau khi gọi, **refetch** `summary` + list/grouped để cập nhật badge.

---

## 2. YÊU CẦU UI

Trong màn/khối thông báo đề xuất chi, dựng **2 tab**:

### Tab A — "Theo nhân viên" (`scope=general`)
- Gọi `grouped-by-employee?scope=general`. Mỗi nhân viên là 1 **card/accordion**:
  - Header: **tên + SĐT** nhân viên, **badge tổng (`total`)** và **badge chưa đọc (`unreadCount`)**, thời điểm `latestAt`.
  - Nút **"Đánh dấu đã đọc"** cho cả nhóm → `read-all?scope=general&employeeId=<id>`.
- Bung card → gọi `GET /notifications/expense?scope=general&employeeId=<id>` để hiện từng thông báo (dùng lại item thông báo sẵn có). Click 1 item → `:id/read` + điều hướng `/expense-requests/<meta.suggestId>`.
- Phân trang **theo nhân viên** (dùng `total/totalPages`).

### Tab B — "Quá hạn" (`scope=overdue`)
- Mặc định danh sách phẳng: `GET /notifications/expense?scope=overdue` (mới nhất trước), style **cảnh báo đỏ**, hiện `meta.daysLate` ("quá hạn N ngày") và `meta.status`.
- Nút **"Đọc hết"** → `read-all?scope=overdue`.
- (Tùy chọn) cho phép cũng gom nhóm theo nhân viên bằng `grouped-by-employee?scope=overdue`.

### Chuông / badge
- Số trên chuông cho phần đề xuất chi = `summary.general.unread + summary.overdue.unread` (hoặc tách 2 badge tùy thiết kế).
- **KHÔNG** lọc bỏ `meta.kind = "due_today"` và `"overdue"` (giám đốc phải thấy — đồng bộ với FE-EXPENSE-UPDATE-PROMPT thay đổi 3).

### Realtime
- Vẫn nghe socket event **`suggest-notification:new`** như cũ. Khi có event mà `payload.meta.suggestType === "EXPENSE_REQUEST"`: refetch `summary` và tab đang mở (grouped/list). Nếu `payload.meta.kind === "overdue"` → tăng badge tab Quá hạn.

---

## 3. CHECKLIST NGHIỆM THU

- [ ] Có 2 tab: "Theo nhân viên" (general) và "Quá hạn" (overdue); badge lấy từ `/summary`.
- [ ] Tab "Theo nhân viên" gọi `/grouped-by-employee`, hiển thị tên + SĐT + tổng + chưa đọc mỗi nhân viên, phân trang theo nhân viên.
- [ ] Bung 1 nhân viên gọi list `?employeeId=`; click item điều hướng `/expense-requests/<suggestId>` và đánh dấu đã đọc.
- [ ] Tab "Quá hạn" chỉ hiện `meta.kind = "overdue"`, có `daysLate`, style cảnh báo đỏ.
- [ ] "Đánh dấu đã đọc" theo nhóm (`read-all?scope=&employeeId=`) và theo tab (`read-all?scope=overdue`) hoạt động; badge cập nhật.
- [ ] Socket `suggest-notification:new` → refetch đúng tab; badge tab Quá hạn tăng khi kind=overdue.
- [ ] Thông báo cũ không có `employeeId` không làm vỡ giao diện (BE đã loại khỏi phần gom nhóm).
```
