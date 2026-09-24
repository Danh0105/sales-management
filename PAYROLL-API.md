# API phiếu lương nhân viên

Module backend: `src/payroll/`. Tất cả endpoint cần Bearer JWT.

## Quyền

| Role                         | Danh sách / xem          | Tạo / sửa / xoá |
| ---------------------------- | ------------------------ | --------------- |
| `nhansu`, `ketoan_truong`    | Tất cả                   | Có              |
| `director`, `director_la`    | Tất cả                   | Không           |
| Các tài khoản nhân viên khác | Chỉ phiếu của chính mình | Không           |

Backend luôn lấy phạm vi cá nhân từ `user.id` trong JWT. Truyền `employeeId`
của người khác vào query không làm mở rộng quyền.

## Endpoint

| Method   | URL             | Mô tả                   |
| -------- | --------------- | ----------------------- |
| `POST`   | `/payrolls`     | Tạo phiếu lương         |
| `GET`    | `/payrolls`     | Danh sách có phân trang |
| `GET`    | `/payrolls/:id` | Chi tiết phiếu          |
| `PATCH`  | `/payrolls/:id` | Sửa phiếu               |
| `DELETE` | `/payrolls/:id` | Xoá phiếu               |

Mỗi nhân viên chỉ có một phiếu trong cùng `month/year`; tạo trùng trả `409`.

### Tạo phiếu

```http
POST /payrolls
Content-Type: application/json

{
  "employeeId": 15,
  "month": 8,
  "year": 2026,
  "jobTitle": "Phó phòng Công nghệ",
  "standardWorkingDays": 23.5,
  "probationWorkingDays": 0,
  "officialWorkingDays": 23.5,
  "annualLeaveDays": 0,
  "holidayDays": 0,
  "unpaidLeaveDays": 0,
  "leaveNote": null,
  "excessPeriods": 0,
  "remainingLeavePreviousYear": 0,
  "remainingLeaveCurrentYear": 5,
  "baseSalary": 14000000,
  "officialWorkSalary": 14000000,
  "probationWorkSalary": 0,
  "fuelAllowance": 0,
  "overtimeAllowance": 1620000,
  "excessPeriodAllowance": 0,
  "otherSupport": 120000,
  "bonus": 0,
  "socialInsurance": 596400,
  "personalIncomeTax": 0,
  "adjustmentAmount": 1620000,
  "adjustmentNote": "Tạm ứng/truy thu",
  "advancePayment": 0,
  "note": null
}
```

Các field số ngoài `employeeId`, `month`, `year` đều không bắt buộc và mặc
định là `0`. Số ngày/giờ/tiền không được âm, tối đa 2 chữ số thập phân. Riêng
`adjustmentAmount` nhận số dương cho khấu trừ/truy thu và số âm cho truy lãnh.

Backend không nhận ba field tổng từ client mà luôn tự tính:

```text
totalIncome = officialWorkSalary + probationWorkSalary + fuelAllowance
            + overtimeAllowance + excessPeriodAllowance + otherSupport + bonus

totalDeduction = socialInsurance + personalIncomeTax
               + adjustmentAmount + advancePayment

netSalary = totalIncome - totalDeduction
```

`baseSalary` là dòng “Mức lương” tham chiếu nên không cộng trực tiếp vào
`totalIncome`, đúng cấu trúc phiếu mẫu.

### Danh sách

```http
GET /payrolls?year=2026&month=8&employeeId=15&page=1&limit=20
```

```json
{
  "data": [],
  "meta": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 }
}
```

`employeeId`, `year`, `month` là bộ lọc không bắt buộc. `limit` tối đa 100.

### Sửa phiếu

`PATCH` nhận mọi field của payload tạo, trừ `employeeId`, `month`, `year`.
Gửi chuỗi rỗng cho các field ghi chú/chức vụ sẽ lưu thành `null`. Sau mỗi lần
sửa, backend tính lại toàn bộ ba giá trị tổng.

## Dữ liệu trả về

Response có toàn bộ field trên, thêm `id`, snapshot `employeeName`, các tổng,
người tạo và thời gian. Quan hệ `employee` chỉ trả thông tin an toàn:

```json
{
  "employee": {
    "id": 15,
    "name": "Nguyễn Xuân Danh",
    "email": "...",
    "phone": "...",
    "department": { "id": 3, "name": "Phòng Công nghệ" }
  }
}
```

Mật khẩu và roles của nhân viên không xuất hiện trong response phiếu lương.

## Lỗi chính

- `400`: payload sai, tháng/năm ngoài phạm vi, số âm hoặc quá 2 số lẻ.
- `401`: chưa đăng nhập.
- `403`: không có quyền tạo/sửa/xoá.
- `404`: nhân viên/phiếu không tồn tại; người xem phiếu của người khác cũng
  nhận `404` để không lộ sự tồn tại của dữ liệu.
- `409`: nhân viên đã có phiếu trong tháng đó.
