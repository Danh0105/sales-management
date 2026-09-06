# Duyệt tài khoản giáo viên: Giáo vụ đề nghị — Nhân sự xác nhận

Giáo vụ khai hồ sơ giáo viên, Nhân sự nhận thông báo và bấm xác nhận thì tài
khoản mới thực sự được tạo. Nhân sự tự tạo thì vẫn có tài khoản ngay như trước —
bắt chính người duyệt tự duyệt đề nghị của mình là thêm một bước thừa.

Base URL: `<API_HOST>` (không có prefix `/api`). Mọi request cần JWT Bearer.

---

## 1. Trước khi duyệt thì chưa có gì cả

Hồ sơ chờ duyệt nằm ở bảng riêng `teacher_account_requests`. Cố ý **không** tạo
sẵn giáo viên rồi khoá lại bằng `isActive = false`: hồ sơ nháp nằm trong bảng
`teachers` sẽ chiếm mất số điện thoại/email, lọt vào danh sách xếp lịch và vào
cả thống kê — trong khi Nhân sự còn chưa đồng ý.

Cho tới lúc Nhân sự bấm duyệt: không có bản ghi `teachers`, không có bản ghi
`employee`, giáo viên chưa đăng nhập được.

Mật khẩu Giáo vụ nhập được **băm ngay lúc gửi đề nghị** và chỉ lưu bản băm. Hồ
sơ có thể nằm chờ nhiều ngày, không để mật khẩu thô nằm trong DB suốt thời gian đó.

---

## 2. `POST /teachers` — payload không đổi, response đổi theo role

Payload y như cũ (`CreateTeacherDto`). Khác nhau ở kết quả trả về:

| Người gọi | Kết quả |
|---|---|
| `nhansu` | Tạo luôn — trả về object giáo viên như trước |
| `giaovu` | Trả về hồ sơ chờ duyệt, chưa tạo tài khoản |

Response khi Giáo vụ gọi:

```json
{
  "status": "pending",
  "requiresApproval": true,
  "requestId": 12,
  "message": "Đã gửi Nhân sự duyệt. Tài khoản chỉ được tạo sau khi Nhân sự xác nhận."
}
```

FE phân biệt hai nhánh bằng `requiresApproval === true` (hoặc `status === "pending"`),
**không** đoán theo role trong token — quy tắc ai phải qua duyệt nằm ở backend.

Lỗi có thể gặp ngay lúc gửi (soát trùng làm ở bước này để Giáo vụ sửa liền, thay
vì để Nhân sự bấm duyệt rồi mới báo lỗi):

- `409` số điện thoại/email đã dùng cho giáo viên khác
- `409` đã có đề nghị cho số điện thoại/email này đang chờ duyệt
- `400` xã/phường hoặc môn học không tồn tại

---

## 2b. `PATCH /teachers/:id` kèm `password` — cấp tài khoản cho hồ sơ có sẵn

Giáo viên nhập từ thời chưa có tài khoản (`employeeId = null`) được cấp tài khoản
bằng cách gửi `password` kèm khi sửa hồ sơ. Cùng quy tắc như mục 2: Nhân sự gọi
là có ngay, Giáo vụ gọi thì ra hồ sơ chờ duyệt (`teacherId` của hồ sơ chờ trỏ về
đúng giáo viên đó, duyệt xong chỉ gắn tài khoản chứ không tạo hồ sơ mới).

Hồ sơ (tên, xã/phường, môn…) được **lưu ngay** ở lần gọi đó; chỉ phần cấp tài
khoản mới phải chờ. Response khi Giáo vụ gọi giống hệt mục 2.

`409` nếu giáo viên đã có tài khoản, hoặc số điện thoại/email đã có người dùng.

---

## 2c. `POST /employees` không còn tạo được tài khoản giáo viên

Trước đây FE tạo tài khoản giáo viên bằng `POST /employees` rồi mới gọi
`POST /teachers` kèm `employeeId`. Đường đó vòng qua toàn bộ bước duyệt, nên nay:

- Toàn bộ `/employees` nằm sau JWT; tạo/sửa/xoá chỉ dành cho `nhansu`,
  `director`, `director_la`.
- `POST /employees` **từ chối** `roles` chứa `giaovien_congty` / `giaovien_ctv`
  kèm thông báo chỉ sang màn Giáo viên.
- `PATCH /employees/:id` **vẫn** gán được role giáo viên cho tài khoản đã tồn
  tại — đó là cách một nhân viên có sẵn kiêm thêm việc dạy, và không sinh ra
  quyền đăng nhập mới.

FE tạo giáo viên nay chỉ gọi **một** request: `POST /teachers` kèm `password`.

---

## 3. `GET /teachers/account-requests` — danh sách chờ duyệt

Query: `status` (`pending` mặc định | `approved` | `rejected`), `requestedBy`.

Quyền: `nhansu` thấy tất cả; `giaovu` **chỉ thấy đề nghị của chính mình** — có tự
truyền `requestedBy` của người khác lên cũng bị ép về id của mình.

