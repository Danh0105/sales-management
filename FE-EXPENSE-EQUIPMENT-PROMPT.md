# PROMPT: TÁCH ĐỀ XUẤT CHI THÀNH 2 LOẠI — ĐỀ XUẤT TIỀN & ĐỀ XUẤT THIẾT BỊ

Bạn là Senior Frontend Developer đang bảo trì module **Đề xuất chi** (đã có, xem [FE-EXPENSE-REQUEST-PROMPT.md](FE-EXPENSE-REQUEST-PROMPT.md)). Hãy cập nhật UI cho việc backend vừa tách đề xuất chi làm **2 loại**, và bổ sung màn hình cho **role mới: phòng kỹ thuật**.

Đây là thay đổi **cộng thêm**, backend đã chạy thật. Luồng đề xuất tiền hiện tại **không đổi một endpoint nào** — mọi đề xuất cũ mặc định là loại tiền.

---

## 0. Vì sao

Trước đây mọi đề xuất đều đi về kế toán → thủ quỹ để xuất tiền. Nhưng phần lớn đề xuất của kinh doanh là **xin thiết bị** (màn hình, loa, máy chiếu... cho trường), không phải xin tiền. Kinh doanh phải quy ra tiền rồi tự đi mua, còn kho thì không biết hàng đã xuất cho ai. Giờ hai việc này tách hẳn:

- **Đề xuất tiền** → kế toán công nợ lên **lệnh chi** → thủ quỹ xuất tiền (như cũ).
- **Đề xuất thiết bị** → phòng kỹ thuật lên **lệnh xuất kho** → giao thiết bị cho kinh doanh.

Bước **tạo** và bước **duyệt** vẫn dùng chung, chỉ tách nhánh **sau khi giám đốc/sales admin duyệt**.

---

## 1. Nền tảng (bổ sung vào mục 0 của prompt cũ)

- Trường mới của đề xuất: **`requestKind`** — `"CASH"` (đề xuất tiền) | `"EQUIPMENT"` (đề xuất thiết bị). Có mặt trong **mọi** response list/detail/my-tasks. Đề xuất cũ đều trả `"CASH"`.
- Role slug mới: **`ky_thuat`** (Phòng kỹ thuật). Nằm trong `user.roles` như các role khác.
- User test mới (password `123456`): **ky_thuat `0900000007`**. (Các user cũ giữ nguyên: sales `0900000001`, director `0900000002`, ketoan_congno `0900000003`, thuquy `0900000004`, saleadmin `0900000005`.)
- Mã chứng từ: lệnh chi `LC-YYYYMM-xxxx` (cũ), **lệnh xuất kho `XK-YYYYMM-xxxx`** (mới).

---

## 2. QUY TRÌNH — 2 NHÁNH

Chung: `(tạo) → PENDING_APPROVAL → APPROVED | REJECTED`

**Nhánh TIỀN (`requestKind = "CASH"`)** — không đổi:
```
APPROVED → PAYMENT_ORDERED → CASH_RELEASED → CASH_RECEIVED → SPENT ✓
                                                           ↘ NOT_SPENT → FUND_RETURNED
                                                                         └→ PAYMENT_ORDERED (lập lại lệnh chi)
```

**Nhánh THIẾT BỊ (`requestKind = "EQUIPMENT"`)** — mới:
```
APPROVED → STOCK_ISSUE_ORDERED → EQUIPMENT_RECEIVED → SPENT ✓ (đã lắp đặt/bàn giao)
                                                    ↘ NOT_SPENT → EQUIPMENT_RETURNED
                                                                  └→ STOCK_ISSUE_ORDERED (xuất kho lại)
```

| Bước | Trạng thái | Ai làm | Action |
|---|---|---|---|
| 1 | (tạo) | sales | → `PENDING_APPROVAL` |
| 2 | `PENDING_APPROVAL` | director / saleadmin | approve → `APPROVED` · reject → `REJECTED` |
| 3' | `APPROVED`, `EQUIPMENT_RETURNED` | **ky_thuat** | stock-issue-order → `STOCK_ISSUE_ORDERED` |
| 4' | `STOCK_ISSUE_ORDERED` | sales (chủ đơn) | equipment-received → `EQUIPMENT_RECEIVED` |
| 5' | `EQUIPMENT_RECEIVED` | sales (chủ đơn) | confirm-spent → `SPENT` · confirm-not-spent → `NOT_SPENT` |
| 6' | `NOT_SPENT` | **ky_thuat** | equipment-returned → `EQUIPMENT_RETURNED` |

