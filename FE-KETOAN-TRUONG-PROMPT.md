# PROMPT: CẬP NHẬT FRONTEND — VAI TRÒ KẾ TOÁN TRƯỞNG (CHỈ XEM)

Bạn là Senior Frontend Developer. Hệ thống vừa thêm vai trò **Kế toán trưởng** (`ketoan_truong`) — một vai trò **CHỈ XEM** (read-only). Hãy cập nhật FE để vai trò này thấy đúng 4 khu vực và **không thao tác được**.

---

## 0. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**.
- **Auth**: JWT Bearer. Login: `POST /auth/login` body `{ "phone", "password" }`.
- **Role slug mới**: `ketoan_truong` (nằm trong mảng `user.roles`).
- **Tài khoản test** (password `123456`): **kế toán trưởng `0900000006`**.
- Các role khác (nhắc lại): `sales`, `director`, `ketoan_congno`, `thuquy`, `saleadmin`.

---

## 1. QUYỀN CỦA KẾ TOÁN TRƯỞNG

`ketoan_truong` **chỉ được XEM** đúng **4 khu vực**, tuyệt đối **không** tạo/sửa/xóa/duyệt/thao tác:

| # | Khu vực (menu) | Endpoint xem (GET) chính |
|---|---|---|
| 1 | **Quản lý thu chi** | `/school-expenses`, `/school-expenses/:id`, `/school-expenses/:id/items`, `/school-expenses/:id/summary`, `/school-expenses/:id/history`, `/school-expenses/check-existed` |
| 2 | **Thống kê** | `/statistics` |
| 3 | **Đề xuất chi** | `/expense-requests`, `/expense-requests/:id`, `/expense-requests/grouped-by-employee`, `/expense-requests/my-tasks`, và thông báo `/notifications/expense/*` |
| 4 | **Chính sách** | `/policies`, `/policies/:id`, `/policies/stats`, `/policy-years?schoolId=&schoolYear=`, `/policy-years/:id` |

> Các khu vực **khác** (không thuộc 4 mục trên) → **ẩn khỏi menu** đối với `ketoan_truong`.

---

## 2. YÊU CẦU UI

### 2.1 Menu / điều hướng
- Khi `user.roles` chứa `ketoan_truong`: hiển thị menu **chỉ gồm 4 khu vực** trên. Ẩn mọi menu còn lại.
- Chặn truy cập route ngoài 4 khu vực (redirect về trang đầu tiên được phép nếu người dùng gõ URL tay).

### 2.2 Chế độ chỉ xem (read-only) trong cả 4 khu vực
Với `ketoan_truong`, **ẩn hoặc disable toàn bộ** phần tử thao tác ghi:
- Nút **Tạo mới / Thêm** đề xuất, chính sách, phiếu thu chi…
- Nút **Sửa / Lưu / Lưu tất cả (save-all) / Xóa**.
- Các nút **hành động luồng đề xuất chi**: Duyệt, Từ chối, Lên lệnh chi, Xuất tiền, Xác nhận nhận tiền, Kiểm duyệt (sale-admin)…
- Các ô nhập liệu để ở trạng thái **readonly/disabled**; form không submit.
- Ẩn nút cấu hình nhắc hẹn (`PATCH /expense-requests/reminder-settings`) và "Chạy nhắc" — chỉ giám đốc.

### 2.3 Xử lý lỗi quyền
Backend đã chặn cứng phần thu chi & đề xuất chi: nếu vẫn gọi nhầm API ghi, server trả **403**. FE phải:
- Không hiển thị nút dẫn tới thao tác ghi (phòng ngừa từ đầu).
- Nếu lỡ nhận **403**, hiện toast "Bạn chỉ có quyền xem" thay vì màn hình lỗi.

---

## 3. BACKEND ĐÃ ÁP (để FE nắm)

Backend đã **chặn cứng** mọi thao tác ghi của `ketoan_truong` ở cả 4 khu vực — gọi nhầm API ghi luôn trả **403** (`"Bạn chỉ có quyền xem"`). Cụ thể:

- **Quản lý thu chi** (`/school-expenses`): `ketoan_truong` **được GET**, còn `POST/PATCH/DELETE/:id/save-all` → **403**.
- **Đề xuất chi** (`/expense-requests`): các GET mở cho mọi role đã đăng nhập (bao gồm `ketoan_truong`); mọi API hành động (approve/reject/payment-order/cash-released/… ) đã giới hạn role khác → `ketoan_truong` gọi sẽ **403**.
- **Thống kê** (`/statistics`): chỉ đọc.
- **Chính sách**: GET (`/policies`, `/policies/:id`, `/policies/stats*`, `/policy-years`, `/policy-years/:id`, `/annual-policies`) xem bình thường. Các API ghi `POST/PATCH/DELETE /policies`, `POST /policy-years/upsert`, `POST /annual-policies` → `ketoan_truong` nhận **403** (guard read-only). Các role ghi khác **không bị ảnh hưởng**.

> Backend chặn là lớp phòng thủ; **FE vẫn phải ẩn** nút ghi để UX đúng (đừng để người dùng bấm rồi mới báo 403).

---

## 4. GỢI Ý TRIỂN KHAI

```ts
const isChiefAccountant = (user) => user?.roles?.includes('ketoan_truong');

// quyền ghi = có ít nhất 1 role ghi; kế toán trưởng KHÔNG có quyền ghi
const READ_ONLY_ROLES = ['ketoan_truong'];
const canWrite = (user, area) =>
  !!user?.roles?.some(r => WRITE_ROLES_BY_AREA[area].includes(r));

// Ví dụ khu Quản lý thu chi:
// WRITE_ROLES_BY_AREA['school-expenses'] = ['accountant','ketoan_congno','troly_gd','director'];
```

- Bọc các nút ghi bằng `canWrite(user, area)`; kế toán trưởng luôn `false`.
- Menu: `MENU_FOR_CHIEF_ACCOUNTANT = ['Quản lý thu chi', 'Thống kê', 'Đề xuất chi', 'Chính sách']`.

---

## 5. CHECKLIST NGHIỆM THU

- [ ] Đăng nhập `0900000006/123456` → menu chỉ có 4 khu vực; các menu khác bị ẩn.
- [ ] Cả 4 khu vực xem được dữ liệu (list + chi tiết).
- [ ] Không thấy bất kỳ nút tạo/sửa/xóa/lưu/duyệt/hành động nào trong 4 khu vực.
- [ ] Quản lý thu chi: thử gọi API ghi (nếu có) → 403 → toast "Bạn chỉ có quyền xem".
- [ ] Đề xuất chi: không có nút Duyệt/Từ chối/Lên lệnh/Xuất tiền… ; xem được danh sách, chi tiết, nhóm-theo-nhân-viên, thông báo.
- [ ] Chính sách: chỉ xem; nút tạo/sửa/xóa/lưu bị ẩn hoàn toàn.
- [ ] Gõ URL tay tới khu vực ngoài phạm vi → bị chặn/redirect.
