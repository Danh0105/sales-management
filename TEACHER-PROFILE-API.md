# API hồ sơ cá nhân giáo viên

## Contract

`GET /teachers/me` và `PATCH /teachers/me` yêu cầu `Authorization: Bearer <JWT>`.
Endpoint cập nhật chỉ chấp nhận role `giaovien`; hồ sơ được xác định từ `sub` trong JWT.

`PATCH /teachers/me` dùng `multipart/form-data`, cho phép các field tùy chọn: `name`,
`phone`, `email`, `avatar`, `removeAvatar`. Không gửi đồng thời `avatar` và
`removeAvatar=true`. Các field ngoài danh sách (role, trạng thái, lương, trường, môn...) trả 400.

Response của cả hai endpoint:

```json
{
  "id": 123,
  "name": "Nguyễn Văn A",
  "phone": "0901234567",
  "email": "teacher@example.com",
  "avatarUrl": "https://api.example.com/uploads/avatars/uuid.webp",
  "updatedAt": "2026-08-11T10:00:00.000Z"
}
```

`avatarUrl` có thể là `null`. Tên được đọc từ database nên không cần cấp lại JWT;
claim `name` cũ trong JWT chỉ thay đổi ở lần cấp token tiếp theo.

## Curl

```bash
# Cập nhật thông tin
curl -X PATCH https://api.example.com/teachers/me \
  -H "Authorization: Bearer $TOKEN" \
  -F 'name=Nguyễn Văn A' \
  -F 'phone=0901234567' \
  -F 'email=teacher@example.com'

# Tải avatar
curl -X PATCH https://api.example.com/teachers/me \
  -H "Authorization: Bearer $TOKEN" \
  -F 'avatar=@avatar.png'

# Xóa avatar
curl -X PATCH https://api.example.com/teachers/me \
  -H "Authorization: Bearer $TOKEN" \
  -F 'removeAvatar=true'
```

## Storage

- `PUBLIC_BASE_URL`: origin public, ví dụ `https://api.example.com`; bỏ trống để trả URL tương đối.
- `AVATAR_UPLOAD_DIR`: thư mục lưu file; mặc định là `uploads/avatars` trong project.
- Giới hạn upload cố định: 10 MB. JPEG/PNG/WebP được kiểm tra bằng magic bytes,
  crop vuông ở giữa, resize tối đa 512×512 và lưu WebP quality 82.