**3 trạng thái mới**: `STOCK_ISSUE_ORDERED`, `EQUIPMENT_RECEIVED`, `EQUIPMENT_RETURNED`.
`SPENT` / `NOT_SPENT` / `REJECTED` / `WITHDRAWN` dùng chung cho cả hai loại (để thống kê không phải phân nhánh).

⚠️ **`APPROVED` và `NOT_SPENT` có mặt ở cả hai nhánh nhưng do bộ phận khác nhau giữ.** Luôn đọc kèm `requestKind` khi quyết định hiện nút nào:

| Trạng thái | `CASH` → của ai | `EQUIPMENT` → của ai |
|---|---|---|
| `APPROVED` | ketoan_congno (lên lệnh chi) | **ky_thuat** (lên lệnh xuất kho) |
| `NOT_SPENT` | thuquy (nhận lại quỹ) | **ky_thuat** (nhận lại thiết bị) |

Gọi sai nhánh backend trả **409** (`"Action ... không thuộc luồng của loại đề xuất ..."`).

---

## 3. API

### 3.1 Tạo đề xuất — thêm 1 field

**POST** `/expense-requests` (multipart, role `sales`) — như cũ, thêm:
```
requestKind: "CASH" | "EQUIPMENT"    // optional, bỏ trống = "CASH"
```
Các field còn lại giữ nguyên (`content`, `description`, `expectedPaymentDate`, `schoolId`+`schoolYear` hoặc `wardId`, `participants`, `beneficiaryInfo`, `file`). **Không** gửi `amount` — với đề xuất thiết bị thì mãi mãi không có `amount`, danh sách thiết bị nằm ở lệnh xuất kho do kỹ thuật lập.

### 3.2 PHÒNG KỸ THUẬT — Lên lệnh xuất kho

**POST** `/expense-requests/:id/stock-issue-order` (role `ky_thuat`, JSON)
```json
{
  "items": [
    { "name": "Màn hình tương tác 65\"", "quantity": 2, "unit": "cái", "note": "kèm chân đế" },
    { "name": "Dây HDMI 10m", "quantity": 2, "unit": "sợi" }
  ],
  "warehouse": "Kho Bình Dương",
  "expectedDeliveryDate": "2026-09-20",
  "note": "Giao trước ngày khai giảng"
}
```
- `items` bắt buộc, **tối thiểu 1 dòng**; mỗi dòng `name` (≤255 ký tự) + `quantity` (số nguyên > 0) bắt buộc, `unit` / `note` optional.
- `warehouse`, `expectedDeliveryDate` (YYYY-MM-DD), `note` optional.

```json
→ { "suggest": { "...": "...", "status": "STOCK_ISSUE_ORDERED" },
    "stockIssueOrder": { "id": 1, "code": "XK-202609-0001", "items": [...],
                         "warehouse": "...", "expectedDeliveryDate": "...", "note": "...",
                         "createdBy": 7, "createdAt": "..." } }
```
Lập lệnh mới khi đang ở `EQUIPMENT_RETURNED` sẽ **thay** lệnh xuất kho cũ (quan hệ 1-1), timeline vẫn giữ đủ lịch sử.

**POST** `/expense-requests/:id/equipment-returned` (role `ky_thuat`) — body `{ "note": "..." }` (optional) → `EQUIPMENT_RETURNED`.

### 3.3 SALES — Nhận thiết bị

**POST** `/expense-requests/:id/equipment-received` (role `sales`, chủ đơn) — body `{ "note": "..." }` (optional) → `EQUIPMENT_RECEIVED`.

Sau đó dùng lại **đúng 2 endpoint cũ**, không có endpoint riêng cho thiết bị:
- **POST** `/expense-requests/:id/confirm-spent` (multipart `files`, tối đa 5) → `SPENT` — với thiết bị nghĩa là "đã lắp đặt/bàn giao", ảnh nghiệm thu thay cho hoá đơn.
- **POST** `/expense-requests/:id/confirm-not-spent` — `{ "reason": "..." }` bắt buộc → `NOT_SPENT` (sẽ trả thiết bị về kho).

