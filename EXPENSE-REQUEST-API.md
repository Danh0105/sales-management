# MODULE ĐỀ XUẤT CHI (EXPENSE REQUEST WORKFLOW)

Quy trình duyệt chi nhiều bước + thông báo real-time (socket + FCM) + báo động theo ngày dự kiến chi.

> **Kiến trúc:** module này **không có service riêng** — nó dùng chung **`SuggestService`** và **bảng `suggest`**, phân biệt bằng cột `type = 'EXPENSE_REQUEST'` (mặc định `'SUGGESTION'` cho luồng đề xuất thường cũ). Code nằm trong [src/suggest/](src/suggest/).

---

## 1. Vai trò (role slugs trong `employee.roles`)

| Role slug | Vai trò | Quyền trong quy trình |
|---|---|---|
| `sales` | Kinh doanh | Tạo/sửa/gửi đề xuất, xác nhận nhận tiền, xác nhận đã chi / chưa chi (chỉ chính chủ đề xuất) |
| `director` | Giám đốc | Duyệt / từ chối; cấu hình báo động |
| `ketoan_congno` | Kế toán công nợ | Lên lệnh chi |
| `thuquy` | Thủ quỹ | Xác nhận đã xuất tiền, xác nhận đã nhận lại quỹ |
| `saleadmin` | Sales Admin | Chỉ nhận thông báo theo dõi |

---

## 2. State machine (dùng chung enum `SuggestStatus`)

```
(tạo đề xuất) → PENDING_APPROVAL → APPROVED → PAYMENT_ORDERED → CASH_RELEASED
      → CASH_RECEIVED → SPENT               (kết thúc - đã chi)
                       ↘ NOT_SPENT → FUND_RETURNED ─┐
                                      ↑             │
                                      └─ PAYMENT_ORDERED (kế toán lập lại lệnh chi)
PENDING_APPROVAL → REJECTED                 (kết thúc - bị từ chối)
```

- **Không có bước DRAFT/submit riêng** — kinh doanh tạo đề xuất là vào thẳng `PENDING_APPROVAL` và báo Giám đốc ngay.
- Mỗi bước chạy trong **transaction** + **lock row** (`pessimistic_write`) → thao tác lại ở trạng thái không hợp lệ trả **409 Conflict**; sai role/không phải chủ đề xuất trả **403 Forbidden**.
- **Audit log** ghi vào bảng `suggest_history` (tái sử dụng): `action`, `fromStatus`, `toStatus`, `note`, `userId`.
- Mã tự sinh: đề xuất `DX-YYYYMM-xxxx` (cột `suggest.code`), lệnh chi `LC-YYYYMM-xxxx` (advisory lock, không trùng khi song song).
- Luồng `SUGGESTION` cũ (PENDING → REVIEWED → APPROVED) **không bị ảnh hưởng**; các API list cũ (`/suggest`, `/suggest/my-suggests`) đã lọc `type = SUGGESTION`.

---

## 3. Endpoints (Bearer JWT bắt buộc)

Base path: `/expense-requests` (project không dùng prefix `/api`). Controller mỏng `ExpenseRequestController` → gọi `SuggestService`.

| Method | Path | Role | Mô tả |
|---|---|---|---|
| POST | `/expense-requests` | sales | Tạo đề xuất → **PENDING_APPROVAL ngay**, báo Giám đốc. Multipart: fields + `file` (1 file, optional) |
| POST | `/expense-requests/:id/approve` | director | → APPROVED, báo thuquy + saleadmin + ketoan_congno + người tạo |
| POST | `/expense-requests/:id/reject` | director | Body `{ "reason": "..." }` → REJECTED, báo người tạo |
| POST | `/expense-requests/:id/payment-order` | ketoan_congno | Từ APPROVED hoặc FUND_RETURNED; body `{ amount, paymentMethod: "CASH"\|"BANK_TRANSFER", note? }` → PAYMENT_ORDERED, báo thủ quỹ |
| POST | `/expense-requests/:id/cash-released` | thuquy | Body `{ note? }` + `files[]` chứng từ → CASH_RELEASED, báo người tạo |
| POST | `/expense-requests/:id/cash-received` | sales (chủ) | → CASH_RECEIVED |
| POST | `/expense-requests/:id/confirm-spent` | sales (chủ) | Body `{ note? }` + `files[]` hóa đơn → SPENT (kết thúc) |
| POST | `/expense-requests/:id/confirm-not-spent` | sales (chủ) | Body `{ "reason": "..." }` → NOT_SPENT, báo thủ quỹ |
| POST | `/expense-requests/:id/fund-returned` | thuquy | → FUND_RETURNED (kết thúc) |
| GET | `/expense-requests` | mọi role | Filter: `status, createdBy, fromDate, toDate, overdue, page, limit` |
| GET | `/expense-requests/:id` | mọi role | Chi tiết + logs + payment order + attachments |
| GET | `/expense-requests/my-tasks` | mọi role | Việc cần làm theo role (xem mục 5) |
| GET | `/expense-requests/reminder-settings` | mọi role | `{ remindBeforeDays, enabled }` |
| PATCH | `/expense-requests/reminder-settings` | director | Body `{ "remindBeforeDays": 1, "enabled": false }` (có thể gửi từng trường) |
| POST | `/expense-requests/reminders/run` | director | Chạy tay job báo động (test) |

