# Phân hệ Đề nghị tài chính nội bộ

Tạm ứng (TU), tạm ứng lương (UL), hoàn ứng (HU), thanh toán chi phí / công tác phí (TT).
Module backend: `src/financial-request/`. Frontend (kido-app): `src/pages/Finance/`, route `/director/finance/*` và `/employee/finance/*`.

Module **mới, tách riêng**: không sửa bảng hay luồng "Đề xuất chi" (`suggest`, `/expense-requests`). Hai luồng chạy song song.

## Triển khai (chưa làm, cần duyệt)

1. Chạy migration `1794500000000-add-financial-requests` trên `sales_db` dưới role `sales_owner`. Đã thử trên clone cấu trúc: up → down → up chạy được, schema builder báo 0 khác biệt với entity.
   - Tạo 17 bảng `financial_*`, trigger chặn sửa/xoá `financial_audit_logs`, thu quyền UPDATE/DELETE/TRUNCATE nhật ký của `sales_app`.
   - Thêm giá trị `FINANCIAL_REQUEST` vào enum `notification_type_enum`. `down()` không gỡ được giá trị này.
   - Seed: 10 danh mục chi phí, chính sách `GLOBAL`, một quy trình mặc định 4 cấp. Không seed công ty, nhân viên hay tài khoản ngân hàng nào.
2. `npm ci`: thêm phụ thuộc `pdfmake@0.2.23` (ghim cứng, font Roboto có tiếng Việt).
3. Biến môi trường, đều có giá trị mặc định:
   - `FINANCIAL_STORAGE_DIR`: kho tệp riêng, mặc định `<cwd>/private-uploads/financial`. Thư mục này nằm ngoài `/uploads` công khai. Cần sao lưu cùng dữ liệu.
   - `FINANCIAL_APP_URL`: gốc link trong mã QR trên PDF, mặc định `https://kidoapp.kidoedu.vn`.
4. Cron nhắc hạn chạy 08:00 hằng ngày, chỉ trên instance `NODE_ENV=production`.
5. Sau khi deploy, quản trị (role `director`) vào **Quản lý tài chính → Cấu hình quy trình**:
   - Thêm công ty: tên, mã số thuế, địa chỉ, logo, mã biểu mẫu.
   - Gán vai trò: Quản lý trực tiếp theo phòng ban, Bộ phận kiểm soát, Kế toán. Nếu chưa gán, nhân viên sẽ không gửi duyệt được và hệ thống báo rõ cấp nào chưa có người duyệt.

## Phân quyền (kiểm tra ở backend — `FinancialAccessService`)

Vai trò tài chính gán theo phạm vi **công ty × phòng ban** (`financial_role_assignments`). Mỗi vai trò có thể kèm hạn mức duyệt.

Vai trò mặc định suy từ role hệ thống, áp cho mọi công ty:

| Role hệ thống | Vai trò tài chính |
|---|---|
| `director` | Quản trị + BGĐ |
| `ketoan_truong` | Kế toán |
| `thuquy` | Thủ quỹ |

Quyền theo thao tác:

| Thao tác | Ai được làm |
|---|---|
| Lập, sửa bản nháp hoặc phiếu bị trả về, gửi, thu hồi, xoá nháp | Người lập phiếu |
| Xem phiếu | Người đề nghị, người lập, quản lý trên phiếu, người duyệt (kể cả người được uỷ quyền), người có vai trò phủ công ty/phòng ban. Bản nháp chỉ người lập (và quản trị) xem được — áp dụng cả cho tệp, PDF, sao chép. |
| Duyệt / từ chối / yêu cầu bổ sung | Chỉ người trong danh sách duyệt của **bước đang chờ**, hoặc người được uỷ quyền còn hiệu lực. Không duyệt sai thứ tự. Bấm lặp sẽ bị từ chối. |
| Điều chỉnh số tiền chấp nhận theo dòng | Bước có bật `can_adjust_amounts`. Số chấp nhận không được vượt số kê khai; khác số kê khai phải ghi lý do. |
| Ghi nhận chi / thu | Kế toán hoặc thủ quỹ trong phạm vi, không phải chính người nhận tiền |
| Huỷ phiếu chi / thu | Kế toán (bắt buộc lý do) |
| Ghi nhận khấu trừ lương | Kế toán, `nhansu`, `ketoan_truong` |
| Huỷ phiếu đã duyệt (chưa phát sinh tiền) | Kế toán hoặc quản trị (bắt buộc lý do) |
| Bỏ qua cấp duyệt được phép bỏ qua | Quản trị (bắt buộc lý do) |
| Cấu hình | Quản trị toàn phân hệ |

