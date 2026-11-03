# Thu Chi ngoài — hợp đồng thu chi khác

Tab "Thu Chi ngoài" trong màn Chính sách: hợp đồng thu chi không thuộc chính sách trường. Một
hợp đồng gồm **nhiều khoản thu và nhiều khoản chi**, mỗi khoản có thuế VAT riêng; hệ thống tính
lợi nhuận đem về.

```
NV kinh doanh lập (PENDING) ──► Giám đốc duyệt ──► APPROVED ──► thu/chi qua quỹ (nhiều lần)
        ▲                           │                              │
        └── sửa & gửi lại ◄── REJECTED (bắt buộc lý do)            ▼
                                     IN_PROGRESS ──► COMPLETED (thu đủ VÀ chi đủ)
Huỷ (CANCELLED): người lập khi PENDING/REJECTED; giám đốc khi APPROVED mà chưa thu/chi đồng nào.
```

## Khoản thu, khoản chi, thuế, lợi nhuận

Mỗi khoản (thu hoặc chi): nội dung, mã hàng (tuỳ chọn), ĐVT, số lượng, đơn giá, thuế suất VAT
(`vatRate`: không thuế = trống, hoặc 0/5/8/10%). Khoản chi có thêm người nhận (tuỳ chọn).
Backend tính lại mọi số tiền:

- thành tiền chưa thuế `amount` = SL × đơn giá, làm tròn nửa lên tới đồng;
- tiền thuế `vatAmount` = `amount` × thuế suất / 100, làm tròn nửa lên tới đồng;
- `totalAmount` = `amount` + `vatAmount` — số thực thu / thực chi qua quỹ.

Hợp đồng: `amount` = tổng phải thu gồm thuế (Σ khoản thu), `costAmount` = tổng phải chi gồm
thuế (Σ khoản chi), kèm `incomeVatAmount` (VAT đầu ra) / `costVatAmount` (VAT đầu vào).
API trả thêm `incomeNetAmount`, `costNetAmount`, `vatPayable` (= đầu ra − đầu vào) và

```
profit = (amount − incomeVatAmount) − (costAmount − costVatAmount)   // thu chưa thuế − chi chưa thuế
```

VAT là tiền thu hộ / nộp hộ nhà nước nên không tính vào lợi nhuận. Cần ít nhất một khoản; hợp
đồng chỉ có khoản chi thì `amount` = 0 (lợi nhuận âm).

## Hình thức — luồng tiền sau khi duyệt

- **Thông thường** (`form = STANDARD`): thủ quỹ thu trực tiếp trên tổng phải thu, và chi
  trực tiếp từng khoản chi (`POST /:id/entries` với `flow` `IN`, hoặc `OUT` + `costId`), nhiều
  lần tới đủ; không vượt số còn lại.
- **Thương mại** (`form = COMMERCIAL`, đơn đặt hàng / hợp đồng bán hàng): đi luồng công nợ như
  Đề xuất chi.

```
Giám đốc duyệt ──► Kế toán công nợ lập phiếu thu (tổng phải thu, từng đợt) / lệnh chi (từng khoản chi)
               ──► Thủ quỹ thu/chi đúng số trên phiếu (ngày, TK, chứng từ)
```
- Phiếu đang chờ được trừ vào số còn lập được (không lập vượt). KT công nợ huỷ được phiếu
  đang chờ (có lý do). Thủ quỹ huỷ một lần thu/chi → phiếu đó quay về "chờ".
- Thủ quỹ không ghi nhận trực tiếp đơn Thương mại; giám đốc không huỷ đơn còn phiếu chưa huỷ.

## Vai trò (`other-cashflow.constants.ts`, kiểm tra trong `other-cashflow-access.ts`)

| Việc                         | Vai trò                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Lập, sửa/gửi lại, huỷ, tệp HĐ | `sales`, `employee`, `employee_la` — chỉ thấy hợp đồng mình lập          |
| Duyệt / từ chối / huỷ        | `director`, `director_la`                                               |
| Lập/huỷ phiếu thu, lệnh chi (Thương mại) | `ketoan_congno`, `ketoan_truong`                            |
| Thu/chi trực tiếp hoặc theo phiếu, huỷ lần thu/chi, chứng từ | `thuquy`, `ketoan_truong`               |
| Chỉ xem tất cả               | `troly_gd`, `accountant`, sale admin                                    |

Kế toán trưởng có toàn quyền KT công nợ + thủ quỹ — cùng quy ước với Đề xuất chi.

## Dữ liệu

Migration `1794700000000-add-other-cashflow` (7 bảng `other_cashflow_*`) và
`1795300000000-other-cashflow-merge-lines` (gộp thu chi + thuế):

