# Báo cáo tổng hợp thu chi — nguồn dữ liệu và quy tắc tổng hợp

Module: `src/cashflow-report/` (backend), `kido-app/src/pages/Director/CashflowReport/` (giao diện).
Route giao diện: `/director/cashflow-report` (menu "Tổng hợp thu chi").

Giao diện và file Excel cùng gọi một bộ hàm tổng hợp ở backend
(`CashflowReportService.buildDataset`), nên số liệu trên màn hình và trong file là một.

## 1. Nguồn dữ liệu

Hệ thống không có sổ quỹ hay bảng phiếu thu/chi riêng. Báo cáo đọc thẳng các nghiệp vụ
đang có, không tạo bảng giao dịch song song.

| Nguồn | Bảng | Bút toán | Ngày hạch toán | Tài khoản | Số tiền |
|---|---|---|---|---|---|
| Hóa Đơn | `revenue_items` | Thu (`IN`) hoặc Chi (`OUT`) | `invoicePaymentDate` ("Ngày chi") | `invoiceCashAccount` ("Khoản thu/chi") | `invoiceCashAmount` ("Số tiền thu/chi", kế toán nhập) |
| Chi Trường | `school_expense_items` | Chi | `expenseDate` | `cashAccount` ("Nguồn chi") | `paidAmount` ("Đã chi") |
| Chi Ngoài | `management_expense_items` | Chi | `expenseDate` | `cashAccount` ("Nguồn chi") | `paidAmount` ("Đã chi") |
| Đề xuất chi: xuất tiền | `suggest_history` (`CONFIRM_CASH_RELEASED`) | Chi | ngày của sự kiện | `data.cashAccount`; lần xuất cuối cùng lấy thêm từ `suggest_payment_order.cashAccount` | snapshot lệnh chi gần nhất trước lần xuất (`CREATE_PAYMENT_ORDER.data.paymentOrder.amount`), nếu không có thì lấy số tiền lệnh chi hiện tại |
| Đề xuất chi: nhận lại quỹ | `suggest_history` (`CONFIRM_FUND_RETURNED`) | Thu | ngày của sự kiện | cùng tài khoản với lần xuất đang mở | cùng số tiền với lần xuất đang mở |

- "Đã thu" (`revenue_items.paidAmount`) **không** được cộng thẳng vào sổ: chỉ khoản ở
  Hóa Đơn được tính, để không ghi trùng. Dòng có Đã thu mà chưa có khoản Thu ở Hóa Đơn sẽ
  hiện cảnh báo `RECEIPT_NOT_POSTED`.
- Số chứng từ: Đề xuất chi dùng mã lệnh chi (`LC-…`). Dòng Hóa Đơn / Chi Trường / Chi Ngoài
  chưa có số chứng từ trong hệ thống, nên báo cáo sinh mã
  `HD|CT|CN-<phiếu thu chi>-<môn>-<dòng>`.
- Đối tượng: trường → `TR<id>`; người đề xuất → `NV<id>`. Trường và nhân viên chưa có cột
  mã riêng.
- Ngày: tính theo giờ Việt Nam (timezone của DB là `Asia/Ho_Chi_Minh`). Khoảng ngày lọc
  tính cả ngày đầu và ngày cuối.

## 2. Danh mục tài khoản và số dư gốc

Bảng `cash_accounts` (migration `1794100000000`) gồm mã (định danh ổn định), tên,
nhóm `111` / `112`, thứ tự, trạng thái sử dụng, và số dư gốc kèm ngày đối chiếu. Migration
seed 13 tài khoản từ `INVOICE_CASH_ACCOUNTS`, số dư gốc để NULL.

- Số dư gốc là số dư tại **đầu** ngày đối chiếu. Chỉ kế toán trưởng / giám đốc sửa được
  (`PATCH /reports/cashflow/accounts/:code`). Người và thời điểm sửa được lưu trên dòng;
  activity log ghi request.
- Chưa có số dư gốc thì dư đầu/cuối của tài khoản là `null` ("Chưa xác minh"),
  **không** coi là 0. Tổng dư đầu/cuối kỳ cũng là `null` khi trong phạm vi còn tài khoản
  chưa xác minh. Giao diện vẫn hiện riêng tổng của các tài khoản đã xác minh.