Che dữ liệu nhạy cảm:

- Số tài khoản ngân hàng hiện đầy đủ chỉ cho người đề nghị, kế toán, thủ quỹ và quản trị. Người khác thấy dạng `•••• 1234`.
- Lương dự kiến chỉ hiện cho người đề nghị, kế toán, nhân sự và quản trị.
- `activity_log` không chép body của `/financial-requests/*`. Lịch sử chi tiết nằm trong nhật ký riêng của phân hệ.

Tự phê duyệt — cấu hình theo quy trình:

- `BLOCK` (mặc định): loại người đề nghị khỏi danh sách duyệt. Nếu cấp đó không còn ai thì không gửi được.
- `SKIP_STEP`: bỏ qua cấp mà người đề nghị là người duyệt duy nhất, có ghi lý do.
- `ALLOW`: cho phép tự duyệt.

## Luồng duyệt

1. Khi gửi duyệt, hệ thống chọn quy trình cụ thể nhất theo thứ tự: công ty + loại → công ty → loại → mặc định.
2. Các bước được **chụp riêng cho phiếu** (`financial_approval_steps`). Sửa quy trình sau đó không ảnh hưởng phiếu đang duyệt.
3. Cấp có `min_amount` lớn hơn tổng tiền thì tự bỏ qua (hạn mức).
4. Trả về để bổ sung → người đề nghị sửa → gửi lại tạo **vòng mới**. Vòng cũ giữ nguyên làm lịch sử.
5. Thao tác duyệt khoá dòng phiếu (`SELECT … FOR UPDATE`) và kiểm tra `stepId` thuộc bước đang chờ.

## Tạm ứng → hoàn ứng → thanh toán

Ba trục trạng thái **độc lập**: duyệt (`approval_status`), chi tiền (`payment_status`), quyết toán/thu hồi/khấu trừ.

- **Tạm ứng**: duyệt → chờ chi → chi một phần hoặc đủ. Có công nợ tạm ứng khi đã chi (phiếu chi chưa huỷ).
- **Hoàn ứng**:
  - Chọn một hoặc nhiều tạm ứng đã chi. Mỗi tạm ứng có thể được hoàn ứng nhiều lần.
  - Phân bổ chỉ giữ chỗ số dư khi phiếu hoàn ứng đang chờ duyệt hoặc đã duyệt. Bản nháp không giữ chỗ.
  - Khi gửi duyệt và khi duyệt, các tạm ứng bị khoá dòng rồi kiểm tra lại số dư, nên hai phiếu gửi đồng thời không đối trừ trùng.
  - Chênh lệch = chi phí được duyệt − tạm ứng đối trừ:
    - Lớn hơn 0: công ty chi thêm → `PENDING_PAYMENT`.
    - Bằng 0: tất toán ngay.
    - Nhỏ hơn 0: nhân viên hoàn trả → `PENDING_REFUND`, thu được nhiều lần.
  - Tạm ứng chỉ `SETTLED` khi đã đối trừ đủ **và** không còn khoản hoàn trả nào đang treo. Duyệt xong chưa phải là tất toán.
- **Chi / thu** (`financial_payments`, `financial_refunds`):
  - Mỗi phiếu có `idempotency_key` duy nhất. Gửi lặp cùng khoá trả lại phiếu cũ.
  - Không ghi vượt số còn phải chi hoặc phải thu.
  - Không sửa phiếu chi/thu; sai thì huỷ (VOIDED, kèm lý do) rồi ghi lại.
- **Thanh toán chi phí**: nếu người lập còn tạm ứng chưa hoàn, hệ thống cảnh báo để lập hoàn ứng thay vì thanh toán trùng. Hệ thống cũng cảnh báo khi số hoá đơn đã được kê khai ở phiếu khác.

## Tạm ứng lương và phiếu lương

