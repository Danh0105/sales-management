# PROMPT: ZALO MINI APP — MÀN ĐỔI MẬT KHẨU CHO GIÁO VIÊN

Bạn là Senior Frontend Developer phụ trách Zalo Mini App dành cho giáo viên. Hãy bổ sung chức năng **giáo viên tự đổi mật khẩu**, tái sử dụng layout, API client, auth store, toast và design system hiện có.

Đây là tính năng **cộng thêm**, không đụng vào luồng đăng nhập. API đã có sẵn và đã chạy thật, không cần backend làm gì thêm.

---

## 0. Vì sao

Tài khoản giáo viên do Nhân sự tạo, và khi giáo viên quên mật khẩu thì Nhân sự bấm "Đặt lại" — mật khẩu về mặc định **`123456`**. Hiện Mini App không có chỗ nào để đổi, nên rất nhiều tài khoản đang dùng vĩnh viễn mật khẩu mặc định đó, ai biết số điện thoại là đăng nhập được và xem/chấm công thay người khác.

---

## 1. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**.
- **Auth**: JWT Bearer. Mọi role đăng nhập được đều gọi được endpoint này cho **chính mình**.
- Mật khẩu đăng nhập gắn với **tài khoản nhân viên**, không phải hồ sơ giáo viên. Id cần dùng là **`user.id` trả về lúc đăng nhập** (`POST /auth/login` → `{ access_token, user: { id, name, roles, ... } }`), cũng chính là `sub` trong JWT. **Không** dùng `teacherId` — sai id sẽ nhận `403`.

---

## 2. API

### `PATCH /employees/{employeeId}/change-password`

**Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`

```json
{
  "oldPassword": "MatKhauHienTai",
  "newPassword": "MatKhauMoi123"
}
```

**200 OK**

```json
{ "message": "Password changed successfully" }
```

Chuỗi này là kỹ thuật, **đừng hiện thẳng cho giáo viên** — tự hiển thị thông báo tiếng Việt của Mini App.

**Các mã lỗi (đã kiểm chứng thật, xem mục 6):**

| Status | Body | Hiển thị cho giáo viên |
|---|---|---|
| `400` | `{"message": ["Mật khẩu mới phải từ 6 ký tự trở lên"], ...}` — **mảng** | Lấy `message[0]`, hiện nguyên văn dưới ô nhập |
| `400` | `{"message": "Mật khẩu hiện tại không đúng"}` — **chuỗi** | Hiện dưới ô "Mật khẩu hiện tại" |
| `400` | `{"message": "Mật khẩu mới phải khác mật khẩu hiện tại"}` | Hiện dưới ô "Mật khẩu mới" |
| `400` | `{"message": "User chưa có mật khẩu"}` | "Tài khoản chưa đặt mật khẩu. Vui lòng liên hệ Nhân sự." |
| `401` | `{"message": "Unauthorized"}` | Hết phiên → theo luồng đăng nhập lại hiện có |
| `403` | `{"message": "Bạn chỉ thao tác được trên tài khoản của chính mình"}` | Lỗi lập trình — gửi sai id. Đừng hiện câu này, log lại |
| `500` | | "Có lỗi xảy ra, vui lòng thử lại" |

⚠️ **`message` khi thì là chuỗi, khi thì là mảng.** Viết một hàm dùng chung:

```ts
const apiMessage = (body: any, fallback: string): string =>
  Array.isArray(body?.message) ? body.message[0] : (body?.message ?? fallback);
