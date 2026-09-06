# PROMPT: CẬP NHẬT FE MINI APP — CHẤM CÔNG THEO BLOCK VÀ BÁO GIẢNG

Bạn là Senior Frontend Developer phụ trách Zalo Mini App dành cho giáo viên. Backend vừa thay đổi luồng chấm công và báo giảng. Hãy cập nhật Mini App theo đúng contract dưới đây, tái sử dụng layout, API client, auth, upload component, camera/GPS service, toast, dialog và design system hiện có.

Không thay đổi các màn quản trị, không tự suy luận trạng thái từ riêng `checkinAt`, và không giữ luồng checkout cũ có nội dung bài học.

## 1. Nghiệp vụ tổng quát

Các tiết của cùng giáo viên trong cùng ngày được sắp theo giờ bắt đầu. Các tiết đứng liên tiếp trong danh sách và có cùng `schoolId` tạo thành một block, không xét khoảng nghỉ.

Backend trả hai cờ cho từng session:

```ts
checkinRequired: boolean;
checkoutRequired: boolean;
```

Quy tắc hiển thị:

| Vị trí trong block | Check-in | Check-out |
|---|---:|---:|
| Buổi lẻ | Có | Có |
| Tiết đầu block nhiều tiết | Có | Không |
| Tiết giữa | Không | Không |
| Tiết cuối block nhiều tiết | Không | Có |

Chỉ render nút theo hai cờ backend trả về. Không tự nhóm lại ở FE để quyết định quyền thao tác.

## 2. API lấy danh sách và chi tiết

Áp dụng dữ liệu mới cho:

```http
GET /teaching-sessions/me
GET /teaching-sessions/:id
```

Các field FE cần dùng:

```ts
type TeachingSessionAttendance = {
  id: number;
  schoolId: number;
  date: string;
  startTime: string;
  endTime: string;

  checkinRequired: boolean;
  checkoutRequired: boolean;

  checkinAt: string | null;
  checkinImages: Array<{
    id: number;
    url: string;
  }>;

  checkoutAt: string | null;

  lessonName: string | null;
  lessonEvaluation: string | null;
  actualStudentCount: number | null;
  lessonImages: Array<{
    id: number;
    url: string;
    mimeType?: string;
    mediaType?: 'video';
  }>;
  lessonSubmittedAt: string | null;
  lessonReportDueAt: string | null;
};
```

`lessonImages` giữ tên field cũ để tương thích database, nhưng hiện chứa cả ảnh và video. Nếu `mediaType === 'video'`, render video player/thumbnail phù hợp; còn lại render ảnh.

## 3. Check-in bắt buộc chụp ảnh

Endpoint:

```http
POST /teaching-sessions/:id/checkin
Content-Type: multipart/form-data
```

Form:

```text
latitude   bắt buộc
longitude  bắt buộc
image      bắt buộc, đúng 1 ảnh
```

Yêu cầu FE:

- Chỉ hiện nút **“Check-in”** khi `checkinRequired === true` và `checkinAt == null`.
- Khi bấm, yêu cầu quyền vị trí và camera/thư viện ảnh theo cơ chế Mini App hiện có.
- Ưu tiên camera để giáo viên chụp ảnh tại thời điểm check-in.
- Cho preview ảnh, đổi/chụp lại trước khi gửi.
- Chỉ nhận JPEG, PNG hoặc WebP; tối đa 10 MB.
- Nén ảnh phía client nếu component hiện có hỗ trợ, nhưng không làm mất EXIF orientation hoặc khiến ảnh khó nhận diện.
- Không gọi API nếu thiếu GPS hoặc ảnh.
- Dùng `FormData`; tên file bắt buộc là `image`, không dùng `images`.
- Sau thành công, refetch danh sách và chi tiết; hiển thị thời gian check-in và ảnh trong `checkinImages`.

Ví dụ:

```ts
const form = new FormData();
form.append('latitude', String(latitude));
form.append('longitude', String(longitude));
form.append('image', imageFile);
await api.post(`/teaching-sessions/${id}/checkin`, form);
```

Các lỗi nghiệp vụ cần map:

| Code | Cách hiển thị |
|---|---|
| `TEACHING_SESSION_CHECKIN_IMAGE_REQUIRED` | “Vui lòng chụp ảnh khi check-in” |
| `TEACHING_SESSION_CHECKIN_IMAGE_TYPE_UNSUPPORTED` | “Ảnh phải là JPEG, PNG hoặc WebP” |
| `TEACHING_SESSION_CHECKIN_NOT_REQUIRED` | Đóng modal, refetch và báo “Tiết này không cần check-in” |

Các lỗi GPS, sai giáo viên, sai ngày hoặc đã check-in tiếp tục hiển thị message backend.

## 4. Checkout chỉ còn GPS

Endpoint:

```http
POST /teaching-sessions/:id/checkout
Content-Type: multipart/form-data
```

Form mới:

```text
latitude   bắt buộc
longitude  bắt buộc
accuracy   không bắt buộc
```

