# PROMPT: ZALO MINI APP — CẬP NHẬT XỬ LÝ LỖI ĐĂNG NHẬP (SO KHỚP ZALOID)

Bạn là Senior Frontend Developer làm Zalo Mini App cho giáo viên. Backend vừa thêm 1 lớp kiểm tra mới ở `POST /auth/login`: từ **lần đăng nhập thứ hai trở đi**, `zaloId` gửi lên phải khớp với `zaloId` đã ghi nhận từ lần đầu — khác đi (đổi điện thoại/tài khoản Zalo khác) thì bị từ chối. **Không cần đổi gì ở phần gửi request** (Mini App vẫn gửi `uid`/`zaloId` như cũ) — chỉ cần cập nhật cách xử lý lỗi trả về, nếu không giáo viên gặp trường hợp này sẽ thấy nhầm là "sai mật khẩu".

## 0. Vì sao cần đổi

Trước đây `401` từ `/auth/login` chỉ có nghĩa duy nhất: sai số điện thoại/mật khẩu. Giờ `401` có thể đến từ **2 nguyên nhân khác nhau**, và cách giáo viên cần làm ở mỗi trường hợp hoàn toàn khác nhau:

| Nguyên nhân | Giáo viên cần làm gì |
|---|---|
| Sai mật khẩu | Nhập lại đúng mật khẩu |
| **Zalo không khớp** (mới) | Không phải lỗi gõ sai — mật khẩu đúng nhưng tài khoản Zalo hiện tại khác với tài khoản đã liên kết trước đó. Nhập lại mật khẩu **không giải quyết được gì** — phải liên hệ Nhân sự để gỡ liên kết cũ. |

Nếu Mini App hiện đang show chung 1 message "Sai số điện thoại hoặc mật khẩu" cho mọi `401`, giáo viên gặp trường hợp Zalo lệch sẽ thử nhập lại mật khẩu nhiều lần trong vô vọng.

## 1. Cách phân biệt: dùng `code`, không so `message`

Cả lỗi cũ lẫn 2 lỗi mới đều trả `code` ổn định trong body — dùng field này để rẽ nhánh, **đừng so khớp chuỗi `message`** (chỉ để hiển thị, có thể đổi câu chữ sau này mà không báo trước).

### Đăng nhập bình thường thất bại (không đổi)

```json
{ "statusCode": 401, "message": "Sai số điện thoại hoặc mật khẩu" }
```

Không có `code` — giữ nguyên xử lý cũ cho trường hợp này.

### Thiếu zaloId (đã có từ trước, không phải lỗi mới — chỉ giờ có thêm `code`)

```json
{ "statusCode": 400, "code": "ZALO_ID_REQUIRED", "message": "Thiếu zaloId. Vui lòng quan tâm OA của trường rồi mở lại ứng dụng để đăng nhập." }
```

### Zalo không khớp tài khoản đã liên kết (MỚI)

```json
{ "statusCode": 401, "code": "ZALO_ID_MISMATCH", "message": "Tài khoản Zalo không khớp với tài khoản đã liên kết trước đó. Vui lòng liên hệ Nhân sự để được hỗ trợ." }
```

Đã kiểm chứng thật qua HTTP trên cả 2 trường hợp — response y hệt mẫu trên.

## 2. Việc cần làm ở Mini App

- Ở màn đăng nhập, đọc `error.response.data.code` (hoặc tương đương tuỳ cách gọi API hiện có) sau khi nhận lỗi từ `/auth/login`.
- `code === "ZALO_ID_MISMATCH"` → hiện đúng `message` backend trả về (đã đủ rõ, có hướng dẫn liên hệ Nhân sự) — **không** hiện lại ô "sai mật khẩu", **không** để giáo viên thử lại nhiều lần vô ích. Có thể tô màu/icon cảnh báo khác với lỗi sai mật khẩu thông thường để giáo viên nhận ra ngay đây là vấn đề khác.
- `code === "ZALO_ID_REQUIRED"` → xử lý y như cũ (đã có sẵn nếu Mini App đã làm theo `FE-ZALO-MINIAPP-FCM-SOCKET-PROMPT.md`/prompt đăng nhập trước đó).
- Không có `code` (hoặc `code` khác 2 giá trị trên) → xử lý như lỗi đăng nhập thông thường (sai SĐT/mật khẩu), giữ nguyên UI hiện có.

## 3. Nghiệm thu

Tài khoản test đã có `zaloId` ràng buộc sẵn: `0900000018` / `123456` (Giáo viên K).

- [ ] Đăng nhập bằng đúng `zaloId` đã từng dùng trước đó → vào bình thường.
- [ ] Đăng nhập cùng SĐT/mật khẩu nhưng gửi `zaloId` khác (giả lập đổi tài khoản Zalo) → Mini App hiện đúng message "Tài khoản Zalo không khớp...", không hiện "sai mật khẩu".
- [ ] Tài khoản giáo viên chưa từng đăng nhập Mini App lần nào (`zaloId` chưa ràng buộc) → đăng nhập lần đầu vẫn vào được bình thường, không bị chặn nhầm.

Sau khi làm xong, báo lại đã sửa ở màn/file nào.