### Tạo đề xuất — body (form dùng chung với suggest)

Fields bắt buộc: `content` (tiêu đề/nội dung), `expectedPaymentDate` (YYYY-MM-DD — mốc báo động, **phải ≥ hôm nay**). Số tiền chưa được nhập ở bước tạo đề xuất; kế toán nhập `amount` khi lập lệnh chi.
Optional: `description` (lý do chi tiết), `beneficiaryInfo`, `participants` (thành phần tham gia), `schoolId` (trường liên quan — nếu gửi mà không tồn tại → 400), `file`.

> **Dùng lại hàm `create`:** không còn `createExpense()` riêng — `SuggestService.create()` tự rẽ nhánh khi `dto.type = "EXPENSE_REQUEST"`. Vì vậy cũng có thể tạo qua **`POST /suggest`** (form suggest cũ) bằng cách gửi thêm `type: "EXPENSE_REQUEST"`. Cả hai đường đều tạo đề xuất ở trạng thái `PENDING_APPROVAL` và báo Giám đốc.

### Response đặc biệt

- `POST .../payment-order` trả `{ "suggest": {...}, "paymentOrder": {...} }`.
- `GET /expense-requests/:id` trả object đề xuất kèm `logs`, `paymentOrder`, `attachments`, `participants`, `school { id, name }`.
- `GET /expense-requests` và `/my-tasks`: mỗi item có thêm `participants` và `school { id, name }`.

### Notification API (nằm chung trong phần "đề xuất", `type = SUGGEST`)

- Thông báo đề xuất chi dùng chung **`type = SUGGEST`** (hiển thị trong phần "đề xuất"), phân biệt bằng **`meta.suggestType = "EXPENSE_REQUEST"`**.
- `GET /notifications?type=SUGGEST`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`
- `entityId` = id đề xuất (= id suggest), `meta.suggestId` + `meta.suggestType` → FE điều hướng sang màn đề xuất chi.
- Socket event: `suggest-notification:new` (room `user_{id}`). FCM `data = { type: 'expense_request', id, url }`.

---

## 4. Báo động theo ngày chi (cron 08:00 Asia/Ho_Chi_Minh)

`@Cron` nằm trong `SuggestService.handleExpenseReminders()`:

| Điều kiện | Nhận cảnh báo |
|---|---|
| Trước ngày chi ≤ `remindBeforeDays` (mặc định 1) và còn `PENDING_APPROVAL` | Giám đốc |
| Trước ngày chi và còn `APPROVED` (chưa lên lệnh chi) | Kế toán công nợ |
| Đúng ngày chi | Actor đang giữ bước hiện tại |
| Quá ngày chi (mỗi ngày) | Actor đang giữ bước + Giám đốc; set `isOverdue = true` |

Actor giữ bước: `PENDING_APPROVAL` → director, `APPROVED` → ketoan_congno, `PAYMENT_ORDERED`/`NOT_SPENT` → thuquy, `DRAFT`/`CASH_RELEASED`/`CASH_RECEIVED` → người tạo (sales).

---

## 5. My-tasks

`GET /expense-requests/my-tasks` — lọc `type = EXPENSE_REQUEST` theo role hiện tại, sắp overdue trước rồi ngày chi gần nhất:

- `director`: `PENDING_APPROVAL`
- `ketoan_congno`: `APPROVED`, `FUND_RETURNED`
- `thuquy`: `PAYMENT_ORDERED`, `NOT_SPENT`
- `sales`: đề xuất của mình ở `CASH_RELEASED`, `CASH_RECEIVED`

---

## 6. Database (TypeORM `synchronize: true`)

- `suggest` — mở rộng thêm cột cho đề xuất chi: `type`, `code`, `expectedPaymentDate`, `beneficiaryInfo`, `participants`, `school_id` (FK → `schools.id`), `isOverdue`, `approvedAt`, `cashReleasedBy/At`, `cashReceivedAt`, `spentAt`, `notSpentReason`, `fundReturnedBy/At`, quan hệ `paymentOrder` + `attachments` + `school`. (Các cột cũ giữ nguyên; `content` = tiêu đề, `amount`, `description`.)
- `suggest_history` — audit trail (thêm `fromStatus`, `toStatus`, `note`)
- `suggest_payment_order` — lệnh chi (code, suggestId unique, amount, paymentMethod, note, createdBy)
- `suggest_attachment` — file đính kèm (`/uploads/suggest/...`)
- `suggest_reminder_setting` — key-value (`remind_before_days`, `expense_reminders_enabled`). Khi `enabled = false`, cron và API chạy tay đều không truy vấn đề xuất hay phát cảnh báo đến hạn.

> ⚠️ Các bảng cũ `expense_request*` / `payment_order` (từ bản module riêng đã bỏ) nay **mồ côi**, có thể DROP thủ công.

---

## 7. Seed & test

```bash
# 5 user test (password 123456): phone 0900000001→0900000005
npm run seed:expense-users

# Unit test state machine (15 test, đủ nhánh: duyệt/từ chối/đã chi/chưa chi→hoàn quỹ, sai role, sai status, ownership)
npx jest expense-flow.state-machine
```