Đã loại bỏ hoàn toàn khỏi checkout:

- `lessonName`
- `lessonEvaluation`
- `images`
- `actualStudentCount`

Yêu cầu FE:

- Chỉ hiện nút **“Check-out”** khi `checkoutRequired === true` và `checkoutAt == null`.
- Không hiện form tên bài học, đánh giá, sĩ số hoặc upload minh chứng trong modal checkout.
- Checkout tiết cuối block có thể thành công dù chính tiết đó và toàn bộ block chưa có `checkinAt`; không chặn ở FE bằng điều kiện `checkinAt == null`.
- Buổi lẻ vẫn cần check-in trước; backend sẽ trả `TEACHING_SESSION_NOT_CHECKED_IN` nếu chưa check-in.
- Sau checkout thành công, refetch toàn bộ danh sách của ngày hiện tại, không chỉ patch item vừa bấm. Backend đánh dấu `checkoutAt` cho tất cả tiết trong block.
- Mọi tiết trong block có `checkoutAt != null` phải hiển thị trạng thái **“Đã chấm công”**.

Các lỗi cần map:

| Code | Cách hiển thị |
|---|---|
| `TEACHING_SESSION_CHECKOUT_NOT_REQUIRED` | “Tiết này không cần check-out” |
| `TEACHING_SESSION_NOT_CHECKED_IN` | “Vui lòng check-in trước khi check-out” — chỉ xảy ra với buổi lẻ |
| `TEACHING_SESSION_ALREADY_CHECKED_OUT` | Refetch và hiển thị trạng thái đã chấm công |

## 5. Báo giảng là thao tác riêng sau chấm công

Endpoint:

```http
POST /teaching-sessions/:id/lesson
Content-Type: multipart/form-data
```

Form:

```text
lessonName          bắt buộc, tối đa 255 ký tự
lessonEvaluation    bắt buộc, tối đa 2000 ký tự
actualStudentCount  bắt buộc, số nguyên >= 0
images              bắt buộc, từ 1 đến 10 file ảnh hoặc video
```

Định dạng minh chứng:

- Ảnh: JPEG, PNG, WebP.
- Video: MP4, MOV, WebM.
- Mỗi file không quá 50 MB.
- Tên multipart vẫn là `images` cho cả ảnh và video.

Yêu cầu giao diện:

- Khi `checkoutAt != null` và `lessonSubmittedAt == null`, item có nút **“Báo giảng”** nổi bật.
- Đây là thao tác người dùng bấm lại trên tiết đã có nhãn “Đã chấm công”.
- Mỗi tiết trong block phải báo giảng riêng.
- Form gồm Tên bài học, Đánh giá buổi học, Sĩ số thực tế và khu vực tải ảnh/video minh chứng.
- Sĩ số dùng bàn phím số, cho phép `0`, không cho số âm hoặc số thập phân.
- Hiển thị danh sách file, loại file, dung lượng, preview và nút xóa trước khi gửi.
- Với video nên hiển thị thumbnail/player; không đọc toàn bộ video thành base64 nếu API upload hiện có hỗ trợ Blob/File trực tiếp.
- Chặn file sai định dạng hoặc trên 50 MB ngay tại client, nhưng vẫn hiển thị message backend nếu server từ chối.
- Disable nút gửi và hiện tiến độ trong lúc upload; ngăn gửi hai lần.
- Sau thành công, refetch session và hiển thị **“Đã báo giảng”**, thời gian nộp cùng nội dung đã gửi.

Các lỗi nghiệp vụ:

| Code | Cách hiển thị |
|---|---|
| `TEACHING_SESSION_NOT_ATTENDED` | “Tiết dạy chưa hoàn tất chấm công” |
| `TEACHING_SESSION_LESSON_EVIDENCE_REQUIRED` | “Vui lòng tải lên ít nhất một ảnh hoặc video minh chứng” |
| `TEACHING_SESSION_LESSON_ALREADY_SUBMITTED` | Refetch và báo “Tiết này đã báo giảng” |
| `TEACHING_SESSION_LESSON_DEADLINE_EXPIRED` | “Đã quá hạn báo giảng lúc 08:00 ngày hôm sau” |
| `LESSON_IMAGE_TOO_LARGE` | “Mỗi ảnh hoặc video không được vượt quá 50 MB” |
| `LESSON_IMAGE_LIMIT_EXCEEDED` | “Chỉ được tải lên tối đa 10 file” |
| `LESSON_IMAGE_TYPE_UNSUPPORTED` | Hiển thị message backend |

## 6. Hạn báo giảng

