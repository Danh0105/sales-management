# FRONTEND — HIỂN THỊ TIẾT GIÁO VIÊN TỪ CHỐI KHI XẾP LỊCH

Ở màn xếp lịch, gọi API sau để lấy riêng các mẫu lịch giáo viên đã từ chối:

```http
GET /teaching-schedules?confirmationStatus=REJECTED&page=1&limit=100
```

Có thể gửi thêm `schoolId`, `classId`, `subjectId`, `teacherId` hoặc
`dayOfWeek` theo bộ lọc đang chọn. Mỗi phần tử đã có đủ dữ liệu để hiển thị:

- `teacherName`, `schoolName`, `className`, `subjectName`
- `dayOfWeekLabel`, `startTime`, `endTime`, `periods`
- `effectiveFrom`, `effectiveTo`
- `confirmationStatus` (luôn là `REJECTED` với request trên)
- `confirmedAt`: thời điểm giáo viên phản hồi
- `rejectionReason`: lý do giáo viên từ chối

Hiển thị một khối **“Tiết giáo viên từ chối — cần xếp lại”** phía trên danh
sách lịch. Mỗi dòng cần làm nổi bật tên giáo viên, lớp/môn, thứ và khung giờ;
hiện nguyên văn `rejectionReason`. Nếu rỗng, hiển thị “Không có tiết bị từ
chối”. Sau khi đổi giáo viên và lưu thành công, tải lại cả danh sách lịch chính
và danh sách bị từ chối.

Lịch `REJECTED` chỉ được giữ để theo dõi/xếp lại; backend không còn tính lịch
này là giờ bận hoặc tải dạy của giáo viên.
