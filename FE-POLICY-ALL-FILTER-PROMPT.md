# PROMPT: CẬP NHẬT BỘ LỌC “TẤT CẢ CHÍNH SÁCH”

Bạn là Senior Frontend Developer. Hãy cập nhật **bộ lọc tại tab “Tất cả chính sách”** trong màn quản lý chính sách hiện có. Giữ nguyên layout, component dùng chung, phân quyền, màn chi tiết và các tab khác. Không tạo màn hình hoặc design system mới.

Tài liệu API đầy đủ: `POLICY-ADMIN-LIST-API.md`.

## 1. API bắt buộc sử dụng

### Danh sách

```http
GET /policies/all
```

Query hỗ trợ:

```ts
type PolicyAllFilters = {
  status?: 'DRAFT' | 'PENDING' | 'SALE_ADMIN_APPROVED' | 'DIRECTOR_APPROVED' | 'REJECTED';
  schoolId?: number;
  subjectId?: number;
  schoolYear?: string;
  employeeId?: number;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
  page?: number;     // mặc định 1
  limit?: number;    // mặc định 12, tối đa 100
};
```

Response:

```ts
type PolicyAllResponse = {
  data: Array<{
    policyId: number;
    policyStatus: string;
    policyCreatedAt: string;
    schoolId: number;
    schoolName: string;
    subjectId: number;
    subjectName: string;
    schoolYear: string | null;
    employeeId: number | null;
    employeeName: string | null;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};
```

Lưu ý: endpoint này dùng `policyStatus`, `policyCreatedAt`, `pagination`; không đọc nhầm thành `status`, `createdAt`, `meta`.

### Dữ liệu cho bộ lọc

```http
GET /policies/filter-options
```

```ts
type PolicyFilterOptions = {
  statuses: Array<{ value: string; label: string }>;
  schools: Array<{ id: number; name: string }>;
  subjects: Array<{ id: number; name: string }>;
  schoolYears: string[];
  employees: Array<{ id: number; name: string }>;
};
```

Không tự tổng hợp option từ trang danh sách hiện tại. Danh sách option đã được backend giới hạn theo phạm vi của tài khoản đăng nhập.

## 2. Giao diện bộ lọc

Hiển thị đầy đủ các trường:

1. **Trạng thái** — select từ `statuses`, hiển thị `label`, gửi `value`.
2. **Trường học** — select từ `schools`, gửi `schoolId`.
3. **Môn học** — select từ `subjects`, gửi `subjectId`.
4. **Năm học** — select từ `schoolYears`, giữ nguyên cả giá trị dạng `2026-2027` và `Hè 2026-2027`.
5. **Nhân viên phụ trách** — select từ `employees`, gửi `employeeId`.
6. **Từ ngày / Đến ngày** — date picker, gửi `fromDate` và `toDate` theo `YYYY-MM-DD`.

Thêm nút **“Xóa bộ lọc”**. Chỉ hiển thị trạng thái active/nút xóa khi có ít nhất một filter đang được áp dụng. Nếu thiết kế hiện tại có khu vực filter thu gọn trên mobile thì tiếp tục dùng đúng component đó.

Không thêm ô tìm kiếm hoặc sắp xếp vào request `/policies/all` vì endpoint này không hỗ trợ hai chức năng đó.

## 3. Hành vi bắt buộc

