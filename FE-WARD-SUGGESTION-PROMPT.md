# Prompt cập nhật FE — Tạo đề xuất theo xã/phường

Bạn là Senior Frontend Developer. Hãy cập nhật màn hình **Đề xuất** để người dùng có thể tạo đề xuất gắn trực tiếp với một xã/phường mình phụ trách.

## 1. Mục tiêu

- Người dùng chọn xã/phường trước khi gửi đề xuất.
- Đề xuất được lưu với `wardId`, kể cả khi chưa có chính sách.
- Có thể chọn một chính sách thuộc xã/phường đó để gắn vào đề xuất.
- Không cho phép chọn chính sách của xã/phường khác.
- Giữ nguyên luồng đề xuất thường hiện tại; không áp dụng endpoint này cho đề xuất chi.

## 2. API tạo đề xuất theo xã/phường

```http
POST /suggest/wards/:wardId
Authorization: Bearer <access_token>
Content-Type: multipart/form-data
```

Trong đó `wardId` là ID xã/phường được chọn trên giao diện.

Các trường form-data:

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---:|---|---|
| `content` | Có | string | Tiêu đề/nội dung chính của đề xuất |
| `component` | Không | string | Thành phần liên quan |
| `description` | Không | string | Mô tả chi tiết |
| `issueDate` | Không | `YYYY-MM-DD` | Ngày đề xuất |
| `policyId` | Không | number | Chính sách thuộc xã/phường đang chọn |
| `status` | Không | enum | Nếu không gửi, backend mặc định `PENDING` |
| `file` | Không | File | Tệp đính kèm |

Không gửi `type=EXPENSE_REQUEST`. Endpoint này luôn tạo đề xuất thường.

Ví dụ:

```ts
const form = new FormData();
form.append('content', values.content.trim());

if (values.component?.trim()) {
  form.append('component', values.component.trim());
}
if (values.description?.trim()) {
  form.append('description', values.description.trim());
}
if (values.issueDate) {
  form.append('issueDate', values.issueDate);
}
if (values.policyId) {
  form.append('policyId', String(values.policyId));
}
if (values.file) {
  form.append('file', values.file);
}

await api.post(`/suggest/wards/${values.wardId}`, form);
```

Không tự đặt header `Content-Type` nếu HTTP client cần tự sinh multipart boundary.

## 3. Dữ liệu xã/phường

Dùng API xã/phường hiện có để tải danh sách mà tài khoản được phép xem. Ưu tiên danh sách đã lọc theo tỉnh hoặc phạm vi phụ trách của người dùng.

Mỗi lựa chọn tối thiểu cần:

```ts
type WardOption = {
  id: number;
  name: string;
  provinceId?: number | null;
  provinceName?: string | null;
};
```

Nếu nhiều tỉnh có xã/phường trùng tên, nhãn lựa chọn phải kèm tỉnh:

```text
Phường Tân Lập — Tỉnh Thái Nguyên
```

## 4. Giao diện form

Thêm trường **Xã/phường** vào đầu form tạo đề xuất:

- Select có tìm kiếm theo tên.
- Bắt buộc chọn trước khi gửi.
- Hiển thị lỗi tại trường nếu chưa chọn.
- Nếu tài khoản chỉ có đúng một xã/phường, tự chọn giá trị đó.
- Khi đổi xã/phường, reset `policyId` đang chọn và tải lại danh sách chính sách phù hợp.

Trường **Chính sách liên quan**:

- Không bắt buộc.
- Chỉ hiển thị chính sách thuộc xã/phường đã chọn.
- Disable khi chưa chọn xã/phường.
- Có lựa chọn “Không gắn chính sách”.
- Hiển thị đủ môn học, trường, năm học và trạng thái để tránh chọn nhầm.

Không thay đổi các trường nội dung, mô tả, ngày và file đang có.

## 5. Kiểu dữ liệu đề xuất

Bổ sung vào type/model đề xuất:

```ts
type WardSummary = {
  id: number;
  name: string;
  province_id?: number | null;
};

type Suggestion = {
  id: number;
  content: string;
  component?: string | null;
  description?: string | null;
  issueDate?: string | null;
  fileUrl?: string | null;
  policyId?: number | null;
  wardId?: number | null;
  ward?: WardSummary | null;
  status: string;
  createdAt: string;
};
```

Không suy luận xã/phường từ nội dung đề xuất. Ưu tiên `ward`; nếu API cũ chưa trả relation thì dùng `wardId` để tra trong danh mục.

## 6. Danh sách và chi tiết đề xuất

- Hiển thị tên xã/phường trên mỗi dòng/card đề xuất.
- Ở trang chi tiết, thêm dòng “Xã/phường”.
- Nếu có `policyId`, tiếp tục hiển thị chính sách liên quan như hiện tại.
- Dữ liệu cũ có `wardId = null` phải hiển thị “Chưa xác định”, không làm hỏng trang.
- Sau khi tạo thành công, invalidate/refetch danh sách và điều hướng về danh sách hoặc trang chi tiết theo convention hiện tại.

## 7. Xử lý lỗi

Hiển thị message do backend trả về. Ánh xạ tối thiểu:

| HTTP | Message backend | Cách hiển thị |
|---:|---|---|
| 400 | `Chính sách không thuộc xã/phường đã chọn` | Báo tại trường chính sách và yêu cầu chọn lại |
| 403 | `Bạn không phụ trách xã/phường này` | Báo không có quyền và refetch danh sách xã/phường |
| 404 | `Xã/phường không tồn tại` | Báo dữ liệu đã thay đổi và refetch danh mục |
| 404 | `Chính sách không tồn tại` | Reset `policyId` và tải lại chính sách |
| 401 | Token hết hạn/không hợp lệ | Dùng luồng đăng nhập lại hiện có |

Trong lúc gửi:

- Disable nút gửi để tránh double submit.
- Hiển thị loading.
- Không đóng form khi request thất bại.
- Không mất nội dung người dùng đã nhập khi lỗi quyền hoặc lỗi mạng.

## 8. Tương thích luồng cũ

- Luồng mới gọi `POST /suggest/wards/:wardId`.
- Không tiếp tục gọi `POST /suggest` cho form tạo đề xuất theo xã/phường.
- Các màn đọc đề xuất phải chấp nhận cả dữ liệu mới có `ward/wardId` và dữ liệu cũ không có hai trường này.
- Không thay đổi các API `/expense-requests`; đề xuất chi là một workflow khác.

## 9. Checklist nghiệm thu

- [ ] Không chọn xã/phường thì không gửi được form.
- [ ] Tài khoản chỉ có một xã/phường được tự động chọn.
- [ ] Đổi xã/phường sẽ xóa chính sách đã chọn.
- [ ] Danh sách chính sách chỉ chứa dữ liệu thuộc xã/phường đang chọn.
- [ ] Tạo đề xuất không gắn chính sách thành công và response có `wardId`.
- [ ] Tạo đề xuất có `policyId` hợp lệ thành công.
- [ ] Chính sách khác xã/phường trả lỗi và form giữ nguyên dữ liệu.
- [ ] Người không phụ trách xã/phường nhận lỗi 403 rõ ràng.
- [ ] File đính kèm được upload đúng bằng multipart/form-data.
- [ ] Danh sách và chi tiết hiển thị đúng tên xã/phường.
- [ ] Đề xuất cũ có `wardId = null` vẫn hiển thị bình thường.
- [ ] Sau khi tạo thành công, danh sách được refetch và có bản ghi mới.

