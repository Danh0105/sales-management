# Prompt triển khai FE Admin — Duyệt thay đổi vị trí giáo viên

Bạn đang làm việc trong dự án frontend Admin. Hãy triển khai đầy đủ luồng Nhân sự/Giáo vụ nhận thông báo và duyệt yêu cầu thay đổi vị trí của giáo viên theo đặc tả dưới đây. Tận dụng component, API client, modal, toast, notification dropdown và hệ thống phân quyền đang có; không tạo một hệ thống UI song song.

## Mục tiêu

Khi giáo viên đã có vị trí và gửi vị trí mới, backend tạo yêu cầu chờ duyệt. Tất cả tài khoản có role `nhansu` hoặc `giaovu` nhận thông báo. Khi người dùng click thông báo, FE phải mở popup chi tiết ngay tại màn hình hiện tại để họ:

- xem thông tin giáo viên;
- so sánh vị trí hiện tại và vị trí đề nghị;
- duyệt vị trí mới;
- hoặc không duyệt và nhập lý do bắt buộc.

Không điều hướng sang một trang trắng hoặc trang không tồn tại. Nếu kiến trúc hiện tại bắt buộc điều hướng, hãy mở đúng trang quản lý giáo viên rồi tự động mở popup theo `requestId` trong metadata.

## Phân quyền

Chỉ hiển thị thao tác duyệt cho:

- `nhansu` — Nhân sự;
- `giaovu` — Giáo vụ.

Hai role có quyền và giao diện duyệt vị trí giống nhau. Không dùng điều kiện chỉ kiểm tra `nhansu`.

Các role khác không được thấy nút duyệt/từ chối. Backend vẫn là lớp kiểm soát quyền cuối cùng.

## Thông báo cần xử lý

Thông báo yêu cầu mới có:

```ts
type: 'TEACHER_LOCATION_CHANGE_REQUEST'
entityId: number // requestId
meta: {
  kind: 'teacher_location_change_request'
  module: 'teaching'
  route: '/teaching/teachers/location-change-requests'
  url: '/teaching/teachers/location-change-requests'
  requestId: number
  teacherId: number | null
}
```

Trong `NotificationDropdown`, khi click thông báo có type hoặc `meta.kind` trên:

1. lấy `requestId` theo thứ tự ưu tiên `meta.requestId`, sau đó `entityId`;
2. đánh dấu thông báo đã đọc bằng API notification hiện có;
3. tải yêu cầu đang chờ;
4. mở popup duyệt vị trí;
5. không gọi `window.location` khiến mất state nếu có thể mở modal trực tiếp.

Luôn đọc thống kê an toàn:

```ts
const unread = stats?.[type]?.unread ?? 0;
```

Một loại thông báo chưa xuất hiện trong response không được làm crash `PortalDropdown`.

## API backend

### Lấy các yêu cầu chờ duyệt

```http
GET /teachers/location-change-requests?status=pending
Authorization: Bearer <token>
```

`status` nhận một trong:

```ts
'pending' | 'approved' | 'rejected'
```

Response là mảng:

```ts
type TeacherLocationChangeRequest = {
  id: number;
  teacherId: number;
  teacherName: string | null;
  latitude: number;
  longitude: number;
  previousLatitude: number | null;
  previousLongitude: number | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy: number | null;
  reviewerName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
};
```

Backend hiện chưa có endpoint lấy riêng request theo ID. Sau khi nhận thông báo, gọi danh sách `status=pending` và tìm phần tử có `id === requestId`. Nếu không tìm thấy, tải thêm `approved` và `rejected` để xác định yêu cầu đã được người khác xử lý.

### Duyệt

```http
PATCH /teachers/location-change-requests/:id/approve
Content-Type: application/json
Authorization: Bearer <token>

{
  "note": "Đã kiểm tra vị trí"
}
```

`note` khi duyệt là tùy chọn, tối đa 500 ký tự.

Response:

```json
{
  "id": 15,
  "status": "approved"
}
```

### Không duyệt

```http
PATCH /teachers/location-change-requests/:id/reject
Content-Type: application/json
Authorization: Bearer <token>

{
  "note": "Vị trí gửi lên không đúng địa chỉ cư trú"
}
```

Ở FE, `note` là bắt buộc khi từ chối:

- trim khoảng trắng;
- tối thiểu 3 ký tự;
- tối đa 500 ký tự;
- không cho submit nếu chỉ chứa khoảng trắng;
- hiển thị lỗi ngay dưới textarea.

Response:

```json
{
  "id": 15,
  "status": "rejected"
}
```

## Popup chi tiết

Tiêu đề: `Duyệt thay đổi vị trí giáo viên`.

Hiển thị:

- tên giáo viên;
- mã giáo viên;
- thời gian gửi yêu cầu, định dạng theo múi giờ Việt Nam;
- trạng thái hiện tại;
- tọa độ hiện tại: `previousLatitude`, `previousLongitude`;
- tọa độ đề nghị: `latitude`, `longitude`;
- khoảng cách giữa hai vị trí nếu dự án đã có hàm tính khoảng cách;
- hai nút `Mở vị trí hiện tại` và `Mở vị trí đề nghị`.

Link Google Maps dựng từ tọa độ, không nối dữ liệu chưa kiểm tra:

```ts
const googleMapsUrl = (latitude: number, longitude: number) =>
  `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