- Lần đầu vào tab: gọi song song `/policies/filter-options` và `/policies/all?page=1&limit=12`.
- Các filter kết hợp theo AND; chỉ gửi tham số có giá trị, không gửi chuỗi rỗng, `null`, `undefined` hoặc ID bằng `0`.
- Mỗi khi đổi một filter hoặc xóa bộ lọc, đưa `page` về `1` rồi tải lại danh sách.
- Khi đổi trang, giữ nguyên toàn bộ filter đang chọn.
- Khi đổi `limit`, đưa `page` về `1`.
- Debounce thao tác filter khoảng 300–500 ms nếu component thay đổi giá trị tức thời; select/date chỉ gọi API một lần cho mỗi lựa chọn hoàn chỉnh.
- Hủy hoặc bỏ qua response cũ khi user đổi filter nhanh, tránh request trước ghi đè kết quả mới.
- Đồng bộ filter hợp lệ vào URL query để reload/back/forward vẫn giữ trạng thái. Khi đọc URL, parse ID/page/limit thành số trước khi gọi API.
- Nút “Xóa bộ lọc” xóa sáu filter, giữ `limit`, đặt `page=1`; đồng thời cập nhật URL và gọi lại API.
- Nếu `fromDate > toDate`, chặn request và hiển thị lỗi cạnh khoảng ngày: **“Từ ngày không được lớn hơn Đến ngày”**.
- Backend trả 400 thì hiển thị message backend; không xóa lựa chọn hiện tại.

Ví dụ request đúng:

```http
GET /policies/all?page=1&limit=12&status=DIRECTOR_APPROVED&schoolId=529&subjectId=795&schoolYear=2026-2027&employeeId=17&fromDate=2026-01-01&toDate=2026-08-25
```

Hãy tạo query bằng `URLSearchParams` hoặc cơ chế serializer hiện có, không nối chuỗi thủ công. Giá trị `Hè 2026-2027` phải được URL-encode đúng.

## 4. Trạng thái UI

- Loading danh sách: dùng skeleton/loading hiện có và không làm nhảy layout bộ lọc.
- Loading option: disable từng select hoặc hiển thị loading trong select.
- Danh sách rỗng khi có filter: **“Không có chính sách phù hợp với bộ lọc.”**
- Danh sách rỗng khi không có filter: giữ empty state hiện tại.
- Lỗi tải option không được làm mất danh sách chính sách; cho phép thử tải lại option.
- Tổng số bản ghi và phân trang lấy từ `response.pagination`, tuyệt đối không phân trang client-side.
- Click một item vẫn mở `/director/policy/:policyId` như hiện tại.

## 5. Yêu cầu kỹ thuật

- Tái sử dụng API client, query/cache library, select, date picker, pagination và toast hiện có.
- Dùng một state/object duy nhất làm nguồn dữ liệu cho query; tránh tách filter state và URL state khiến lệch nhau.
- Query key/cache key phải chứa đủ sáu filter, `page` và `limit`.
- Không gọi API thống kê lặp theo từng nhân viên và không tải `GET /policies` cũ để lọc trên trình duyệt.
- Không thay đổi contract backend, không hard-code option, role hoặc tỉnh/thành ở FE.
- Các field `employeeId`, `employeeName`, `schoolYear` có thể là `null`; render fallback `—`.

## 6. Kiểm thử cần bổ sung

Viết/cập nhật test theo framework hiện có, tối thiểu gồm:

1. Render đủ sáu bộ lọc từ `/policies/filter-options`.
2. Chọn nhiều filter tạo đúng query và reset `page=1`.
3. Không gửi các filter rỗng.
4. Đổi trang vẫn giữ filter.
5. Xóa bộ lọc giữ `limit`, đưa về trang 1 và làm sạch URL.
6. Chặn khoảng ngày ngược, không gọi API.
7. Response cũ không ghi đè response mới khi đổi filter nhanh.
8. Render đúng empty state, lỗi API và các field nullable.
9. Reload với URL có filter khôi phục đúng UI và request.

## 7. Tiêu chí nghiệm thu

- Tab “Tất cả chính sách” lọc đúng theo trạng thái, trường, môn, năm học, nhân viên và khoảng ngày.
- Filter, URL, request và phân trang luôn đồng bộ.
- Không còn lọc/phân trang dữ liệu ở FE và không phát sinh N+1 request.
- Không ảnh hưởng các tab chính sách khác hoặc luồng mở chi tiết.
- Typecheck, lint và toàn bộ test liên quan đều chạy thành công.

Sau khi hoàn thành, báo cáo ngắn các file đã sửa, cách quản lý state/query và kết quả test.