### 3.4 QUERY

**GET** `/expense-requests?requestKind=CASH|EQUIPMENT&status=&createdBy=&fromDate=&toDate=&overdue=&page=&limit=`
— thêm filter `requestKind`, các tham số cũ giữ nguyên. `GET /expense-requests/grouped-by-employee` cũng nhận `requestKind`.

**GET** `/expense-requests/:id` — response cũ, thêm:
```
requestKind: "CASH" | "EQUIPMENT",
stockIssueOrder: { id, code, items, warehouse, expectedDeliveryDate, note, creator, createdAt } | null,
equipmentReceivedAt, equipmentReturnedBy, equipmentReturnedAt
```
`paymentOrder` là `null` với đề xuất thiết bị, và ngược lại `stockIssueOrder` là `null` với đề xuất tiền.

**GET** `/expense-requests/my-tasks` — đã lọc sẵn theo role **và** theo `requestKind`, FE cứ render thẳng:
- `ketoan_congno` → CASH ở `APPROVED`, `FUND_RETURNED`
- `thuquy` → CASH ở `PAYMENT_ORDERED`, `NOT_SPENT`
- **`ky_thuat` → EQUIPMENT ở `APPROVED`, `EQUIPMENT_RETURNED`, `NOT_SPENT`**
- `director` / `saleadmin` → `PENDING_APPROVAL` (cả hai loại)
- `sales` (đơn của mình) → `CASH_RELEASED`, `CASH_RECEIVED`, `STOCK_ISSUE_ORDERED`, `EQUIPMENT_RECEIVED`

### 3.5 Notification

Không có type mới — vẫn `type = "SUGGEST"` + `meta.suggestType = "EXPENSE_REQUEST"`, socket vẫn `"suggest-notification:new"`. Chỉ khác nội dung: "🧰 Đề xuất thiết bị mới", "📦 Lệnh xuất kho mới", "📦 Thiết bị đã nhập lại kho". `meta` của lệnh xuất kho có `stockIssueOrderId`. Điều hướng vẫn theo `entityId`.

---

## 4. VIỆC CẦN LÀM Ở UI

### 4.1 Toàn module
- **Tab / filter loại đề xuất** ở đầu danh sách: `Tất cả` · `Đề xuất tiền` · `Đề xuất thiết bị` → map sang `?requestKind=`.
- **Badge loại** cạnh mã đề xuất trong list & detail: 💰 `Tiền` / 🧰 `Thiết bị` (màu khác nhau, đọc từ `requestKind`).
- **Cột số tiền**: đề xuất thiết bị không có `amount` → hiện `—`, đừng hiện `0 ₫`.
- **Badge trạng thái** — thêm 3 màu: `STOCK_ISSUE_ORDERED` tím · `EQUIPMENT_RECEIVED` xanh nhạt · `EQUIPMENT_RETURNED` xanh ✓. Nhãn tiếng Việt: "Đã lên lệnh xuất kho" · "Đã nhận thiết bị" · "Đã nhập lại kho". Với `SPENT`, nhãn đổi theo loại: tiền → "Đã chi", thiết bị → "Đã bàn giao". `NOT_SPENT`: tiền → "Chưa chi", thiết bị → "Chưa dùng".
- **Nút hành động ở màn chi tiết phải quyết định theo `(requestKind, status, roles, có phải chủ đơn)`** — không chỉ theo `status`. Đây là chỗ dễ sai nhất của thay đổi này.

