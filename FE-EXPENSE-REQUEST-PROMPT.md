# PROMPT: XÂY DỰNG GIAO DIỆN MODULE ĐỀ XUẤT CHI (FRONTEND)

Bạn là Senior Frontend Developer. Hãy xây dựng UI cho module **Đề xuất chi tiền** với quy trình duyệt 7 bước, thông báo real-time (socket + FCM), báo động theo ngày dự kiến chi. UI phục vụ **5 role**, mỗi role có màn hình & action riêng.

## 0. Thông tin nền tảng (đọc kỹ trước khi code)

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**. Endpoint là `/expense-requests/...`, `/auth/login`, `/notifications`.
- **Auth**: JWT Bearer. `POST /auth/login` body `{ "phone", "password" }` → `{ "access_token" }`. Gắn header `Authorization: Bearer <token>` mọi request.
- **Field tiêu đề là `content`** (không phải `title`). Không gửi `amount` khi tạo đề xuất; số tiền được nhập khi kế toán lập lệnh chi. Mốc báo động `expectedPaymentDate` (YYYY-MM-DD).
- Backend dùng chung bảng/service với "đề xuất" cũ, phân biệt bằng `type = "EXPENSE_REQUEST"` — FE không cần quan tâm, chỉ gọi đúng endpoint `/expense-requests`.
- **Upload**: multipart. Khi tạo/sửa field file tên là **`file`** (1 file). Khi thủ quỹ xuất tiền / sales xác nhận đã chi, field là **`files`** (nhiều file, tối đa 5).
- **User test** (password `123456`): sales `0900000001`, director `0900000002`, ketoan_congno `0900000003`, thuquy `0900000004`, saleadmin `0900000005`.

---

## 1. QUY TRÌNH (STATE MACHINE)

```
(tạo) → PENDING_APPROVAL → APPROVED → PAYMENT_ORDERED → CASH_RELEASED
     → CASH_RECEIVED → SPENT (kết thúc ✓ đã chi)
                    ↘ NOT_SPENT → FUND_RETURNED ─┐
                                   ↑             │
                                   └─ PAYMENT_ORDERED (kế toán lập lại lệnh chi)
PENDING_APPROVAL → REJECTED (kết thúc ✗ từ chối)
```

> Kinh doanh **tạo đề xuất là gửi duyệt luôn** — vào thẳng `PENDING_APPROVAL`, báo Giám đốc ngay. **Không có bước nháp (DRAFT) hay sửa đề xuất.**

| # | Status hiện tại | Role được thao tác | Action → Status mới |
|---|---|---|---|
| 1 | (tạo mới) | sales | POST /expense-requests → PENDING_APPROVAL |
| 2 | PENDING_APPROVAL | director | approve → APPROVED / reject → REJECTED |
| 3 | APPROVED, FUND_RETURNED | ketoan_congno | payment-order → PAYMENT_ORDERED |
| 4 | PAYMENT_ORDERED | thuquy | cash-released → CASH_RELEASED |
| 5 | CASH_RELEASED | sales (chủ) | cash-received → CASH_RECEIVED |
| 6A | CASH_RECEIVED | sales (chủ) | confirm-spent → SPENT |
| 6B | CASH_RECEIVED | sales (chủ) | confirm-not-spent → NOT_SPENT |
| 7 | NOT_SPENT | thuquy | fund-returned → FUND_RETURNED |

**Ràng buộc quan trọng**: action của `sales` (bước 5, 6) chỉ **chính người tạo đề xuất** được làm. Gọi sai role → 403; gọi sai trạng thái (thao tác lại) → 409.

---

## 2. API ENDPOINTS

### 2.1 Vai trò (role slug trong `user.roles`)

`sales` (Kinh doanh) · `director` (Giám đốc) · `ketoan_congno` (Kế toán công nợ) · `thuquy` (Thủ quỹ) · `saleadmin` (Sales Admin — chỉ theo dõi).

### 2.2 SALES — Tạo đề xuất & xác nhận

**POST** `/expense-requests` (multipart)
```
{
  "content": "Chi tiếp khách",         // tiêu đề/nội dung (BẮT BUỘC)
  "description": "Tiếp khách dự án X",  // lý do chi tiết (optional)
  "expectedPaymentDate": "2026-07-15",  // BẮT BUỘC (mốc báo động, ≥ hôm nay)
  "beneficiaryInfo": "Nguyễn Văn A, VCB 0123", // optional
  "file": File                          // optional, 1 file
}
→ 201 {
  "id": 1, "type": "EXPENSE_REQUEST", "code": "DX-202607-0001",
  "content": "...", "expectedPaymentDate": "2026-07-15",
  "status": "PENDING_APPROVAL", "isOverdue": false, "createdBy": 132, "createdAt": "..."
}
```
> Tạo xong là **PENDING_APPROVAL** ngay + báo Giám đốc. Không có endpoint nháp/sửa/submit.

