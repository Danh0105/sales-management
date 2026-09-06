# Prompt FE — Phân trang “Chi tiết chấm công”

Bạn là Senior Frontend Developer. Hãy cập nhật màn hình **Giảng dạy → Chấm công**, phần bảng **Chi tiết chấm công**, để sử dụng phân trang phía server.

## 1. API hiện có

Gọi endpoint:

```http
GET /teaching-sessions
```

Query đang hỗ trợ:

```ts
interface SessionQuery {
  teacherId?: number;
  schoolId?: number;
  subjectId?: number;
  classId?: number;
  scheduleId?: number;
  status?: "SCHEDULED" | "PRESENT" | "ABSENT" | "EXCUSED" | "CANCELLED";
  unchecked?: boolean;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
  page?: number;     // mặc định 1
  limit?: number;    // mặc định 50, tối đa 200
}
```

Ví dụ:

```http
GET /teaching-sessions?fromDate=2026-08-01&toDate=2026-08-31&teacherId=5&page=2&limit=20
```

Response:

```ts
interface PagedTeachingSessions {
  data: TeachingSession[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

Không lấy toàn bộ danh sách rồi tự chia trang ở frontend. Mỗi lần đổi trang hoặc số dòng phải gọi lại API với `page` và `limit`.

## 2. Yêu cầu giao diện

Tại tiêu đề **Chi tiết chấm công**:

- Mặc định hiển thị **20 dòng/trang**.
- Có select chọn `20/trang`, `50/trang`, `100/trang`.
- Hiển thị phạm vi và tổng số bản ghi, ví dụ: `21–40 / 126 buổi`.
- Khi đổi số dòng/trang, quay về trang 1 rồi tải lại dữ liệu.

Bên dưới bảng có điều khiển:

- Nút `← Trước`.
- Chỉ báo `Trang X / Y`.
- Nút `Sau →`.
- Disable `Trước` tại trang 1.
- Disable `Sau` tại trang cuối.
- Không cần hiện điều khiển nếu `totalPages <= 1`.

Trên mobile, cụm phân trang phải vừa chiều ngang, nút đủ lớn để bấm và không làm tràn màn hình.

## 3. Đồng bộ với bộ lọc

Các bộ lọc hiện tại phải được giữ nguyên khi chuyển trang:

- Khoảng ngày.
- Giáo viên.
- Trường.
- Trạng thái chấm công.
- Chỉ buổi chưa chấm.

Khi một bộ lọc API thay đổi:

1. Đặt `page = 1`.
2. Gọi lại API với toàn bộ bộ lọc mới cùng `limit` hiện tại.
3. Không để response của request cũ ghi đè response mới nếu người dùng đổi bộ lọc nhanh.

Không lưu `page` cũ giữa hai bộ lọc khác nhau vì có thể dẫn tới trang rỗng.

## 4. Trạng thái bảng

- Khi tải trang mới: hiển thị loading và ngăn bấm chuyển trang liên tục.
- API lỗi: giữ thông báo lỗi hiện có của ứng dụng.
- `data = []` và `total = 0`: hiển thị empty state hiện tại.
- Nếu xóa/chỉnh sửa làm trang hiện tại không còn dữ liệu và `page > 1`, tự lùi về trang trước rồi tải lại.

## 5. Chấm công và dữ liệu chưa lưu

- Chỉ gửi các dòng người dùng thực sự thay đổi khi bấm **Lưu chấm công**.
- Trước khi chuyển trang, nếu trang hiện tại có thay đổi chưa lưu, phải cảnh báo người dùng hoặc giữ chúng an toàn theo `sessionId`; không được âm thầm làm mất thay đổi.
- Sau khi lưu thành công, tải lại đúng trang hiện tại và giữ nguyên bộ lọc.
- Tổng tiền hiển thị tại tab chi tiết chỉ được coi là tổng của trang hiện tại. Nếu có nhiều trang, ghi rõ phạm vi đang tính hoặc dùng số liệu từ API tổng hợp, không cộng nhầm thành tổng toàn bộ kết quả.

## 6. Tiêu chí nghiệm thu

- [ ] Lần đầu vào bảng gọi API với `page=1&limit=20`.
- [ ] Có 21 bản ghi thì xuất hiện 2 trang.
- [ ] Bấm trang sau gọi API với `page=2`, giữ nguyên mọi bộ lọc.
- [ ] Đổi từ 20 sang 50 dòng đặt lại `page=1`.
- [ ] Đổi giáo viên, trường, trạng thái hoặc khoảng ngày đều quay về trang 1.
- [ ] Hiển thị đúng `1–20 / total`, `21–40 / total`.
- [ ] Nút Trước/Sau disable đúng ở hai đầu.
- [ ] Không xuất hiện kết quả cũ khi đổi bộ lọc liên tục.
- [ ] Không mất các dòng chấm công chưa lưu khi người dùng vô tình chuyển trang.
- [ ] Giao diện hoạt động tốt trên mobile và desktop.
- [ ] Build frontend không có lỗi TypeScript.

