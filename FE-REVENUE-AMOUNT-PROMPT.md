# FE — Công thức thành tiền Doanh thu

Backend đã thống nhất công thức cho mỗi dòng Doanh thu:

```ts
const baseQuantity = studentCount > 0 ? studentCount : totalPeriods;
const invoiceAmount = baseQuantity * monthsCount * unitPrice;
const remainingAmount = invoiceAmount - paidAmount;
```

Yêu cầu FE áp dụng cùng công thức khi người dùng thay đổi một trong các ô
`Số tiết`, `HS`, `Tháng`, `Đơn giá`, `Đã thu` để cột `Thành tiền`, `Còn lại`
và ba tổng cuối bảng cập nhật tức thời:

- Có nhập `HS` (> 0): `HS × Tháng × Đơn giá`.
- Không nhập `HS`, có nhập `Số tiết`: `Số tiết × Tháng × Đơn giá`.
- Nếu cả hai cùng có giá trị, ưu tiên `HS`.
- Nếu cả `HS` và `Số tiết` đều trống/0, thành tiền bằng `0`.
- Không gửi giá trị `invoiceAmount` tự tính để làm nguồn chuẩn; dùng giá trị
  backend trả về sau khi lưu.

Ví dụ trong ảnh: `60 tiết × 1 tháng × 530.000 = 31.800.000đ`.