- Hạn của mỗi tiết là `lessonReportDueAt`, tương ứng 08:00 sáng ngày hôm sau theo giờ Việt Nam.
- Dùng timestamp backend trả về để hiển thị; không tự cộng ngày từ chuỗi date nếu đã có `lessonReportDueAt`.
- Trước hạn: hiển thị “Hạn báo giảng: 08:00 ngày DD/MM/YYYY”.
- Sau 19:00 ngày dạy mà chưa báo: đổi sang trạng thái cảnh báo màu vàng/cam, không dùng màu đỏ khi vẫn còn hạn.
- Khi đã quá `lessonReportDueAt`: disable nút báo giảng và hiển thị “Đã quá hạn báo giảng”.
- Quyết định cuối cùng vẫn theo response backend; nếu đồng hồ client lệch và backend trả lỗi hết hạn thì refetch lại dữ liệu.

## 7. Thông báo lúc 19:00

Backend tạo notification:

```ts
type: 'TEACHING_LESSON_REPORT_ALERT';
meta: {
  kind: 'lesson_report_missing';
  module: 'teaching';
  route: 'teaching-sessions';
  url: '/teacher/teaching-sessions';
  date: string;
  sessionIds: number[];
};
```

FE Mini App cần:

- Không lọc bỏ notification type mới.
- Hiển thị tiêu đề **“Nhắc báo giảng”** và message backend.
- Khi bấm notification, mở danh sách buổi dạy ngày `meta.date`.
- Nếu chỉ có một `sessionId`, có thể mở thẳng chi tiết session đó; nếu nhiều tiết, mở danh sách và highlight các ID trong `sessionIds`.
- Badge chưa đọc dùng cùng cơ chế notification hiện có.

## 8. Trạng thái và nút hành động

Không dùng riêng `checkinAt` để kết luận toàn bộ trạng thái. Áp dụng thứ tự:

```ts
const attended = session.checkoutAt != null;
const lessonReported = session.lessonSubmittedAt != null;

if (lessonReported) {
  // “Đã báo giảng” — cho xem nội dung, không cho gửi lại
} else if (attended) {
  // “Đã chấm công” + nút “Báo giảng” nếu chưa quá hạn
} else {
  // Hiện Check-in/Check-out theo checkinRequired/checkoutRequired
}
```

Với tiết giữa của block:

- `checkinRequired === false`
- `checkoutRequired === false`
- Trước khi tiết cuối checkout: không có nút chấm công riêng.
- Sau khi tiết cuối checkout: backend trả `checkoutAt`, hiển thị “Đã chấm công” và cho báo giảng riêng.

## 9. Cache và đồng bộ dữ liệu

- Sau check-in: invalidate/refetch danh sách ngày và chi tiết session.
- Sau checkout: bắt buộc invalidate/refetch **toàn bộ danh sách ngày**, vì nhiều session được cập nhật cùng lúc.
- Sau báo giảng: invalidate/refetch danh sách ngày, chi tiết và notification/badge liên quan.
- Không optimistic-update riêng một session cho checkout block trừ khi cập nhật được toàn bộ block từ response; ưu tiên refetch.
- Chặn double click và request đồng thời trên cùng session.

## 10. Kiểm thử FE bắt buộc

Viết hoặc cập nhật test theo framework hiện có:

1. Tiết đầu block hiện Check-in; tiết giữa không hiện nút; tiết cuối hiện Check-out.
2. Check-in không có ảnh không gọi API.
3. Check-in gửi đúng multipart field `image` cùng GPS.
4. Checkout không còn gửi tên bài, đánh giá, sĩ số hoặc file.
5. Checkout tiết cuối không bị FE chặn khi `checkinAt == null`.
6. Sau checkout, refetch danh sách và tất cả tiết có `checkoutAt` hiện “Đã chấm công”.
7. Tiết đã chấm công nhưng chưa báo giảng hiện nút “Báo giảng”.
8. Báo giảng gửi đúng `lessonName`, `lessonEvaluation`, `actualStudentCount` và nhiều field `images`.
9. Client chặn file trên 50 MB, sai định dạng, quá 10 file và thiếu minh chứng.
10. Render được cả ảnh và video trong nội dung đã báo giảng.
11. Disable báo giảng khi quá `lessonReportDueAt`.
12. Notification `TEACHING_LESSON_REPORT_ALERT` điều hướng đúng ngày/session.
13. Xử lý đúng các error code được liệt kê, không hiển thị lỗi kỹ thuật thô.

## 11. Tiêu chí nghiệm thu

- Giáo viên check-in tiết đầu bằng GPS và một ảnh.
- Checkout tiết cuối chỉ gửi GPS và đánh dấu toàn block đã chấm công.
- Từng tiết đã chấm công có thể mở lại để báo giảng riêng.
- Báo giảng đủ tên bài, đánh giá, sĩ số và ảnh/video dưới 50 MB.
- Không thể báo giảng sau 08:00 hôm sau.
- Notification lúc 19:00 xuất hiện và điều hướng đúng cho giáo viên còn thiếu.
- Không ảnh hưởng luồng xác nhận lịch, xem lịch hoặc các notification teaching khác.
- Typecheck, lint và toàn bộ test liên quan chạy thành công.

Sau khi hoàn thành, báo cáo các file đã sửa, thay đổi API client/types, cách quản lý state sau checkout block và kết quả test.