```

---

## 3. ⚠️ Đổi mật khẩu KHÔNG làm token cũ hết hạn

Đã kiểm chứng: sau khi đổi thành công, **token đang cầm vẫn gọi API bình thường** cho tới khi hết hạn tự nhiên. Backend không có cơ chế thu hồi token.

Nghĩa là:

- **Không** cần gọi lại `/auth/login` để lấy token mới. Đừng tự đăng xuất rồi bắt giáo viên đăng nhập lại — họ vừa đổi mật khẩu xong, bắt gõ lại ngay là thừa và dễ gõ nhầm.
- Nếu Mini App có lưu mật khẩu để tự đăng nhập lại (autofill, "ghi nhớ đăng nhập", secure storage), **bắt buộc cập nhật giá trị đã lưu** ngay sau khi đổi thành công. Bỏ sót là lần mở app sau sẽ tự đăng nhập bằng mật khẩu cũ và văng ra màn đăng nhập, giáo viên tưởng "đổi mật khẩu xong bị khoá tài khoản".

---

## 4. Màn hình

Đặt ở **Tài khoản / Cá nhân**, một mục "Đổi mật khẩu" mở ra màn riêng (hoặc bottom sheet, theo pattern sẵn có).

Ba ô nhập, đều `type="password"` kèm nút hiện/ẩn:

1. **Mật khẩu hiện tại**
2. **Mật khẩu mới** — chú thích sẵn dưới ô: "Tối thiểu 6 ký tự"
3. **Nhập lại mật khẩu mới**

Nút **Đổi mật khẩu** chỉ bật khi cả ba ô có giá trị.

**Validate tại chỗ, trước khi gọi API:**

| Điều kiện | Thông báo |
|---|---|
| Mật khẩu mới < 6 ký tự | "Mật khẩu mới phải từ 6 ký tự trở lên" |
| Mật khẩu mới > 72 ký tự | "Mật khẩu mới tối đa 72 ký tự" |
| Nhập lại ≠ mật khẩu mới | "Mật khẩu nhập lại không khớp" |
| Mật khẩu mới trùng mật khẩu hiện tại | "Mật khẩu mới phải khác mật khẩu hiện tại" |

Backend chặn cả bốn trường hợp này, nhưng chặn ở FE thì giáo viên không phải chờ vòng mạng.

**Không** dùng ô "nhập lại" gửi lên API — endpoint chỉ nhận `oldPassword` và `newPassword`; gửi thừa field sẽ bị cắt bỏ.

**Trong lúc gọi API**: khoá nút, hiện loading, **chặn bấm hai lần**. Xong thì toast "Đổi mật khẩu thành công", đóng màn, quay lại Tài khoản. Xoá sạch giá trị ba ô khỏi state sau khi đóng — đừng để mật khẩu nằm lại trong bộ nhớ form.

---

## 5. Nhắc đổi mật khẩu mặc định (nên có)

Nhân sự đặt lại mật khẩu là về đúng chuỗi `123456`. Nếu Mini App có màn Trang chủ, hiện một banner nhẹ nhắc đổi mật khẩu khi **lần đăng nhập gần nhất dùng mật khẩu `123456`** (chỉ Mini App biết được điều này — backend không đánh dấu). Banner có nút mở thẳng màn đổi mật khẩu, và cho phép tắt tạm trong phiên.

**Không** ép buộc: giáo viên đang vội check-in mà bị chặn bởi màn đổi mật khẩu thì tệ hơn nhiều so với việc mật khẩu yếu thêm một hôm.

---

## 6. Kiểm chứng phía backend (đã chạy thật trên môi trường dev)

Tạo một tài khoản thật, chạy đủ 10 trường hợp qua HTTP:

```
PATCH /employees/361/change-password  {}
  → 400 {"message":["Vui lòng nhập mật khẩu hiện tại","Mật khẩu mới phải từ 6 ký tự trở lên", ...]}

PATCH .../change-password  {"oldPassword":"OldPass123","newPassword":"12345"}
  → 400 {"message":["Mật khẩu mới phải từ 6 ký tự trở lên"]}

PATCH .../change-password  {"oldPassword":"SaiRoi","newPassword":"NewPass456"}
  → 400 {"message":"Mật khẩu hiện tại không đúng"}

PATCH .../change-password  {"oldPassword":"OldPass123","newPassword":"OldPass123"}
  → 400 {"message":"Mật khẩu mới phải khác mật khẩu hiện tại"}

PATCH .../change-password  {"oldPassword":"OldPass123","newPassword":"NewPass456"}
  → 200 {"message":"Password changed successfully"}

POST /auth/login  {"phone":"0988000111","password":"NewPass456"}   → 200, có access_token
POST /auth/login  {"phone":"0988000111","password":"OldPass123"}   → 401 "Sai số điện thoại hoặc mật khẩu"

PATCH /employees/185/change-password  (id người khác)  → 403 "Bạn chỉ thao tác được trên tài khoản của chính mình"
PATCH /employees/361/change-password  (không token)    → 401 "Unauthorized"

GET /teaching-schedules/me  (token cấp TRƯỚC khi đổi) → vẫn qua được auth
```

Lưu ý: khi body rỗng, backend trả **nhiều** message cùng lúc và có message lặp — cứ lấy `message[0]`, đừng nối cả mảng vào một toast.

---

## 7. Nghiệm thu

- [ ] Đổi mật khẩu thành công → đăng xuất rồi đăng nhập lại bằng mật khẩu mới vào được; mật khẩu cũ báo sai.
- [ ] Gõ sai mật khẩu hiện tại → báo lỗi đúng ô, **không** xoá trắng các ô đang gõ dở.
- [ ] Mật khẩu mới < 6 ký tự hoặc nhập lại không khớp → chặn ngay tại FE, không gọi API.
- [ ] Bấm nút liên tục 5 lần → chỉ có đúng 1 request được gửi.
- [ ] Sau khi đổi, **không** bị đá về màn đăng nhập; các màn lịch dạy, chấm công vẫn dùng bình thường bằng token cũ.
- [ ] Nếu app có ghi nhớ mật khẩu: mở lại app sau khi đổi vẫn tự vào được (giá trị lưu đã được cập nhật).
- [ ] Bàn phím che ô nhập trên máy màn nhỏ → màn vẫn cuộn tới ô đang gõ.
