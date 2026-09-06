# PROMPT: FRONTEND — NÚT GỢI Ý GIÁO VIÊN

Bạn là Senior Frontend Developer. Hãy bổ sung nút **“Gợi ý giáo viên”** vào
form tạo/sửa lịch dạy. Khi người dùng bấm nút, hệ thống xếp hạng giáo viên dựa
trên trường được dạy, môn được dạy, khoảng cách tới trường, lịch trống và tải
dạy trong tuần.

## 1. Nguyên tắc nghiệp vụ

- Chỉ cho bấm sau khi đã chọn đủ: lớp, môn, thứ, giờ bắt đầu, giờ kết thúc và
  ngày hiệu lực.
- `schoolId` lấy từ lớp đã chọn. Không yêu cầu người dùng chọn trường lần nữa.
- `subjectId` phải là một trong các môn của lớp (`class.subjectIds`).
- Hai điều kiện cứng quan trọng nhất là giáo viên được phép dạy tại trường và
  có năng lực đúng môn. Giáo viên không đạt vẫn có thể được backend trả về để
  giải thích lý do, nhưng không được chọn mặc định.
- Khoảng cách là tiêu chí xếp hạng. Nếu giáo viên hoặc trường chưa có tọa độ,
  hiển thị “Chưa có dữ liệu khoảng cách”, không tự suy đoán là gần hay xa.
- Không dùng `subjects[].recommendedTeachers` trong response lớp cho nút này,
  vì danh sách đó chưa xét khoảng cách, khung giờ và tải dạy. Nút phải gọi API
  `/teachers/candidates`.

## 2. API gợi ý

**POST** `/teachers/candidates`

```json
{
  "schoolId": 494,
  "subjectId": 794,
  "dayOfWeek": 3,
  "startTime": "07:30",
  "endTime": "09:00",
  "effectiveFrom": "2026-09-01",
  "effectiveTo": "2026-12-31",
  "periods": 2
}
```

Khi sửa lịch, gửi thêm:

```json
{ "exceptScheduleId": 123 }
```

để lịch hiện tại không tự xung đột với chính nó.

Response mẫu:

```json
{
  "candidates": [
    {
      "teacherId": 12,
      "teacherName": "Nguyễn Văn A",
      "score": 91,
      "eligible": true,
      "distanceKm": 2.4,
      "assignedPeriodsInWeek": 8,
      "maxPeriodsPerWeek": 20,
      "conflicts": [],
      "reasons": [
        { "kind": "PASS", "code": "ALLOWED_SCHOOL", "message": "Nhận dạy tại Trường ABC" },
        { "kind": "PASS", "code": "TEACHABLE_SUBJECT", "message": "Dạy được môn STEM" },
        { "kind": "PASS", "code": "SCHEDULE_FREE", "message": "Khung giờ này đang trống" },
        { "kind": "PASS", "code": "WEEKLY_LOAD", "message": "8/20 tiết trong tuần, còn nhận thêm được" },
        { "kind": "PASS", "code": "DISTANCE", "message": "Cách trường 2.4 km" }
      ]
    }
  ],
  "coverage": {
    "teachers": { "total": 20, "withSchools": 18, "withSubjects": 17, "withCoordinates": 15 },
    "schools": { "total": 10, "withCoordinates": 9 }
  },
  "warnings": []
}
```

Backend đã sắp xếp: giáo viên đủ điều kiện trước, sau đó điểm cao xuống thấp.
Frontend phải giữ nguyên thứ tự này.

## 3. Giao diện và tương tác

Đặt nút **“Gợi ý giáo viên”** cạnh ô chọn giáo viên. Khi bấm:

1. Validate các trường bắt buộc. Nếu thiếu, focus vào field đầu tiên bị thiếu và
   hiển thị lỗi ngay dưới field; không gọi API.
2. Hiện loading trên nút và khóa việc bấm lặp.
3. Mở drawer/modal “Gợi ý giáo viên” sau khi nhận kết quả.
4. Dòng đầu modal hiển thị ngữ cảnh: tên trường, lớp, môn, thứ, khung giờ.
5. Hiển thị danh sách dạng card hoặc bảng, tối ưu cho cả desktop và mobile.

Mỗi giáo viên hiển thị:

- Họ tên và badge điểm `score/100`.
- Badge **“Phù hợp”** khi `eligible = true`; **“Không phù hợp”** khi false.
- Khoảng cách: format tối đa 1 chữ số thập phân; `null` hiển thị “Chưa có dữ
  liệu khoảng cách”.
- Tải dạy: `assignedPeriodsInWeek/maxPeriodsPerWeek tiết/tuần`; nếu trần là
  `null`, hiển thị “Đang dạy X tiết/tuần · chưa khai giới hạn”.
- Toàn bộ `reasons[].message`, kèm màu/icon theo `kind`: `PASS` xanh,
  `UNKNOWN` vàng/xám, `FAIL` đỏ. Không tự viết lại message từ backend.

Nút **“Chọn giáo viên”**:

- Enable với `eligible = true`.
- Disable với `eligible = false`; tooltip nêu các reason có `kind = FAIL` hoặc
  `UNKNOWN`.
- Khi chọn, gán `teacherId` vào form lịch dạy, đóng modal và hiển thị tên giáo
  viên đã chọn. Việc này chỉ chọn trên form, chưa tự lưu hoặc tạo lịch.

Thêm switch **“Hiện giáo viên không phù hợp”**, mặc định tắt. Khi tắt chỉ hiện
`eligible = true`; khi bật hiện toàn bộ để Nhân sự biết nguyên nhân bị loại.

Nếu không có giáo viên đủ điều kiện, hiển thị empty state:

> Chưa có giáo viên phù hợp với trường, môn và khung giờ đã chọn.

Kèm nút “Hiện tất cả và xem lý do”.

Hiển thị từng chuỗi trong `warnings` ở alert màu vàng phía trên danh sách. Đây
là cảnh báo thiếu dữ liệu cấu hình, không phải lỗi API.

## 4. Trạng thái lỗi

- `400`: hiển thị message backend ngay trong modal/toast, thường do trường hoặc
  môn không tồn tại hay môn không thuộc trường.
- `401/403`: dùng cơ chế auth chung của ứng dụng.
- Lỗi mạng/5xx: giữ nguyên dữ liệu form, đóng loading và cho phép “Thử lại”.
- Khi người dùng đổi lớp, môn, thứ, giờ hoặc ngày hiệu lực sau khi đã chọn giáo
  viên từ gợi ý, đánh dấu lựa chọn cũ là cần kiểm tra lại. Không âm thầm coi kết
  quả cũ còn hợp lệ.

## 5. Tiêu chí nghiệm thu

- Không gọi API nếu thiếu dữ liệu lịch cần thiết.
- Request dùng đúng trường của lớp và đúng môn của lớp.
- Danh sách giữ đúng thứ tự backend, mặc định chỉ hiện người đủ điều kiện.
- Hiển thị rõ trường được dạy, môn được dạy, khoảng cách, lịch trống và tải dạy.
- Không biến thiếu tọa độ thành khoảng cách 0 km.
- Chọn một giáo viên chỉ cập nhật form, không tự động tạo lịch.
- Responsive, có loading, empty state, error state và thao tác được bằng bàn phím.

