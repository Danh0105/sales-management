# Thu Chi ngoài — hợp đồng thu/chi khác

Tab "Thu Chi ngoài" trong màn Chính sách: hợp đồng thu/chi không thuộc chính sách trường.

```
NV kinh doanh lập (PENDING) ──► Giám đốc duyệt ──► APPROVED ──► Thủ quỹ ghi nhận nhiều lần
        ▲                           │                              │
        └── sửa & gửi lại ◄── REJECTED (bắt buộc lý do)            ▼
                                                IN_PROGRESS ──► COMPLETED (đủ số tiền)
Huỷ (CANCELLED): người lập khi PENDING/REJECTED; giám đốc khi APPROVED mà chưa ghi nhận đồng nào.
```

**Thu khác — hình thức Thương mại** (`form = COMMERCIAL`, chỉ cho Thu): đơn đặt hàng / hợp
đồng bán hàng có dòng hàng (mã hàng, tên, ĐVT, SL, đơn giá → thành tiền = SL × đơn giá làm
tròn đồng, backend tính) và các khoản chi phí công ty phải chi (vận chuyển, hoa hồng…). Số
tiền hợp đồng = tổng tiền hàng (phải thu); lãi gộp = tiền hàng − chi phí. Sau khi duyệt đi
luồng công nợ như Đề xuất chi:

```
Giám đốc duyệt ──► Kế toán công nợ lập phiếu thu (tiền hàng, từng đợt) / lệnh chi (từng khoản chi phí)
               ──► Thủ quỹ thu/chi đúng số trên phiếu (ngày, TK, chứng từ)
Hoàn tất khi đã thu đủ tiền hàng VÀ đã chi đủ chi phí.
```
- Phiếu đang chờ được trừ vào số còn lập được (không lập vượt). KT công nợ huỷ được phiếu
  đang chờ (có lý do). Thủ quỹ huỷ một lần thu/chi → phiếu đó quay về "chờ".
- Thủ quỹ không ghi nhận trực tiếp đơn Thương mại; giám đốc không huỷ đơn còn phiếu chưa huỷ.

## Vai trò (`other-cashflow.constants.ts`, kiểm tra trong `other-cashflow-access.ts`)

| Việc                         | Vai trò                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Lập, sửa/gửi lại, huỷ, tệp HĐ | `sales`, `employee`, `employee_la` — chỉ thấy hợp đồng mình lập          |
| Duyệt / từ chối / huỷ        | `director`, `director_la`                                               |
| Lập/huỷ phiếu thu, lệnh chi (đơn Thương mại) | `ketoan_congno`, `ketoan_truong`                        |
| Ghi nhận / thu-chi theo phiếu, huỷ lần thu/chi, chứng từ | `thuquy`, `ketoan_truong`                   |
| Chỉ xem tất cả               | `troly_gd`, `accountant`, sale admin                                    |

Kế toán trưởng có toàn quyền KT công nợ + thủ quỹ — cùng quy ước với Đề xuất chi.

## Dữ liệu (migration `1794700000000-add-other-cashflow`, 7 bảng mới, không sửa bảng cũ)

- `other_cashflow_contracts`: loại `IN`/`OUT`, tên, đối tác, trường (tuỳ chọn), số tiền
  (bigint đồng), ngày ký, ngày dự kiến, ghi chú, trạng thái, `recorded_amount` (tổng các lần
  ghi nhận còn hiệu lực, cập nhật trong cùng transaction có khoá dòng; CHECK ≤ `amount`).
- `other_cashflow_items` (dòng hàng), `other_cashflow_costs` (chi phí, `paid_amount`),
  `other_cashflow_orders` (phiếu thu `RECEIPT` / lệnh chi `PAYMENT` gắn chi phí;
  `PENDING`/`EXECUTED`/`CANCELLED`). Hợp đồng thêm `form`, `document_no`, `cost_amount`,
  `paid_cost_amount`.
- `other_cashflow_entries`: mỗi lần thủ quỹ thu/chi — `flow` (`IN`/`OUT` của chính lần đó),
  `order_id`/`cost_id` (đơn Thương mại), ngày (không sau hôm nay), số tiền (không vượt số còn
  lại; theo phiếu thì đúng số phiếu), tài khoản trong `cash_accounts` (đang dùng),
  `idempotency_key` duy nhất. Sai thì huỷ (`VOIDED` + lý do), không sửa/xoá.
- `other_cashflow_attachments`: tệp hợp đồng (`CONTRACT`) và chứng từ (`EVIDENCE`, gắn lần
  ghi nhận). PDF/ảnh, ≤ 10MB/tệp, ≤ 30 tệp/hợp đồng. Lưu trong kho tệp riêng của phân hệ tài
  chính (`FINANCIAL_STORAGE_DIR`, thư mục `other-cashflow/`), chỉ tải qua API có kiểm quyền.
- `other_cashflow_events`: nhật ký thao tác.

## API (`/other-cashflows`, JWT)

`GET /` (lọc `status`, `direction`, `search`, `page`, `limit`; trả `counts` theo trạng thái và
`meta` quyền) · `POST /` · `GET /:id` (kèm `permissions`) · `PATCH /:id` · `POST /:id/cancel` ·
`POST /:id/review` · `POST /:id/entries` · `POST /:id/entries/:entryId/void` ·
`POST /:id/orders` · `POST /:id/orders/:orderId/cancel` · `POST /:id/orders/:orderId/execute` ·
`POST /:id/attachments` (`files[]`, `entryId` tuỳ chọn) · `DELETE /:id/attachments/:aid` ·
`GET /:id/attachments/:aid/file`.

## Thông báo

Loại `POLICY` (hiện trong nhóm Chính sách của chuông) với `meta.kind = "other_cashflow"` +
`meta.contractId`, **không** đặt `entityId` để không trùng id chính sách thật. FE mở
`/director|/employee/other-cashflows?contract=<id>`. Gửi duyệt → giám đốc; duyệt → người lập
+ thủ quỹ (đơn Thương mại: + KT công nợ thay vì thủ quỹ); lập phiếu → thủ quỹ; thu/chi theo
phiếu → người lập + người lập phiếu; từ chối/huỷ/ghi nhận → người lập. Chốt duyệt/từ chối/huỷ thì đánh dấu đã đọc các
thông báo "cần duyệt" của hợp đồng đó.

## Báo cáo Tổng hợp thu chi

Mỗi lần ghi nhận còn hiệu lực là một bút toán (`cashflow-report/other-cashflow-source.ts`),
xem `CASHFLOW-REPORT.md` mục 1.

## Triển khai

Chạy migration 1794700000000 (SQL dưới `SET ROLE sales_owner`) **trước** khi restart BE:
báo cáo thu chi đọc bảng `other_cashflow_entries`, thiếu bảng thì cả báo cáo lỗi.
Gỡ: `down()` xoá 4 bảng (mất dữ liệu Thu Chi ngoài) — chỉ sau khi BE đã về bản cũ.

Kiểm thử tích hợp: `OTHER_CASHFLOW_IT_DB=<db test đã chạy migration> npx jest --config
./test/jest-e2e.json test/other-cashflow.e2e-spec.ts`.