**POST** `/expense-requests/:id/cash-received` — body `{ note? }` → `CASH_RECEIVED`.

**POST** `/expense-requests/:id/confirm-spent` (multipart) — body `{ note? }` + `files[]` (hóa đơn) → `SPENT`.

**POST** `/expense-requests/:id/confirm-not-spent` — body `{ "reason": "..." }` (BẮT BUỘC) → `NOT_SPENT` — báo Thủ quỹ.

### 2.3 DIRECTOR — Duyệt / Từ chối

**POST** `/expense-requests/:id/approve` → `APPROVED` — báo thuquy + saleadmin + ketoan_congno + người tạo.

**POST** `/expense-requests/:id/reject` — body `{ "reason": "..." }` (BẮT BUỘC) → `REJECTED` — báo người tạo.

### 2.4 KẾ TOÁN CÔNG NỢ — Lên lệnh chi

**POST** `/expense-requests/:id/payment-order`
```
{ "amount": 5000000, "paymentMethod": "CASH" | "BANK_TRANSFER", "note": "..." }
→ 201 {
  "suggest": { ..., "status": "PAYMENT_ORDERED" },
  "paymentOrder": { "id": 10, "code": "LC-202607-0001", "amount": 5000000,
                    "paymentMethod": "CASH", "note": "...", "createdBy": 134 }
}
```
báo Thủ quỹ. ⚠️ Response bọc trong `suggest` + `paymentOrder`.

### 2.5 THỦ QUỸ — Xuất tiền / Hoàn quỹ

**POST** `/expense-requests/:id/cash-released` (multipart) — body `{ note? }` + `files[]` (chứng từ) → `CASH_RELEASED` — báo người tạo.

**POST** `/expense-requests/:id/fund-returned` — body `{ note? }` → `FUND_RETURNED`.

### 2.6 QUERY (mọi role)

**GET** `/expense-requests` — `?status=&createdBy=&fromDate=&toDate=&overdue=true&page=1&limit=20`
```
→ { "data": [ { id, code, content, amount, status, isOverdue, expectedPaymentDate, createdAt, creator } ],
    "total", "page", "limit", "totalPages" }
```

**GET** `/expense-requests/:id` — chi tiết đầy đủ:
```
→ {
  id, code, content, description, amount, expectedPaymentDate, beneficiaryInfo,
  status, isOverdue, rejectReason, notSpentReason, ...các mốc thời gian...,
  creator: { id, name },
  paymentOrder: { code, amount, paymentMethod, note, creator },
  attachments: [ { id, fileUrl, fileName, uploadedBy, createdAt } ],
  logs: [ { id, action, fromStatus, toStatus, note, userId, snapshotAt } ]  // audit timeline
}
```

**GET** `/expense-requests/my-tasks` — việc cần làm theo role (sắp overdue trước, ngày chi gần nhất):
- director → PENDING_APPROVAL · ketoan_congno → APPROVED · thuquy → PAYMENT_ORDERED, NOT_SPENT · sales → đề xuất của mình ở CASH_RELEASED, CASH_RECEIVED.

### 2.7 CẤU HÌNH BÁO ĐỘNG

**GET** `/expense-requests/reminder-settings` → `{ "remindBeforeDays": 1, "enabled": true }`
**PATCH** `/expense-requests/reminder-settings` (director) — `{ "remindBeforeDays": 2, "enabled": false }`. Có thể chỉ gửi `enabled` để bật/tắt cảnh báo mà không đổi số ngày nhắc.

### 2.8 NOTIFICATION (nằm chung trong phần "đề xuất")

Thông báo đề xuất chi dùng chung **`type = "SUGGEST"`** (hiển thị trong phần "đề xuất"), phân biệt bằng **`meta.suggestType = "EXPENSE_REQUEST"`**.

**GET** `/notifications?type=SUGGEST&page=1&limit=20&tab=unread`
**PATCH** `/notifications/:id/read` · **PATCH** `/notifications/read-all`
```
notification: {
  id, type: "SUGGEST", message,
  entityId,               // = id đề xuất → dùng điều hướng chi tiết
  meta: { suggestId, suggestType: "EXPENSE_REQUEST", status, ... },
  isRead, createdAt
}
```
> FE dùng `meta.suggestType === "EXPENSE_REQUEST"` để điều hướng sang màn đề xuất chi (`/expense-requests/:entityId`), phân biệt với đề xuất thường trong cùng danh sách.