- Kiểm tra chính sách khi gửi duyệt: số lần ứng tối đa mỗi tháng, hạn mức mỗi lần, % lương dự kiến, số kỳ khấu trừ tối đa.
  - Lương dự kiến lấy từ phiếu lương gần nhất (`base_salary`, nếu không có thì `net_salary`).
- Kế hoạch khấu trừ (`financial_salary_advance_deductions`) chỉ được lập sau khi đã thực chi. Phần đã chi được chia đều cho các kỳ; phần lẻ dồn vào kỳ cuối.
- "Ghi nhận đã trừ" từng kỳ:
  - Ràng buộc DB `UNIQUE(request_id, kỳ)` và `idempotency_key` bảo đảm mỗi kỳ chỉ trừ một lần.
  - Liên kết `payroll_id` nếu phiếu lương kỳ đó đã tồn tại.
  - Trừ ít hơn kế hoạch thì phần còn lại dồn sang các kỳ sau.
- **Không tự sửa phiếu lương.** Người lập phiếu lương đối chiếu cột "Tạm ứng" qua `GET /financial-requests/salary-advances/payroll-preview` hoặc màn Quản lý thanh toán.

## API (`/financial-requests`, cần JWT)

| Nhóm | Endpoint |
|---|---|
| Danh mục | `GET meta`, `GET managers?companyId` |
| Chứng từ | `GET /` (lọc: scope mine/approvals/all/payments, type, companyId, departmentId, requesterId, approvalStatus, paymentStatus, settlementStatus, dateFrom/To, amountMin/Max, code, q, overdue, sort, order, page, limit) · `POST /` · `GET :id` · `PATCH :id` (kèm `version`) · `DELETE :id` · `POST :id/copy` |
| Duyệt | `POST :id/submit`, `:id/withdraw`, `:id/approve` (`stepId`, `comment`, `adjustments[]`), `:id/reject`, `:id/return`, `:id/adjust`, `:id/steps/:stepId/skip`, `:id/cancel` |
| Tệp | `POST :id/attachments` (multipart `files[]`, `kind`, `itemId`/`paymentId`/`refundId`) · `GET :id/attachments/:aid/file` · `DELETE :id/attachments/:aid` |
| Tiền | `POST :id/payments`, `:id/payments/:pid/void`, `:id/refunds`, `:id/refunds/:rid/void` · `GET advances/available` · `GET balances` |
| Ứng lương | `GET salary-advances/check`, `GET salary-advances/deductions`, `GET salary-advances/payroll-preview`, `POST :id/deductions/:did/confirm` |
| Xuất / báo cáo | `GET :id/pdf?disposition=inline\|attachment` · `GET export/excel` (cùng bộ lọc với danh sách) · `GET reports/summary` |
| Uỷ quyền | `GET delegations/mine`, `POST delegations`, `POST delegations/:id/revoke` |
| Cấu hình (quản trị) | `GET config` · `POST/PATCH config/companies[/:id]` · `POST config/companies/:id/logo` · `POST/PATCH config/categories[/:id]` · `POST/PATCH config/workflows[/:id]` · `POST/DELETE config/assignments[/:id]` · `PUT config/policies` · `GET companies/:id/logo` |

Tệp đính kèm:

- Nhận PDF, JPG, PNG, WEBP, XLSX/XLS, DOCX/DOC. Tối đa 10MB mỗi tệp, 10 tệp mỗi lần.
- Nội dung tệp được kiểm tra theo chữ ký đầu tệp (magic bytes), không chỉ theo đuôi tên.
- Hệ thống lưu mã SHA-256 của từng tệp.

## Kiểm thử

- Unit: `npx jest src/financial-request` — tiền/làm tròn, đọc số bằng chữ, quyết toán, quy trình.
- Tích hợp trên Postgres thật, trỏ vào DB test riêng (guard chặn `sales_db`). DB test phải chạy migration trước. Lệnh:

  ```
  FINANCIAL_IT_DB=sales_fin_test DB_NAME=sales_fin_test DB_USER=… DB_PASSWORD=… \
    npx jest --config ./test/jest-e2e.json test/financial-requests.e2e-spec.ts
  ```

  Bộ test phủ đủ 20 tình huống nghiệm thu, cùng uỷ quyền, tự phê duyệt, huỷ, sao chép, dashboard.
- Có thể đặt thêm `FIN_IT_PDF_DIR=<thư mục>` để lưu PDF mẫu ra xem bằng mắt.
