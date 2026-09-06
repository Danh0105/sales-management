# PROMPT: CẬP NHẬT FRONTEND MODULE ĐỀ XUẤT CHI

Bạn là Senior Frontend Developer. Backend module **Đề xuất chi** (`/expense-requests`) vừa bổ sung 3 thay đổi. Hãy cập nhật UI cho khớp. Giữ nguyên toàn bộ luồng 7 bước cũ; chỉ **thêm/sửa** các phần dưới đây.

## 0. Nền tảng (nhắc lại)

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**. Endpoint dạng `/expense-requests/...`.
- **Auth**: JWT Bearer mọi request. Login: `POST /auth/login` body `{ "phone", "password" }`.
- Tiêu đề đề xuất là `content`, số tiền `amount`, mốc báo động `expectedPaymentDate` (YYYY-MM-DD).
- **Role slug** trong `user.roles`: `sales`, `director`, `ketoan_congno`, `thuquy`, `saleadmin`.
- **User test** (password `123456`): sales `0900000001`, director `0900000002`, ketoan_congno `0900000003`, thuquy `0900000004`, **saleadmin `0900000005`**.
- Lỗi: sai role → **403**, sai trạng thái/thao tác lại → **409/400**, không đăng nhập → **401**. Hiển thị message backend trả về.

---

## THAY ĐỔI 1 — SALES ADMIN KIỂM DUYỆT (mới)

Trước đây `saleadmin` chỉ nhận thông báo theo dõi. Nay `saleadmin` có **chức năng kiểm duyệt song song** với giám đốc.

### 1.1 Bản chất (đọc kỹ)

- Kiểm duyệt của Sales Admin là **cố vấn, KHÔNG chặn giám đốc**. Đề xuất **vẫn ở `PENDING_APPROVAL`** sau khi Sales Admin kiểm duyệt — **giám đốc vẫn duyệt/từ chối bình thường mà không cần chờ Sales Admin**.
- Sales Admin có 2 lựa chọn:
  - **REVIEWED** — kiểm duyệt đạt (ghi chú optional).
  - **REJECTED** — **từ chối chính sách**, **bắt buộc nhập ghi chú**.
- Khi Sales Admin kiểm duyệt/từ chối → hệ thống **thông báo cho người tạo đề xuất + giám đốc**.

### 1.2 Endpoint

**POST** `/expense-requests/:id/sale-admin-review` — role **`saleadmin`**

```json
{
  "status": "REJECTED",          // "REVIEWED" | "REJECTED"
  "note": "Chính sách không hợp lệ vì..."  // BẮT BUỘC khi REJECTED, optional khi REVIEWED
}
```

- Chỉ gọi được khi đề xuất đang **`PENDING_APPROVAL`** (chưa được giám đốc xử lý). Trạng thái khác → 400.
- `REJECTED` mà thiếu `note` → 400 (message: "Phải có ghi chú khi từ chối chính sách").
- Response = chi tiết đề xuất (giống `GET /expense-requests/:id`, kèm `logs`).

### 1.3 Field mới trong chi tiết đề xuất

`GET /expense-requests/:id` và các list nay trả thêm:

| Field | Kiểu | Ý nghĩa |
|---|---|---|
| `saleadminReviewStatus` | `"REVIEWED"` \| `"REJECTED"` \| `null` | Kết quả kiểm duyệt của Sales Admin (`null` = chưa kiểm duyệt) |
| `saleadminNote` | string \| null | Ghi chú của Sales Admin |
| `saleadminReviewedBy` | number \| null | ID người kiểm duyệt |
| `saleadminReviewedAt` | ISO datetime \| null | Thời điểm kiểm duyệt |

### 1.4 Yêu cầu UI

**Màn hình Sales Admin** (role `saleadmin`):
- Ở màn chi tiết đề xuất đang `PENDING_APPROVAL` và `saleadminReviewStatus == null`: hiện 2 nút **"Kiểm duyệt đạt"** (REVIEWED) và **"Từ chối chính sách"** (REJECTED).
- Nút "Từ chối chính sách" mở form có ô **ghi chú bắt buộc**. "Kiểm duyệt đạt" có ô ghi chú optional.
- Sau khi gửi thành công: khóa nút, hiển thị trạng thái đã kiểm duyệt.

**Mọi role xem chi tiết** — hiển thị **badge trạng thái kiểm duyệt Sales Admin** khi `saleadminReviewStatus != null`:
- `REVIEWED` → badge xanh "Sales Admin đã kiểm duyệt".
- `REJECTED` → **badge/cảnh báo đỏ nổi bật** "Sales Admin từ chối chính sách" + hiển thị `saleadminNote`.

**Màn hình Giám đốc**:
- Khi duyệt đề xuất mà `saleadminReviewStatus == 'REJECTED'`: hiển thị **cảnh báo ghi chú của Sales Admin ngay cạnh nút Duyệt/Từ chối** (giám đốc vẫn được phép duyệt — không disable nút).

### 1.5 "Việc cần làm của tôi" (my-tasks)

`GET /expense-requests/my-tasks` nay trả về cho `saleadmin` các đề xuất **`PENDING_APPROVAL` chưa kiểm duyệt** (`saleadminReviewStatus == null`). FE thêm tab/danh sách "Cần kiểm duyệt" cho Sales Admin.

