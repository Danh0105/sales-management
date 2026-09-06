# Prompt FE — Chi phí khác khi chấm công

Bạn là Senior Frontend Developer. Hãy cập nhật màn **Giảng dạy → Chấm công → Chi tiết chấm công** để Nhân sự nhập các khoản phát sinh cho từng buổi dạy, ví dụ xăng xe và phụ cấp.

## API

Hai API chấm công nhận thêm `otherCosts`:

```ts
interface AttendanceOtherCost {
  name: string;       // bắt buộc, tối đa 100 ký tự
  amount: number;     // 0..100.000.000, tối đa 2 chữ số thập phân
  note?: string | null; // tối đa 500 ký tự
}

interface AttendancePayload {
  status: SessionStatus;
  attendanceNote?: string | null;
  otherCosts?: AttendanceOtherCost[]; // tối đa 20 khoản/buổi
}
```

Chấm một buổi:

```http
PATCH /teaching-sessions/:id/attendance
Content-Type: application/json

{
  "status": "PRESENT",
  "attendanceNote": "Đã hoàn thành",
  "otherCosts": [
    { "name": "Xăng xe", "amount": 50000, "note": null },
    { "name": "Phụ cấp dạy xa", "amount": 100000, "note": "Cơ sở ngoại thành" }
  ]
}
```

Chấm hàng loạt:

```http
PATCH /teaching-sessions/attendance/bulk

{
  "items": [
    {
      "sessionId": 123,
      "status": "PRESENT",
      "attendanceNote": null,
      "otherCosts": [{ "name": "Xăng xe", "amount": 50000 }]
    }
  ]
}
```

Mỗi `TeachingSession` trả thêm:

```ts
otherCosts: AttendanceOtherCost[];
otherCostsTotal: number;
totalAmount: number; // tiền tiết dạy + otherCostsTotal
```

API `GET /teaching-sessions/attendance/summary` trả thêm ở từng giáo viên và `grandTotal`:

```ts
payableAmount: number;      // chỉ tiền tiết dạy, giữ tương thích cũ
otherCostsAmount: number;   // tổng chi phí khác của các buổi PRESENT
totalPayableAmount: number; // payableAmount + otherCostsAmount
```

Chỉ buổi `PRESENT` được cộng chi phí vào bảng thanh toán. Khi chuyển về `SCHEDULED` (bỏ chấm), backend xóa các chi phí của buổi đó.

## Giao diện chi tiết chấm công

- Thêm cột **Chi phí khác**.
- Mặc định hiển thị `otherCostsTotal` đã lưu; `0` thì hiển thị `—`.
- Cho Nhân sự mở popover/modal để thêm, sửa, xóa từng khoản.
- Mỗi dòng chi phí có: Tên khoản, Số tiền, Ghi chú tùy chọn, nút Xóa.
- Có nút nhanh `+ Xăng xe`, `+ Phụ cấp`, `+ Khoản khác`.
- Hiển thị tổng tiền chi phí ngay cuối popover.
- Payload chấm nhanh và chấm hàng loạt phải gửi `otherCosts` cùng status/note.
- Dòng được coi là “đã sửa” khi status, attendanceNote hoặc otherCosts thay đổi.
- Không gửi số tiền dạng chuỗi có dấu phân cách; chuẩn hóa về number trước khi gọi API.
- Không cho số âm, NaN hoặc tên khoản trống.

## Bảng tổng hợp

Hiển thị tách ba số:

1. Tiền tiết dạy: `payableAmount`.
2. Chi phí khác: `otherCostsAmount`.
3. Tổng thanh toán: `totalPayableAmount`.

Không tự tính lại toàn bộ ở frontend; dùng số backend trả về.

## Nghiệm thu

- [ ] Thêm được nhiều khoản vào một buổi.
- [ ] Sửa/xóa khoản và lưu lại đúng.
- [ ] Chấm hàng loạt gửi đúng chi phí theo từng `sessionId`.
- [ ] Tổng chi phí từng buổi và tổng hợp theo giáo viên hiển thị đúng.
- [ ] Bỏ chấm cảnh báo chi phí sẽ bị xóa.
- [ ] Các buổi cũ không có chi phí hiển thị bình thường với mảng rỗng và tổng 0.
- [ ] Mobile không bị tràn bảng; thao tác chi phí dùng modal/bottom sheet nếu cần.
- [ ] Build không lỗi TypeScript.