### 2.9 SOCKET.IO REAL-TIME

Connect socket lúc login (kèm token/userId theo cơ chế gateway hiện có), join room `user_{userId}`.
```
Event: "suggest-notification:new"
Payload: { id, type: "SUGGEST", entityId, message, meta: { suggestId, suggestType, status }, isRead, createdAt }
```
Khi nhận → tăng badge phần "đề xuất", prepend vào list, toast, và refresh `my-tasks` / list đang mở.

---

## 3. MÀN HÌNH THEO ROLE

### 3.1 SALES
- **Danh sách đề xuất của tôi** (`GET /expense-requests?createdBy=<me>`): code, content, amount, status badge, expectedPaymentDate, cờ overdue (đỏ ⚠️). Nút [Tạo mới]. Filter status/ngày.
- **Tạo mới**: form content, description, expectedPaymentDate (datepicker, ≥ hôm nay), beneficiaryInfo, upload file. Không có trường amount. Bấm tạo là gửi duyệt luôn (→ PENDING_APPROVAL, báo Giám đốc). Không có màn sửa/nháp.
- **Chi tiết**: theo status hiển thị nút:
  - CASH_RELEASED → [Xác nhận đã nhận tiền]
  - CASH_RECEIVED → [Đã chi (upload hóa đơn)] [Chưa chi (nhập lý do)]
  - còn lại → chỉ xem trạng thái/timeline.
- **My Tasks** (`/expense-requests/my-tasks`).

### 3.2 DIRECTOR
- **Chờ duyệt** (`my-tasks` hoặc `?status=PENDING_APPROVAL`): nút [Duyệt] [Từ chối + lý do]. Filter overdue.
- **Cấu hình báo động**: input remindBeforeDays (PATCH).
- (Optional) Dashboard thống kê theo status.

### 3.3 KẾ TOÁN CÔNG NỢ
- **Chờ lên lệnh chi** (`?status=APPROVED`): form lệnh chi (nhập amount, paymentMethod CASH/BANK_TRANSFER, note) → [Lên lệnh chi].

### 3.4 THỦ QUỸ
- **Chờ xuất tiền** (`?status=PAYMENT_ORDERED`): xem lệnh chi, upload chứng từ, note → [Xác nhận xuất tiền].
- **Quỹ chờ hoàn** (`?status=NOT_SPENT`): xem lý do chưa chi → [Xác nhận nhận lại quỹ].

### 3.5 SALES ADMIN
- **Tất cả đề xuất** (read-only, `GET /expense-requests`) + thống kê. Nhận notification theo dõi.

---

## 4. UX

- **Status badge màu**: PENDING_APPROVAL vàng · APPROVED xanh dương · PAYMENT_ORDERED tím · CASH_RELEASED cam · CASH_RECEIVED xanh nhạt · SPENT xanh ✓ · NOT_SPENT hổ phách · FUND_RETURNED xanh ✓ · REJECTED đỏ ✗.
- **Overdue**: `isOverdue = true` → viền/nền đỏ + icon ⚠️ trong list & chi tiết.
- **Timeline audit** (`logs`): mỗi dòng "thời gian — người — action (fromStatus → toStatus) — note".
- **Notification bell**: badge chưa đọc trong phần "đề xuất" (`GET /notifications?type=SUGGEST`); với item có `meta.suggestType === "EXPENSE_REQUEST"` → click điều hướng sang chi tiết đề xuất chi theo `entityId` + mark read.
- **Validate form tạo đề xuất**: content required; expectedPaymentDate ≥ hôm nay; reason bắt buộc ở reject & confirm-not-spent; file ≤ 5, mỗi file ≤ ~50MB. `amount > 0` chỉ validate khi lập lệnh chi.
- **Xử lý lỗi**: 401 → về login; 403 → ẩn nút + báo "không có quyền / không phải chủ đề xuất"; 409 → "trạng thái đã thay đổi, vui lòng tải lại" + reload chi tiết; 400 → hiện message validate.
- **Chống double-submit**: disable nút khi request đang chạy (backend đã lock nhưng FE vẫn nên disable).

---

## 5. Kỹ thuật gợi ý

State management (Redux/Zustand/React Query), React Hook Form + Zod/Yup, dayjs (format YYYY-MM-DD), axios interceptor gắn token + bắt 401/403/409, Socket.IO client, component UI (AntD/MUI/Tailwind). Điều hướng đề xuất qua `entityId` của notification.

---

Tài liệu API chi tiết từ BE: [EXPENSE-REQUEST-API.md](EXPENSE-REQUEST-API.md)
