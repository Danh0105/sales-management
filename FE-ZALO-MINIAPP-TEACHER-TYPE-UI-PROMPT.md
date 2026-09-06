# PROMPT: ZALO MINI APP — TÁCH GIAO DIỆN GIÁO VIÊN CÔNG TY / CỘNG TÁC VIÊN

Bạn là Senior Frontend Developer làm Zalo Mini App cho giáo viên. Backend vừa tách role `giaovien` cũ thành 2 role: **`giaovien_congty`** (giáo viên công ty) và **`giaovien_ctv`** (giáo viên cộng tác viên). Hai loại này giờ có **2 khác biệt về giao diện** cần tách riêng — ngoài ra mọi thứ khác (xác nhận lịch, check-in/check-out, báo giảng, xin nghỉ...) giữ nguyên y hệt, dùng chung 100% màn hình.

> Đây là bản bổ sung, không thay thế `FE-ZALO-MINIAPP-TEACHER-LOCATION-PROMPT.md` và `FE-ZALO-MINIAPP-CHECKOUT-ANY-PERIOD-PROMPT.md` đã gửi trước — 2 file đó vẫn đúng nguyên vẹn về API, chỉ cần đọc thêm mục 2 dưới đây để biết **màn nào chỉ hiện cho giáo viên công ty**.

## 0. Vì sao

Từ giờ 2 loại giáo viên nhận lương khác cơ chế:

| | Giáo viên công ty (`giaovien_congty`) | Giáo viên cộng tác viên (`giaovien_ctv`) |
|---|---|---|
| Cách nhận lương | **Phụ cấp xăng cố định theo khoảng cách**, tính 1 lần mỗi khi đến trường | **Tiền theo tiết** (`ratePerPeriod × periods`) — y hệt trước giờ |
| Có cần cung cấp vị trí không | **Có** — bắt buộc để hệ thống tính khoảng cách tới trường | **Không** — vị trí của họ không được dùng vào đâu cả |

Hai khác biệt này kéo theo đúng 2 việc cần sửa trên Mini App:

1. **Ẩn hẳn tính năng "cập nhật vị trí"** khỏi giáo viên cộng tác viên — họ không cần và không nên bị hỏi xin vị trí.
2. **Đổi cách hiển thị tiền công** của một buổi dạy: giáo viên công ty xem "phụ cấp xăng", giáo viên cộng tác viên vẫn xem "đơn giá/tiết" như cũ.

Ngoài 2 chỗ này, **không đổi gì khác** — cùng màn "Lịch của tôi", cùng luồng xác nhận lịch, check-in/check-out, báo giảng cho cả 2 loại.

## 1. Cách nhận biết loại giáo viên

`roles` trong response đăng nhập (`POST /auth/login`) và trong JWT payload giờ trả `"giaovien_congty"` hoặc `"giaovien_ctv"` thay vì `"giaovien"` cũ. Đã kiểm chứng thật:

```json
// Giáo viên công ty
{ "user": { "id": 175, "name": "Giáo viên F (test)", "roles": ["giaovien_congty"] } }

// Giáo viên cộng tác viên
{ "user": { "id": 180, "name": "GV CTV Test 2", "roles": ["giaovien_ctv"] } }
```

**Nếu Mini App hiện đang check role bằng chuỗi cứng `"giaovien"` ở bất kỳ đâu** (route guard, ẩn/hiện menu, điều kiện vào màn giáo viên...) — chuỗi đó **không còn tồn tại nữa**, phải đổi thành kiểm tra "có 1 trong 2 role mới" cho MỌI chỗ đang coi ai đó "là giáo viên" nói chung (vào được màn giáo viên, nhận thông báo giáo viên...). Chỉ tách riêng — dùng đúng 1 trong 2 role cụ thể — ở đúng 2 chỗ nêu ở mục 2 và 3.

Gợi ý implement 1 hàm dùng chung:

```ts
const isCompanyTeacher = (roles: string[]) => roles.includes("giaovien_congty");
const isTeacher = (roles: string[]) =>
  roles.includes("giaovien_congty") || roles.includes("giaovien_ctv");
```

## 2. Ẩn tính năng "cập nhật vị trí" cho giáo viên cộng tác viên

Toàn bộ luồng ở `FE-ZALO-MINIAPP-TEACHER-LOCATION-PROMPT.md` (hiển thị vị trí hiện tại, nút "Ghi nhận vị trí"/"Cập nhật vị trí", xử lý `TEACHER_LOCATION_CHANGE_RESULT`) **chỉ hiện khi `isCompanyTeacher(roles)` là `true`**.

- Giáo viên cộng tác viên: **không hiện** mục "Vị trí dạy" trong hồ sơ/menu, **không** tự động xin quyền định vị (Geolocation) ở bất kỳ đâu trong app cho họ, **không** đăng ký lắng nghe `teacher-location-change-result:new`.
- Backend **không chặn** cộng tác viên gọi `POST /teachers/me/location` (không có lỗi 403 nào cho việc này) — nhưng làm vậy vô nghĩa vì vị trí của họ không được dùng để tính gì cả. Đây là quyết định ẩn ở UI, không phải giới hạn quyền — không cần bắt lỗi đặc biệt gì, chỉ đơn giản là đừng hiện nút.
- Nếu Mini App có màn "Hồ sơ giáo viên" chung cho cả 2 loại, chỉ ẩn/hiện đúng khối vị trí theo `isCompanyTeacher`, các thông tin khác của hồ sơ (tên, SĐT, email, avatar...) vẫn dùng chung 1 màn.

