# Prompt cập nhật FE — service giáo viên tổng hợp

Bạn là Senior Frontend Developer. Hãy cập nhật module quản lý giáo viên để **giáo viên công ty** và **giáo viên cộng tác viên** dùng chung một service/API, không duy trì hai nguồn dữ liệu hoặc hai model riêng.

## API thống nhất

Sử dụng duy nhất:

```http
GET /teachers
Authorization: Bearer <token>
```

Query hiện có vẫn giữ nguyên: `search`, `isActive`, `schoolId`, `page`, `limit`. Backend bổ sung:

```ts
teacherRole?: 'giaovien_congty' | 'giaovien_ctv';
```

Ví dụ:

```http
GET /teachers?teacherRole=giaovien_congty&page=1&limit=20
GET /teachers?teacherRole=giaovien_ctv&search=nguyen&page=1&limit=20
```

Response vẫn có shape phân trang cũ, mỗi item bổ sung `teacherRole`:

```ts
type TeacherRole = 'giaovien_congty' | 'giaovien_ctv';

interface TeacherListItem {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  employeeId: number | null;
  employeeName: string | null;
  teacherRole: TeacherRole | null;
  isActive: boolean;
  // các field cũ khác giữ nguyên
}

interface TeacherPage {
  data: TeacherListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

`teacherRole = null` là hồ sơ cũ/thuê ngoài chưa gắn tài khoản. Không tự suy luận loại từ `employeeId`, đơn giá hay vị trí.

## Yêu cầu triển khai

1. Tạo một hàm service dùng chung, ví dụ `getTeachers(params: GetTeachersParams): Promise<TeacherPage>`.
2. Màn danh sách có bộ lọc/tab: **Tất cả**, **Giáo viên công ty**, **Giáo viên cộng tác viên**. Tab Tất cả không gửi `teacherRole`; hai tab còn lại gửi đúng slug API.
3. Khi đổi tab, từ khoá, trường hoặc trạng thái hoạt động, reset `page = 1` rồi gọi lại API. Không tải toàn bộ dữ liệu về để lọc client-side.
4. Hiển thị badge theo `teacherRole`: `giaovien_congty` → “Giáo viên công ty”, `giaovien_ctv` → “Cộng tác viên”, `null` → “Chưa phân loại”.
5. Form tạo/sửa dùng cùng enum trên. Khi tạo tài khoản mới, gửi `teacherRole`; khi sửa giáo viên đã gắn tài khoản, gửi `teacherRole` nếu người dùng đổi loại.
6. Sau create/update/delete thành công, invalidate/refetch cùng query key của danh sách tổng hợp. Query key phải chứa toàn bộ filter và phân trang, đặc biệt là `teacherRole`.
7. Giữ nguyên phân quyền, empty state, loading và xử lý lỗi hiện tại. Với lỗi 400 do `teacherRole` sai, hiển thị `message` từ backend.

Không tạo endpoint giả như `/company-teachers` hay `/collaborator-teachers`, không ghép hai request ở FE, và không dùng chuỗi role cũ `giaovien`.

## Tiêu chí nghiệm thu

- Tab Tất cả hiển thị cả hai loại và badge đúng theo response.
- Mỗi tab loại chỉ gọi một request `GET /teachers` với query tương ứng.
- Tìm kiếm/phân trang trong từng tab không lẫn cache của tab khác.
- Giáo viên `teacherRole = null` chỉ xuất hiện ở Tất cả và được ghi rõ “Chưa phân loại”.
- Tạo/sửa loại giáo viên xong danh sách và badge cập nhật ngay.
- Không làm thay đổi các màn lịch dạy/chấm công đang dùng `teacherId`.