- Tài khoản ngừng sử dụng vẫn hiện trên sổ nếu còn số dư hoặc còn phát sinh trong kỳ.
- Giới hạn: kiểm tra mã ở các ô nhập (Hóa Đơn, Chi Trường, Chi Ngoài, xuất tiền) vẫn dùng
  danh sách trong code. Thêm tài khoản mới hiện phải thêm cả dòng `cash_accounts` lẫn
  `INVOICE_CASH_ACCOUNTS` (BE) và `invoiceCashAccounts.ts` (FE).

## 3. Quy tắc tính (hàm thuần trong `cashflow-ledger.ts`)

Với kỳ báo cáo [F, T] và mốc đối chiếu D của một tài khoản:

- D ≤ F: Dư đầu kỳ = Số dư gốc + Σ(thu − chi) có ngày trong [D, F)
- D > F: Dư đầu kỳ = Số dư gốc − Σ(thu − chi) có ngày trong [F, D)
- Thu = Σ thu trong [F, T]; Chi = Σ chi trong [F, T]
- Dư cuối kỳ = Dư đầu kỳ + Thu − Chi

Tiền tính bằng BigInt theo xu (1/100 đồng) từ chuỗi `numeric` của Postgres, không qua số
thực. Mọi tổng tính trên toàn bộ bút toán đã lọc, không tính trên trang đang xem.

## 4. Chống trùng, bỏ sót và dữ liệu lỗi

| Mã | Mức | Ý nghĩa |
|---|---|---|
| `MISSING_ACCOUNT` / `MISSING_DATE` / `MISSING_AMOUNT` / `MISSING_DIRECTION` | Lỗi | Chứng từ có tiền nhưng thiếu thông tin; không vào sổ |
| `UNKNOWN_ACCOUNT` | Lỗi | Mã tài khoản không có trong danh mục |
| `GROUP_ONLY` | Lỗi | Xuất tiền trước khi có cột tài khoản: chỉ biết "Tiền mặt / Ngân hàng"; không đoán tài khoản |
| `DUPLICATE` | Lỗi | Hai bút toán cùng định danh, chỉ tính một |
| `RECEIPT_NOT_POSTED` | Cảnh báo | Có Đã thu nhưng Hóa Đơn chưa ghi khoản Thu |
| `SUPERSEDED_RELEASE` | Cảnh báo | Lệnh chi bị sửa sau khi đã xuất tiền rồi xác nhận lại (không hoàn quỹ xen giữa): chỉ tính lần sau |
| `SUSPICIOUS_AMOUNT` | Cảnh báo | Một khoản ≥ 10 tỷ đồng |

Chuyển tiền nội bộ: hệ thống chưa có nghiệp vụ này. Bút toán đã có cờ
`isInternalTransfer` để sau này bổ sung (hai chân liên kết cùng số chứng từ, tổng thu chi
thực tế không nhân đôi); hiện cờ luôn là `false`.

## 5. API (`/reports/cashflow`, JWT + role)

Xem: `accountant`, `ketoan_congno`, `ketoan_truong`, `thuquy`, `troly_gd`, `director`.
Sửa danh mục: `ketoan_truong`, `director`.

| Method | Đường dẫn | Ghi chú |
|---|---|---|
| GET | `summary` | 5 chỉ số; `excludeInternal=true` để loại chuyển nội bộ |
| GET | `accounts` | danh mục + dư đầu / thu / chi / dư cuối từng tài khoản, cộng theo nhóm |
| GET | `cash`, `bank` | sổ chi tiết nhóm 111 / 112; `page`, `limit` ≤ 500; tổng không phụ thuộc trang |
| GET | `issues` | chứng từ chưa phân loại / cảnh báo |
| PATCH | `accounts/:code` | `openingBalance` + `openingBalanceDate` (đi theo cặp), `isActive`, `note` |
| GET | `export` | Excel 3 sheet theo file mẫu (mục 7), cùng bộ lọc, toàn bộ kết quả — tên `Tong_Hop_Thu_Chi_YYYYMMDD_YYYYMMDD.xlsx` |

Tham số chung: `from`, `to` (YYYY-MM-DD, bắt buộc), `accountType` (`all|cash|bank`),
`accountCode`, `search` (số CT, số HĐ, diễn giải, mã/tên đối tượng; không phân biệt dấu).
Khi có `search`, dòng "Cộng" chỉ tính chứng từ khớp, còn dư đầu/cuối vẫn là số dư thật.

## 6. Migration và rollback