## 3. Hiển thị tiền công theo đúng loại giáo viên

`GET /teaching-sessions/me`, `GET /teaching-sessions/:id` giờ trả thêm 2 field cho mỗi buổi:

```json
{
  "ratePerPeriod": null,
  "amount": null,
  "distanceToSchoolKm": 0.01,
  "gasAllowance": 20000
}
```

Đã kiểm chứng thật — cùng 1 buổi dạy, 2 loại giáo viên khác nhau ra 2 kết quả khác hẳn:

```
Giáo viên công ty (đã có vị trí, cách trường 0.01km):
  ratePerPeriod: null, amount: null, distanceToSchoolKm: 0.01, gasAllowance: 20000

Giáo viên cộng tác viên (cùng trường, cùng môn):
  ratePerPeriod: 100000, amount: 100000, distanceToSchoolKm: null, gasAllowance: null
```

**Với giáo viên công ty, `ratePerPeriod`/`amount` luôn là `null` — đây là cố ý**, không phải "chưa khai giá". Nếu Mini App đang hiện dòng "Chưa khai giá"/màu cảnh báo khi `amount == null`, giờ phải phân biệt:

- `isCompanyTeacher` = true → hiện "Phụ cấp xăng: {gasAllowance}đ" (kèm khoảng cách nếu muốn, VD "cách trường {distanceToSchoolKm}km"). Nếu `gasAllowance` vẫn là `null` với giáo viên công ty → mới thực sự là thiếu cấu hình (chưa có vị trí hoặc Nhân sự chưa khai đủ bậc) → lúc này mới hiện cảnh báo, và nội dung cảnh báo nên gợi ý "Cập nhật vị trí của bạn" (dẫn thẳng tới màn ở mục 2) thay vì thông báo chung chung.
- `isCompanyTeacher` = false (cộng tác viên) → giữ nguyên hiển thị `amount`/`ratePerPeriod` như hiện tại, không đổi gì.

**Phụ cấp xăng tính theo mỗi lần đến trường, không theo tiết** — nếu Mini App có màn tổng hợp lương của chính giáo viên (VD "Lương tháng này"), **không được tự cộng `gasAllowance` của từng buổi** (sẽ cộng nhiều lần cho 1 lần đến trường khi giáo viên dạy nhiều tiết liền cùng trường một ngày). Nếu cần tổng đã cộng đúng, gọi `GET /teaching-sessions/attendance/summary?teacherId=<id>` — response có field `fuelAllowanceAmount` đã gộp đúng theo từng lần đến trường (đã kiểm chứng: 3 tiết liên tiếp cùng trường cùng ngày chỉ tính 1 lần phụ cấp, không nhân 3). Endpoint này hiện chỉ role quản lý gọi được (`nhansu`/`giaovu`/...) — nếu Mini App muốn cho chính giáo viên xem tổng lương của mình qua endpoint này, cần xin backend mở thêm quyền tự xem cho `giaovien_congty`/`giaovien_ctv` (chưa mở sẵn, phải báo lại nếu cần).

## 4. Không cần đổi

- Luồng xác nhận lịch (`TEACHING_SCHEDULE_CONFIRM_REQUEST/RESULT/ALERT`), check-in/check-out theo block, báo giảng, xin nghỉ, xin rút khỏi buổi (`decline`) — **giống hệt nhau cho cả 2 loại**, không có nhánh riêng nào.
- Route/quyền vào các màn giáo viên nói chung — vẫn dùng chung, chỉ cần đổi đúng danh sách role được liệt kê (mục 1), không tách route riêng cho từng loại.
- Đăng nhập, xác thực OA/Zalo — không liên quan tới role, không đổi.

## 5. Nghiệm thu

Tài khoản test: giáo viên công ty `0900000014` / `123456` (Giáo viên F, đã có vị trí gần "Trường TEST"); giáo viên cộng tác viên `0900000097` / `123456` (GV CTV Test 2, chưa có vị trí).

- [ ] Đăng nhập bằng tài khoản công ty → `roles` trả `["giaovien_congty"]`; thấy mục "Vị trí dạy"; mở 1 buổi dạy thấy "Phụ cấp xăng: ...đ", không thấy đơn giá/tiết.
- [ ] Đăng nhập bằng tài khoản cộng tác viên → `roles` trả `["giaovien_ctv"]`; **không** thấy mục "Vị trí dạy" ở đâu trong app; mở 1 buổi dạy vẫn thấy đơn giá/tiết như trước, không có nhắc gì về vị trí/phụ cấp xăng.
- [ ] Rà lại toàn bộ chỗ nào trong code đang so sánh role bằng chuỗi `"giaovien"` — đổi đúng theo mục 1, kẻo tài khoản giáo viên (cả 2 loại) bị mất quyền vào màn của chính mình sau bản cập nhật role này.

Sau khi làm xong, báo lại danh sách màn/file đã sửa.
