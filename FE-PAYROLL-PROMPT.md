# Prompt FE — Phiếu lương nhân viên

Bạn là Senior Frontend Developer của ứng dụng quản lý KIDO. Hãy thêm module
**Phiếu lương** dùng contract trong `PAYROLL-API.md`.

## Màn quản lý (`nhansu`, `ketoan_truong`)

- Menu “Phiếu lương”, bộ lọc tháng/năm/nhân viên, bảng phân trang server-side.
- Nút “Tạo phiếu lương”; form chọn nhân viên rồi nhập đủ các nhóm theo mẫu:
  ngày công, thành phần lương, các khoản khấu trừ.
- Hiện ba tổng theo thời gian thực nhưng coi response backend là nguồn chuẩn.
- Cho sửa/xoá có xác nhận. Bắt lỗi `409` và báo rõ nhân viên đã có phiếu kỳ đó.
- `director`, `director_la` thấy danh sách/chi tiết nhưng không có nút ghi dữ liệu.

## Màn cá nhân

- Các role còn lại gọi `GET /payrolls?year=&month=` để xem phiếu của mình;
  không gửi hoặc tin vào `employeeId` lấy từ URL.
- Dựng chi tiết gần với biểu mẫu: tiêu đề vàng “PHIẾU LƯƠNG THÁNG X”, thông tin
  nhân viên, bảng ngày công, bảng thành phần lương, bảng khấu trừ và dòng vàng
  “Lương thực nhận”.
- Định dạng tiền `vi-VN`, giá trị 0 có thể hiện `-`, số khấu trừ đặt trong ngoặc.
- Có chế độ in A4 bằng CSS print; ẩn menu/nút khi in. Không tự tính lại số đã lưu.

## Ánh xạ dòng biểu mẫu

| Dòng                             | Field API                                                              |
| -------------------------------- | ---------------------------------------------------------------------- |
| Ngày công chuẩn                  | `standardWorkingDays`                                                  |
| Ngày công thử việc               | `probationWorkingDays`                                                 |
| Ngày công chính thức             | `officialWorkingDays`                                                  |
| Nghỉ phép năm / lễ / không lương | `annualLeaveDays` / `holidayDays` / `unpaidLeaveDays`                  |
| Số tiết vượt                     | `excessPeriods`                                                        |
| Phép còn lại                     | `remainingLeavePreviousYear` / `remainingLeaveCurrentYear`             |
| Mức lương                        | `baseSalary`                                                           |
| Lương ngày công chính / thử việc | `officialWorkSalary` / `probationWorkSalary`                           |
| PC xăng xe / tăng ca / vượt tiết | `fuelAllowance` / `overtimeAllowance` / `excessPeriodAllowance`        |
| Hỗ trợ khác / thưởng             | `otherSupport` / `bonus`                                               |
| Tổng thu nhập                    | `totalIncome`                                                          |
| BHXH + BHYT + BHTN               | `socialInsurance`                                                      |
| Thuế TNCN                        | `personalIncomeTax`                                                    |
| Truy thu/truy lãnh               | `adjustmentAmount`, diễn giải ở `adjustmentNote`; truy lãnh nhập số âm |
| Tạm ứng đã chi                   | `advancePayment`                                                       |
| Tổng khấu trừ                    | `totalDeduction`                                                       |
| Lương thực nhận                  | `netSalary`                                                            |

Không bảo vệ chức năng tạo/sửa chỉ bằng việc ẩn nút; vẫn xử lý `403`
từ backend và không retry request ghi dữ liệu.