### 4.2 SALES
- Form tạo: thêm chọn loại đề xuất ở **đầu form** (radio/segmented `Đề xuất tiền` / `Đề xuất thiết bị`), mặc định `Đề xuất tiền`. Đổi lựa chọn thì chỉ đổi phần mô tả gợi ý — các field còn lại y hệt nhau. Với thiết bị, đổi nhãn `expectedPaymentDate` thành **"Ngày cần có thiết bị"**, và gợi ý liệt kê thiết bị mong muốn trong `description`.
- Chi tiết đơn thiết bị:
  - `STOCK_ISSUE_ORDERED` → hiện bảng lệnh xuất kho (`stockIssueOrder.items`) + nút **[Xác nhận đã nhận thiết bị]**
  - `EQUIPMENT_RECEIVED` → **[Đã bàn giao/lắp đặt (upload ảnh nghiệm thu)]** · **[Chưa dùng (nhập lý do)]**
  - `NOT_SPENT` → hiện "Chờ phòng kỹ thuật nhận lại thiết bị", không có nút.

### 4.3 PHÒNG KỸ THUẬT (`ky_thuat`) — màn hình mới
- Vào được menu "Đề xuất chi" (chỉ thấy đề xuất thiết bị là đủ, mặc định filter `requestKind=EQUIPMENT`).
- **Chờ lên lệnh xuất kho** (`?requestKind=EQUIPMENT&status=APPROVED` + `EQUIPMENT_RETURNED`): form lệnh xuất kho với **bảng items thêm/xoá dòng được** (tên, số lượng, đơn vị, ghi chú) + kho + ngày giao dự kiến + ghi chú → **[Lên lệnh xuất kho]**.
- **Thiết bị chờ nhận lại** (`?requestKind=EQUIPMENT&status=NOT_SPENT`): xem `notSpentReason` → **[Xác nhận đã nhập lại kho]**.
- **My Tasks** + chuông thông báo như các role khác.

### 4.4 Các role khác
- **ketoan_congno / thuquy**: không thấy đề xuất thiết bị trong việc cần làm nữa (backend đã lọc). Nếu màn hình đang hard-code `?status=APPROVED` thì **thêm `&requestKind=CASH`**, không thì kế toán vẫn thấy đơn thiết bị rồi bấm vào nhận 409.
- **director / saleadmin**: duyệt cả hai loại ở cùng một chỗ, chỉ cần thấy badge loại; nên có filter theo loại trong màn thống kê.

---

## 5. Validate & lỗi

- Form lệnh xuất kho: `items` ≥ 1 dòng, mỗi dòng `name` không rỗng & `quantity` nguyên > 0; `expectedDeliveryDate` đúng `YYYY-MM-DD`.
- **409** → "Trạng thái đã thay đổi hoặc thao tác không thuộc loại đề xuất này, vui lòng tải lại" + reload chi tiết.
- **403** → ẩn nút; các lý do: sai role, không phải chủ đơn, tự duyệt đơn của mình, hoặc vừa làm bước liền trước (quy tắc phân tách nhiệm vụ giữ nguyên cho cả hai nhánh — người kiêm `sales` + `ky_thuat` không tự lên lệnh xuất kho cho đơn của chính mình).
- Xoá đề xuất (director): đơn thiết bị đã ở `STOCK_ISSUE_ORDERED` trở đi thì **400** — ẩn nút xoá ở các trạng thái đó.

---

## 6. Kiểm thử tay (login bằng phone, password `123456`)

1. `0900000001` (sales) tạo đề xuất **thiết bị** → thấy badge 🧰, không có ô số tiền.
2. `0900000002` (director) duyệt → `APPROVED`.
3. `0900000003` (ketoan_congno) mở my-tasks → **không** thấy đơn này.
4. `0900000007` (ky_thuat) thấy đơn ở "Chờ lên lệnh xuất kho" → lập lệnh 2 dòng thiết bị → `STOCK_ISSUE_ORDERED`, mã `XK-...`.
5. `0900000001` xác nhận đã nhận → `EQUIPMENT_RECEIVED` → bấm "Chưa dùng" + lý do → `NOT_SPENT`.
6. `0900000007` xác nhận nhập lại kho → `EQUIPMENT_RETURNED` → lập lại lệnh xuất kho được.
7. Tạo thêm 1 đề xuất **tiền** → toàn bộ luồng cũ chạy y như trước, không lệch bước nào.

---

Tài liệu API chi tiết từ BE: [EXPENSE-REQUEST-API.md](EXPENSE-REQUEST-API.md) · Prompt gốc của module: [FE-EXPENSE-REQUEST-PROMPT.md](FE-EXPENSE-REQUEST-PROMPT.md)