### 1.6 Thông báo (socket + FCM) + audit log

- Khi tạo đề xuất mới: nay **Sales Admin cũng nhận thông báo** (trước chỉ giám đốc) → cho vào chuông thông báo của saleadmin.
- Khi Sales Admin kiểm duyệt/từ chối, thông báo gửi tới **người tạo + giám đốc** với `meta.kind`:
  - `"saleadmin_reject"` (title "⚠️ Sales Admin từ chối chính sách") — kèm `meta.saleadminNote`, `meta.saleadminReviewStatus`.
  - `"saleadmin_review"` (title "🔍 Sales Admin đã kiểm duyệt").
- **Audit log** (`logs[]` trong chi tiết) có thêm `action`: `"SALE_ADMIN_REVIEW"` / `"SALE_ADMIN_REJECT"` (kèm `note`). Bổ sung nhãn tiếng Việt cho 2 action này trong timeline lịch sử.

---

## THAY ĐỔI 2 — DANH SÁCH ĐỀ XUẤT CHI GOM NHÓM THEO NHÂN VIÊN (mới)

### 2.1 Endpoint

**GET** `/expense-requests/grouped-by-employee` — mọi role

Nhận **đúng bộ lọc** như `GET /expense-requests`: `status`, `createdBy`, `schoolId`, `schoolYear`, `fromDate`, `toDate`, `overdue`, `page`, `limit`.

> **Lưu ý phân trang**: `page`/`limit` ở đây phân trang **theo NHÂN VIÊN** (mỗi trang là `limit` nhân viên), không phải theo từng đề xuất. `total`/`totalPages` là theo số nhân viên.

### 2.2 Response

```json
{
  "data": [
    {
      "employeeId": 12,
      "employee": { "id": 12, "name": "Nguyễn Văn A", "phone": "0900000001" },
      "total": 5,               // số đề xuất của nhân viên (đã áp filter)
      "totalAmount": 12500000,  // tổng tiền các đề xuất
      "requests": [ /* mảng đề xuất chi, mỗi phần tử kèm paymentOrder + school */ ]
    }
  ],
  "total": 8,          // tổng số nhân viên
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

- Nhóm sắp theo **đề xuất mới nhất của mỗi nhân viên** (giảm dần). Trong mỗi nhóm, `requests` sắp theo `createdAt` giảm dần.
- `employee` chỉ có `id/name/phone` (không có object `createdByUser` đầy đủ như list phẳng).

### 2.3 Yêu cầu UI

- Thêm chế độ xem **"Nhóm theo nhân viên"** ở màn danh sách đề xuất chi (toggle giữa "Danh sách phẳng" ↔ "Theo nhân viên").
- Mỗi nhóm là 1 card/accordion: header hiển thị **tên + SĐT nhân viên**, **badge số đề xuất (`total`)** và **tổng tiền (`totalAmount`)** (format `vi-VN` + "đ"). Mở ra hiện danh sách `requests` (dùng lại component item đề xuất sẵn có).
- Áp lại toàn bộ bộ lọc hiện có (status/trường/năm học/ngày/quá hạn). Phân trang theo nhân viên.

---

## THAY ĐỔI 3 — CẢNH BÁO ĐẾN NGÀY CHI CHO GIÁM ĐỐC (điều chỉnh thông báo)

Trước đây cảnh báo **"Hôm nay là ngày dự kiến chi"** (`meta.kind = "due_today"`) không tới giám đốc ở phần lớn trạng thái. Nay **giám đốc luôn nhận** cảnh báo này (đồng bộ với cảnh báo quá hạn `meta.kind = "overdue"`).

**FE cần**: đảm bảo chuông thông báo / danh sách notification của **giám đốc KHÔNG lọc bỏ** các notification `meta.kind` = `"due_today"` và `"overdue"` của đề xuất chi (`meta.suggestType = "EXPENSE_REQUEST"`). Không cần thêm màn hình mới — chỉ hiển thị đúng.

---

## CHECKLIST NGHIỆM THU

- [ ] Sales Admin thấy nút Kiểm duyệt / Từ chối chính sách ở đề xuất `PENDING_APPROVAL` chưa kiểm duyệt; từ chối bắt buộc ghi chú.
- [ ] Sau khi Sales Admin từ chối, người tạo + giám đốc nhận thông báo; badge đỏ + ghi chú hiển thị ở chi tiết cho mọi role.
- [ ] Giám đốc **vẫn duyệt được** đề xuất dù Sales Admin đã từ chối (nút không bị khóa).
- [ ] my-tasks của Sales Admin có danh sách "Cần kiểm duyệt".
- [ ] Timeline lịch sử render nhãn cho `SALE_ADMIN_REVIEW` / `SALE_ADMIN_REJECT`.
- [ ] Màn danh sách có chế độ "Nhóm theo nhân viên" gọi `/expense-requests/grouped-by-employee`, hiển thị tổng số & tổng tiền mỗi nhân viên, phân trang theo nhân viên, áp đủ filter.
- [ ] Giám đốc nhận & thấy được thông báo "due_today" và "overdue" của đề xuất chi.