```

Nếu `previousLatitude` hoặc `previousLongitude` là `null`, hiển thị `Chưa có vị trí` và ẩn nút mở vị trí hiện tại.

Nếu dự án có component bản đồ sẵn, có thể hiển thị hai marker với nhãn `Hiện tại` và `Đề nghị`. Không thêm thư viện bản đồ mới chỉ để phục vụ popup.

### Trạng thái pending

Footer popup gồm:

- nút phụ `Đóng`;
- nút danger `Không duyệt`;
- nút primary `Duyệt vị trí`.

Khi bấm `Duyệt vị trí`, hiển thị confirm ngắn: `Xác nhận cập nhật vị trí mới cho {teacherName}?`. Disable toàn bộ nút trong lúc gửi request để chống double click.

Khi bấm `Không duyệt`, chuyển popup sang bước nhập lý do hoặc mở confirm dialog có textarea. Không được gọi API trước khi lý do hợp lệ.

### Trạng thái đã xử lý

Nếu yêu cầu đã được người khác duyệt/từ chối:

- chỉ hiển thị thông tin;
- ẩn nút thao tác;
- hiển thị người xử lý, thời gian và ghi chú/lý do;
- hiện toast `Yêu cầu này đã được xử lý` nếu người dùng mở từ thông báo cũ.

Nếu API trả `409`, coi đây là trường hợp yêu cầu vừa được người khác xử lý: đóng loading, tải lại dữ liệu và chuyển popup sang chế độ chỉ xem. Không hiển thị lỗi kỹ thuật chung.

## Trạng thái sau thao tác

Sau khi duyệt thành công:

- toast: `Đã cập nhật vị trí mới cho {teacherName}`;
- cập nhật request thành `approved` trong local state hoặc refetch;
- loại request khỏi danh sách `pending`;
- cập nhật số lượng thông báo chưa đọc;
- không reload toàn trang.

Sau khi từ chối thành công:

- toast: `Đã từ chối yêu cầu thay đổi vị trí của {teacherName}`;
- cập nhật request thành `rejected`;
- loại request khỏi danh sách `pending`;
- cập nhật badge thông báo;
- không reload toàn trang.

Nếu API lỗi:

- giữ popup và dữ liệu người dùng đã nhập;
- bật lại nút;
- hiển thị message backend nếu an toàn, nếu không dùng thông báo dễ hiểu;
- `401`: đi theo luồng hết phiên hiện có;
- `403`: `Bạn không có quyền duyệt thay đổi vị trí`;
- `404`: `Yêu cầu thay đổi vị trí không còn tồn tại`;
- `409`: tải lại vì yêu cầu đã được xử lý;
- lỗi mạng: cho phép thử lại.

## Danh sách quản lý yêu cầu

Ngoài popup mở từ notification, bổ sung khu vực quản lý yêu cầu trong màn hình giáo viên hoặc module giảng dạy:

- tab `Chờ duyệt`, `Đã duyệt`, `Không duyệt`;
- badge số lượng ở tab chờ duyệt;
- tìm theo tên giáo viên ở client nếu lượng dữ liệu nhỏ;
- click một dòng mở cùng popup chi tiết;
- dùng chung component và hook xử lý với luồng notification.

Không nhân đôi modal hoặc logic gọi API giữa danh sách và dropdown.

## Gợi ý cấu trúc

Điều chỉnh theo conventions của repo, ví dụ:

```text
features/teacher-location/
  api.ts
  types.ts
  useTeacherLocationRequests.ts
  TeacherLocationApprovalModal.tsx
  TeacherLocationRequestList.tsx
```

API functions:

```ts
getTeacherLocationRequests(status)
approveTeacherLocationRequest(id, note?)
rejectTeacherLocationRequest(id, note)
```

Modal nhận tối thiểu:

```ts
type Props = {
  open: boolean;
  request: TeacherLocationChangeRequest | null;
  onClose(): void;
  onResolved?(requestId: number, status: 'approved' | 'rejected'): void;
};
```

## Yêu cầu chất lượng

- Giữ TypeScript strict, không dùng `any` để né type.
- Không đọc trực tiếp field lồng nhau nếu có thể thiếu; dùng fallback phù hợp.
- Không cho double submit.
- Popup dùng được trên desktop và mobile, nội dung dài phải scroll bên trong.
- Focus vào textarea khi mở bước từ chối.
- Giữ focus trap và hỗ trợ phím Escape theo modal chung của dự án.
- Không làm thay đổi hành vi của các loại notification khác.
- Không sửa role hoặc đường dẫn API ngoài đặc tả.

## Kiểm thử bắt buộc

Viết test phù hợp với stack hiện tại, tối thiểu bao phủ:

1. `nhansu` click thông báo và mở đúng request;
2. `giaovu` click thông báo và mở đúng request;
3. duyệt thành công, popup và danh sách cập nhật;
4. từ chối không có lý do bị chặn;
5. từ chối có lý do gọi đúng endpoint và payload;
6. request đã xử lý chỉ hiển thị, không có nút thao tác;
7. API `409` được refetch và không crash;
8. thiếu key thống kê notification không gây lỗi `.unread`;
9. double click chỉ phát sinh một request;
10. role không hợp lệ không thấy thao tác duyệt.

Sau khi triển khai, chạy typecheck, lint, unit/component test và build. Báo lại danh sách file đã sửa, hành vi hoàn thành và kết quả kiểm thử.