`1794100000000-add-cashflow-report`: tạo `cash_accounts` (seed 13 tài khoản), thêm
`revenue_items."invoiceCashDirection"`, `"invoiceCashAmount"`,
`school_expense_items."cashAccount"`. Mọi cột đều nullable và không default (chỉ đổi
metadata, dữ liệu cũ nhận NULL), chạy lại an toàn.

Phụ thuộc: các migration `1793600000000`, `1793700000000`, `1793800000000` của nhánh
`release/g8-invoice-payment` phải chạy trước (sales_db chưa chạy). Chạy dưới role
`sales_owner`; quyền mặc định tự cấp cho `sales_app`.

Rollback: `down()` xoá 3 cột và bảng `cash_accounts`. Làm vậy sẽ mất các số dư gốc và các
giá trị Thu/Chi, Số tiền, Nguồn chi đã nhập, nên phải backup trước.

## 7. Xuất Excel (`cashflow-excel.ts`)

Dựng theo file mẫu TỔNG HỢP THU CHI.xlsx của kế toán. File mẫu không nằm trong repo vì có
tên người và nhà cung cấp thật. Số liệu lấy từ cùng `buildDataset` / `buildLedger` với
giao diện.

- **DANH MỤC CÁC TK**: C5 "NGUỒN THU CHI"; tiêu đề hàng 7 "Số hiệu tài khoản / Tên tài
  khoản / Số dư"; nhãn nhóm `111-Tiền mặt`, `112-Tiền Gửi Ngân Hàng` ở cột B, tổng nhóm ở
  cột E; viền cả khối B7:E…; Times New Roman 11. "Số dư" là số dư cuối ngày "Đến ngày".
  Tổng nhóm là công thức `SUM` khi mọi tài khoản trong nhóm đã có số dư gốc, ngược lại ghi
  "Chưa xác minh".
- **Tiền mặt / Tiền gửi ngân hàng**:
  - Hàng 1 "SỔ CHI TIẾT THU CHI" (Arial 16, gộp), hàng 2 "TK 111: …" / "TK 112: …".
  - Hàng 4 là Thu/Chi, hàng 5 là `mã-tên` tài khoản gộp từng cặp (nền BFBFBF), giống mẫu.
  - Hàng 6 Số dư đầu kỳ, rồi các chứng từ, "Cộng" (`SUM`), "Số dư cuối kỳ"
    (`=Thu đầu kỳ + Cộng Thu − Cộng Chi`, nền D8D8D8).
  - Định dạng số `#,##0 ;(#,##0)`, ngày `dd/mm/yyyy`; khổ A4 ngang, lề 1 cm.
  - Số cặp cột theo danh mục.
- Mọi công thức đều ghi sẵn kết quả, nên file mở ra có số ngay. Ô tiền là kiểu số, ngày là
  kiểu ngày; số chứng từ, số hóa đơn và mã đối tượng là chữ (giữ số 0 ở đầu).

Khác mẫu có chủ đích:

- Tiêu đề cột lấy từ danh mục, không theo mẫu. Mẫu ghi "11210-TK Techcombank - Kido" cho
  cột của 1129 (trùng mã 11210) và viết tắt "TK Techcombank - CĐS", "TK MB Bank ST".
- Dư đầu / dư cuối luôn nằm ở cột Thu. Mẫu đặt của 1113, 1114 ở cột Chi.
- Ô tiền của tài khoản khác để trống. Mẫu điền 0 rải rác.
- Ngày luôn là kiểu ngày. Mẫu lẫn chuỗi "02/01/2026".
- Thêm dòng kỳ báo cáo (hàng 3 của sổ, C6 của danh mục). Gộp 2 hàng tiêu đề cho các cột
  chứng từ và đối tượng. Cố định khung ở F6, lặp hàng 4–5 khi in.
- Tài khoản chưa có số dư gốc ghi "Chưa xác minh" thay vì để trống hoặc 0, và không dùng
  công thức ở ô đó (tránh `#VALUE!`).
- Khi lọc theo từ khoá: "Cộng" chỉ tính chứng từ khớp, "Số dư cuối kỳ" ghi số dư thật thay
  vì công thức, kèm ghi chú dưới bảng.
- Nhóm ngoài phạm vi "Loại tài khoản" vẫn có sheet (đủ 3 sheet) và ghi "Không có tài khoản
  nào theo bộ lọc hiện tại".
- Tên sheet danh mục bỏ dấu cách thừa ở cuối của mẫu ("DANH MỤC CÁC TK ").