```json
[
  {
    "id": 12,
    "name": "Cô Lan",
    "phone": "0912345678",
    "email": "lan@kido.vn",
    "payload": { "name": "Cô Lan", "phone": "0912345678", "wardIds": [3] },
    "createsLogin": true,
    "teacherId": null,
    "status": "pending",
    "requestedBy": 5,
    "requesterName": "Chị Giáo Vụ",
    "reviewedBy": null,
    "reviewerName": null,
    "reviewNote": null,
    "reviewedAt": null,
    "createdTeacherId": null,
    "createdAt": "2026-09-05T02:10:00.000Z"
  }
]
```

- `payload` là toàn bộ hồ sơ Giáo vụ đã khai — dựng lại form xem trước từ đây.
  Không bao giờ chứa mật khẩu.
- `createsLogin`: `true` = duyệt xong sẽ tạo kèm tài khoản đăng nhập mới;
  `false` = chỉ gắn vào một `employeeId` có sẵn.
- `teacherId`: có giá trị = cấp tài khoản cho hồ sơ giáo viên đã tồn tại (mục 2b),
  `null` = duyệt xong tạo hồ sơ giáo viên mới.

`GET /teachers/account-requests/:id` trả về đúng một hồ sơ, cùng shape.

---

## 4. Duyệt / từ chối — chỉ `nhansu`

```
PATCH /teachers/account-requests/:id/approve   body: { "note"?: string }
PATCH /teachers/account-requests/:id/reject    body: { "note"?: string }
```

Response:

```json
{ "id": 12, "status": "approved", "teacherId": 77, "teacher": { "id": 77, "...": "..." } }
```

Từ chối thì `teacherId` và `teacher` là `null`. `note` khi từ chối được hiển thị
lại cho Giáo vụ trong thông báo, nên FE nên bắt buộc nhập lý do ở nhánh từ chối.

Lỗi:

- `409 Đề nghị này đã được xử lý` — người khác vừa duyệt trước
- `409` số điện thoại/email đã bị chiếm trong lúc chờ

Việc tạo giáo viên và việc đóng hồ sơ nằm **chung một transaction**: gặp `409` ở
trên thì không có tài khoản nào được tạo và hồ sơ **vẫn ở trạng thái chờ** để
Nhân sự xử lý lại, chứ không bị đánh dấu "đã duyệt" mà chẳng có tài khoản nào.

---

## 5. Thông báo

Hai loại mới, đi đủ 3 kênh sẵn có (in-app + socket, FCM push, Zalo OA):

| Type | Gửi cho | Khi nào |
|---|---|---|
| `TEACHER_ACCOUNT_REQUEST` | mọi tài khoản `nhansu` | Giáo vụ vừa gửi đề nghị |
| `TEACHER_ACCOUNT_RESULT` | đúng Giáo vụ đã gửi | Nhân sự duyệt hoặc từ chối |

Sự kiện socket: `teacher-account-request:new`, `teacher-account-result:new`.

`meta` của thông báo:

```json
{
  "kind": "teacher_account_request",
  "module": "teaching",
  "route": "/teaching/teachers/account-requests",
  "url": "/teaching/teachers/account-requests",
  "requestId": 12,
  "requestedBy": 5
}
```

Thông báo lỗi kênh gửi không làm hỏng việc lưu hồ sơ — đề nghị đã lưu thì không
bị rollback chỉ vì Zalo OA hết token.

---

## 6. Việc cần làm ở FE

1. **Màn tạo giáo viên**: sau khi `POST /teachers` thành công, nếu
   `requiresApproval === true` thì báo "Đã gửi Nhân sự duyệt", **không** điều
   hướng sang trang chi tiết giáo viên (chưa có giáo viên nào để xem).
2. **Màn "Chờ Nhân sự duyệt"** (mới): danh sách từ
   `GET /teachers/account-requests`. Nhân sự có nút Duyệt/Từ chối; Giáo vụ chỉ
   xem trạng thái hồ sơ mình đã gửi.
3. **Chuông thông báo**: xử lý 2 type mới, bấm vào thì mở màn ở mục 2 theo
   `meta.route`.
4. Giáo vụ vẫn không được khai `defaultRatePerPeriod` như trước — quy tắc cũ
   không đổi, nên hồ sơ chờ duyệt không bao giờ chứa field tiền.

## 7. Nghiệm thu

- [ ] Giáo vụ tạo giáo viên → không xuất hiện trong `GET /teachers`, không đăng nhập được.
- [ ] Nhân sự nhận thông báo, mở danh sách thấy đúng hồ sơ.
- [ ] Nhân sự duyệt → giáo viên xuất hiện trong danh sách và đăng nhập được bằng
      đúng mật khẩu Giáo vụ đã đặt.
- [ ] Nhân sự từ chối kèm lý do → không có tài khoản nào; Giáo vụ nhận được thông báo kèm lý do.
- [ ] Hai người cùng bấm duyệt một hồ sơ → người sau nhận `409`, không tạo trùng.
- [ ] Nhân sự tự tạo giáo viên → vẫn có tài khoản ngay, không qua bước duyệt.
- [ ] Giáo vụ sửa một giáo viên chưa có tài khoản và đặt mật khẩu → hồ sơ lưu
      ngay, tài khoản vào hàng chờ; duyệt xong giáo viên đó đăng nhập được.
- [ ] Gọi `POST /employees` với `roles: ["giaovien_ctv"]` → `403`, không tạo được
      tài khoản giáo viên vòng qua bước duyệt.
- [ ] Gọi bất kỳ endpoint `/employees` nào khi chưa đăng nhập → `401`.