- `other_cashflow_contracts`: tên, đối tác, trường (tuỳ chọn), `form`, `document_no`, ngày ký,
  ngày dự kiến, ghi chú, trạng thái, `amount` / `income_vat_amount`, `cost_amount` /
  `cost_vat_amount`, `recorded_amount` (đã thu) và `paid_cost_amount` (đã chi) — cập nhật
  trong cùng transaction có khoá dòng; CHECK đã thu ≤ phải thu, đã chi ≤ phải chi.
  `direction` (`IN`/`OUT`) chỉ còn ở hợp đồng lập trước khi gộp; hợp đồng mới hoặc đã sửa lại
  để trống.
- `other_cashflow_items` (khoản thu) và `other_cashflow_costs` (khoản chi, thêm `paid_amount`
  ≤ `total_amount`): `item_code`, nội dung, `unit`, `quantity` numeric(15,4), `unit_price`
  numeric(18,2), `amount`, `vat_rate`, `vat_amount`, `total_amount`. Chỉ thay được cả bộ khi
  hợp đồng chờ duyệt / bị từ chối (không gửi lại thì giữ nguyên).
- `other_cashflow_orders`: phiếu thu `RECEIPT` (không gắn khoản) / lệnh chi `PAYMENT` (gắn
  khoản chi); `PENDING`/`EXECUTED`/`CANCELLED`.
- `other_cashflow_entries`: mỗi lần thủ quỹ thu/chi — `flow` (`IN`/`OUT`), `cost_id` (mọi lần
  chi), `order_id` (Thương mại), ngày (không sau hôm nay), số tiền, tài khoản trong
  `cash_accounts` (đang dùng), `idempotency_key` duy nhất. Sai thì huỷ (`VOIDED` + lý do),
  không sửa/xoá.
- `other_cashflow_attachments`: tệp hợp đồng (`CONTRACT`) và chứng từ (`EVIDENCE`, gắn lần
  thu/chi). PDF/ảnh, ≤ 10MB/tệp, ≤ 30 tệp/hợp đồng. Lưu trong kho tệp riêng của phân hệ tài
  chính (`FINANCIAL_STORAGE_DIR`, thư mục `other-cashflow/`), chỉ tải qua API có kiểm quyền.
- `other_cashflow_events`: nhật ký thao tác.

Migration 1795300000000 đổi dữ liệu cũ tại chỗ, số đã thu/chi giữ nguyên: HĐ Thu thông thường →
1 khoản thu (SL 1 × số tiền, không thuế); HĐ Chi thông thường → 1 khoản chi cùng tên hợp đồng
(đã chi chuyển sang `paid_cost_amount`, các lần chi gắn `cost_id`); đơn Thương mại giữ dòng
hàng/chi phí, chi phí thành SL 1 × số tiền.

## API (`/other-cashflows`, JWT)

`GET /` (lọc `status`, `form`, `search`, `page`, `limit`; trả `counts` theo trạng thái và
`meta` quyền) · `POST /` · `GET /:id` (kèm `permissions`) · `PATCH /:id` · `POST /:id/cancel` ·
`POST /:id/review` · `POST /:id/entries` · `POST /:id/entries/:entryId/void` ·
`POST /:id/orders` · `POST /:id/orders/:orderId/cancel` · `POST /:id/orders/:orderId/execute` ·
`POST /:id/attachments` (`files[]`, `entryId` tuỳ chọn) · `DELETE /:id/attachments/:aid` ·
`GET /:id/attachments/:aid/file`.

## Thông báo

Loại `POLICY` (hiện trong nhóm Chính sách của chuông) với `meta.kind = "other_cashflow"` +
`meta.contractId`, **không** đặt `entityId` để không trùng id chính sách thật. FE mở
`/director|/employee/other-cashflows?contract=<id>`. Gửi duyệt → giám đốc; duyệt → người lập
+ thủ quỹ (Thương mại: + KT công nợ thay vì thủ quỹ); lập phiếu → thủ quỹ; thu/chi theo
phiếu → người lập + người lập phiếu; từ chối/huỷ/thu/chi trực tiếp → người lập. Chốt
duyệt/từ chối/huỷ thì đánh dấu đã đọc các thông báo "cần duyệt" của hợp đồng đó.

## Báo cáo Tổng hợp thu chi

Mỗi lần thu/chi còn hiệu lực là một bút toán (`cashflow-report/other-cashflow-source.ts`),
xem `CASHFLOW-REPORT.md` mục 1.

## Triển khai

Chạy migration (SQL dưới `SET ROLE sales_owner`) **trước** khi restart BE: báo cáo thu chi đọc
các bảng `other_cashflow_*`, thiếu bảng/cột thì cả báo cáo lỗi. `down()` của 1795300000000 chỉ
chạy được khi chưa có hợp đồng kiểu mới (`direction` trống hoặc có thuế) — sau khi đã dùng thì
không quay về cấu trúc cũ được.

Kiểm thử tích hợp: `OTHER_CASHFLOW_IT_DB=<db test đã chạy migration> npx jest --config
./test/jest-e2e.json test/other-cashflow.e2e-spec.ts`.
