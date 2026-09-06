# PROMPT: KIDO-APP — PHỤ CẤP XĂNG THEO KHOẢNG CÁCH CHO GIÁO VIÊN CÔNG TY

Bạn là Senior Frontend Developer làm web app quản lý (kido-app, module Giảng dạy). Backend vừa thêm cơ chế trả lương thứ hai cho giáo viên: **giáo viên công ty** (`giaovien_congty`) không nhận tiền theo tiết nữa — thay vào đó nhận **phụ cấp xăng cố định theo khoảng cách**, tính **1 lần mỗi khi đến trường** (không phải theo từng tiết). **Giáo viên cộng tác viên** (`giaovien_ctv`) không đổi gì — vẫn nhận `ratePerPeriod × periods` như cũ.

Toàn bộ đã chạy thật qua HTTP + kiểm tra DB trên backend (dev và prod), không phải suy đoán — số liệu ví dụ trong prompt này là số liệu thật đã kiểm chứng.

## 0. Vì sao

Giáo viên công ty tự lái xe đến trường — chi phí thực tế là xăng xe theo khoảng cách, không phải theo số tiết dạy (dạy 1 tiết hay 3 tiết liền cùng trường thì vẫn chỉ đi 1 lần). Nhân sự khai sẵn bảng bậc thang (VD 0-5km = 20.000đ, 5-15km = 35.000đ, >15km = 60.000đ); hệ thống tự tính khoảng cách từ vị trí giáo viên (đã có sẵn từ tính năng "đổi vị trí giáo viên") đến toạ độ trường, tra bậc, và **chốt số tiền vào đúng buổi dạy tại thời điểm tạo buổi** — giống hệt cách `ratePerPeriod` được chốt, để sau này Nhân sự sửa bậc không làm lệch bảng công tháng cũ.

**Chỉ áp dụng buổi dạy tạo mới từ bây giờ** — buổi cũ giữ nguyên cách tính theo tiết, không tính lại.

## 1. API mới: quản lý bậc phụ cấp xăng

Base path `/fuel-allowance-tiers`. Quyền: đọc — mọi role xem được lịch dạy (`TEACHING_VIEW_ROLES`: nhansu, giaovu, director, director_la, troly_gd, ketoan_truong); ghi (tạo/sửa/xoá) — **chỉ nhansu**, cùng ranh giới với `canSetTeachingRates()` đã dùng cho đơn giá môn học.

### `GET /fuel-allowance-tiers`

```json
[
  { "id": 1, "minDistanceKm": 0, "maxDistanceKm": 5, "amount": 20000, "createdAt": "...", "updatedAt": "..." },
  { "id": 2, "minDistanceKm": 5, "maxDistanceKm": 15, "amount": 35000, "createdAt": "...", "updatedAt": "..." },
  { "id": 3, "minDistanceKm": 15, "maxDistanceKm": null, "amount": 60000, "createdAt": "...", "updatedAt": "..." }
]
```

`maxDistanceKm: null` = bậc xa nhất, không giới hạn trên. Luôn trả về đã sắp theo `minDistanceKm` tăng dần.

### `POST /fuel-allowance-tiers`

```json
{ "minDistanceKm": 15, "maxDistanceKm": null, "amount": 60000 }
```

`minDistanceKm`/`amount` bắt buộc, `maxDistanceKm` bỏ trống = không giới hạn trên.

### `PATCH /fuel-allowance-tiers/:id`

Body giống POST nhưng mọi field optional — chỉ gửi field muốn sửa.

### `DELETE /fuel-allowance-tiers/:id`

Trả `{ "deleted": true }`.

### Lỗi cần xử lý trên form

| Status | Khi nào | Message mẫu |
|---|---|---|
| `400` | `maxDistanceKm` ≤ `minDistanceKm` | "Khoảng cách tối đa phải lớn hơn khoảng cách tối thiểu" |
| `409` | Khoảng cách chồng lên bậc đã có (kể cả chồng với bậc không giới hạn trên) | "Khoảng cách chồng lên bậc đã có (5-15 km)" |
| `404` | Sửa/xoá bậc không tồn tại | — |

Đã kiểm chứng thật: tạo 3 bậc liền kề `[0,5) [5,15) [15,+)` thành công; thử chèn `[3,8)` (chồng cả 2 bậc đầu) → `409`.

## 2. Field mới trên `TeachingSession`

`GET /teaching-sessions/me`, `GET /teaching-sessions/:id` và mọi API danh sách buổi khác giờ trả kèm:

```json
{
  "id": 1084,
  "ratePerPeriod": null,
  "amount": null,
  "distanceToSchoolKm": 0.01,
  "gasAllowance": 20000
}
```

| Field | Ý nghĩa |
|---|---|
| `distanceToSchoolKm` | Khoảng cách (km) từ vị trí giáo viên tới trường, chốt lúc tạo buổi. `null` = cộng tác viên, chưa có vị trí, hoặc trường chưa có toạ độ. |
| `gasAllowance` | Số tiền phụ cấp đã tra bậc, chốt lúc tạo buổi. `null` = không áp dụng (cộng tác viên) hoặc giáo viên công ty nhưng thiếu vị trí/chưa khớp bậc nào. |

**Quan trọng: với giáo viên công ty, `ratePerPeriod` và `amount` giờ luôn là `null`** — đây không phải lỗi hiển thị "chưa khai giá", mà là **cố ý, vì họ không nhận theo tiết nữa**. Đã kiểm chứng thật:

```
Giáo viên công ty (đã có vị trí, cách trường 0.01km):
  ratePerPeriod: null, amount: null, distanceToSchoolKm: 0.01, gasAllowance: 20000

Giáo viên cộng tác viên (cùng trường, cùng môn):
  ratePerPeriod: 100000, amount: 100000, distanceToSchoolKm: null, gasAllowance: null
```

**Đừng dùng `ratePerPeriod == null` để suy ra "chưa khai giá, cần cảnh báo"** như cách hiển thị hiện tại (`RATE_MISSING_LABEL`/màu cam trong `Teaching/lib.ts`) — giờ phải phân biệt 2 trường hợp:
- `ratePerPeriod: null` **và** `gasAllowance` có giá trị → bình thường, hiện phụ cấp xăng thay cho đơn giá tiết.
- `ratePerPeriod: null` **và** `gasAllowance: null` → mới thực sự là "thiếu cấu hình", cần cảnh báo (giáo viên công ty chưa có vị trí, hoặc trường chưa có toạ độ, hoặc chưa khai đủ bậc phủ khoảng cách đó).

## 3. Field mới trên bảng tổng hợp chấm công

`GET /teaching-sessions/attendance/summary` — mỗi dòng theo giáo viên và `grandTotal` giờ có thêm `fuelAllowanceAmount`, đã cộng sẵn vào `totalPayableAmount`:

```json
{
  "data": [
    {
      "teacherId": 37, "teacherName": "Giáo viên F (test)",
      "payableAmount": 0, "otherCostsAmount": 0,
      "fuelAllowanceAmount": 20000, "totalPayableAmount": 20000,
      "missingRateSessions": 0
    },
    {
      "teacherId": 42, "teacherName": "GV CTV Test 2",
      "payableAmount": 100000, "otherCostsAmount": 0,
      "fuelAllowanceAmount": 0, "totalPayableAmount": 100000,
      "missingRateSessions": 0
    }
  ],
  "grandTotal": { "payableAmount": 100000, "fuelAllowanceAmount": 20000, "totalPayableAmount": 120000, "missingRateSessions": 0 }
}
```

**Đã kiểm chứng dồn đúng theo "mỗi lần đến trường", không theo tiết**: giáo viên công ty dạy 3 tiết liên tiếp cùng trường cùng ngày → `fuelAllowanceAmount` vẫn chỉ là **20.000đ** (1 lần), không phải 60.000đ. Không cần và không nên tự cộng dồn `gasAllowance` của từng buổi ở FE — luôn lấy `fuelAllowanceAmount` đã tính sẵn từ API này cho bảng tổng hợp; `gasAllowance` trên từng buổi chỉ để hiển thị thông tin của riêng buổi đó.

`missingRateSessions` đã tự loại các buổi giáo viên công ty có `gasAllowance` — không còn báo nhầm "thiếu giá" cho giáo viên công ty đã cấu hình đúng.

## 4. Việc cần làm ở FE

### 4.1. Trang mới: Quản lý phụ cấp xăng (chỉ Nhân sự)

Thêm màn tương tự `SubjectManagePage.tsx` (bảng + modal thêm/sửa), CRUD `/fuel-allowance-tiers`:
- Bảng liệt kê các bậc, sắp theo `minDistanceKm`.
- Form thêm/sửa: `minDistanceKm`, `maxDistanceKm` (checkbox "không giới hạn" để gửi `null`), `amount`.
- Bắt lỗi `400`/`409` ở mục 1, hiện message backend trả về trực tiếp (đã đủ rõ nghĩa).
- Thêm mục menu trong `TEACHING_MENUS` (`Teaching/lib.ts`) — đặt cạnh "Môn học", cùng gắn `moneyFeature: true` (cùng cơ chế ẩn/hiện với `TEACHING_MONEY_FEATURES_ENABLED` và giờ đã có ngoại lệ cho Nhân sự — xem `teachingMenusForUser()` đã sửa trước đó trong phiên này).

### 4.2. Cập nhật các chỗ đang hiển thị "tiền công" theo tiết

4 component + 1 tab đang hiển thị `amount`/`ratePerPeriod` (đều đang ẩn sau `TEACHING_MONEY_FEATURES_ENABLED`, giữ nguyên cách ẩn đó — chỉ đổi NỘI DUNG hiển thị bên trong khi đã bật):

- **`AttendanceTab.tsx`** (dòng ~813-838): banner tổng + cột "Tiền công" của bảng buổi — buổi có `gasAllowance` khác `null` thì hiện "Phụ cấp xăng: {gasAllowance}đ ({distanceToSchoolKm}km)" thay vì "{amount}đ · {ratePerPeriod}/tiết".
- **`SessionDetailDrawer.tsx`** (dòng ~458-472): tương tự, chi tiết 1 buổi — thêm dòng khoảng cách + phụ cấp khi có `gasAllowance`.
- **`SessionViews.tsx`** (dòng ~902, 958-966): cột tiền công trong các view danh sách khác — cùng cách xử lý.
- **`TeacherSummary.tsx`** (dòng ~112, 138-139, 207): đang cộng dồn `session.amount` theo từng buổi để ra tổng lương hiển thị ở đây — **đừng tự cộng `gasAllowance` theo kiểu này** (sẽ tính sai, cộng nhiều lần cho 1 lần đến trường như mục 3 đã nói). Nếu màn này cần tổng phụ cấp xăng, phải gọi `attendanceSummary()` lấy `fuelAllowanceAmount` đã tính đúng, không tính tay từ danh sách buổi.
- **`SummaryTab.tsx`** (đọc từ `attendanceSummary()`): đã có sẵn `payableAmount`/`otherCostsAmount`/`totalPayableAmount` theo từng dòng — thêm cột `fuelAllowanceAmount` (mục 3), và đổi nhãn cột "Đơn giá/tiết" hoặc "Tiền theo tiết" thành gộp cả 2 nguồn cho rõ (VD 2 cột riêng "Tiền theo tiết" / "Phụ cấp xăng" thay vì cố gộp chung 1 số).

### 4.3. Không cần đổi

- Màn "đổi vị trí giáo viên" (giáo viên tự gửi vị trí, Nhân sự/Giáo vụ duyệt) — đã có sẵn từ trước, không cần sửa gì để tính năng này hoạt động.
- `TeacherFormModal.tsx`, các form tạo/sửa lịch dạy — không có ô nhập tay `gasAllowance`/`distanceToSchoolKm`, 2 field này backend tự tính, FE chỉ hiển thị.
- Giáo viên cộng tác viên — toàn bộ luồng cũ giữ nguyên 100%, không cần kiểm tra gì thêm.

## 5. Nghiệm thu

Tài khoản Nhân sự: `0961683096` / mật khẩu thật (hoặc tài khoản nhansu test bất kỳ). Giáo viên công ty test: teacherId=37 "Giáo viên F (test)", đã có vị trí gần Trường TEST (`schoolId=529`, cách ~0.01km).

- [ ] Vào màn "Phụ cấp xăng" mới, tạo được 3 bậc `[0,5) [5,15) [15,+)` — không lỗi.
- [ ] Thử tạo bậc chồng khoảng cách → hiện đúng message `409` từ backend, không phải lỗi kỹ thuật chung chung.
- [ ] Mở buổi dạy của giáo viên F → thấy "Phụ cấp xăng: 20.000đ (0.01km)", **không** thấy "Chưa khai giá" hay đơn giá/tiết nào.
- [ ] Mở buổi dạy của một giáo viên cộng tác viên → vẫn thấy đơn giá/tiết như trước, không đổi gì.
- [ ] Bảng tổng hợp chấm công tháng có cả 2 giáo viên → 2 cột "Tiền theo tiết" và "Phụ cấp xăng" tách riêng, cộng đúng vào tổng.
- [ ] Giáo viên công ty dạy 3 tiết liên tiếp cùng trường cùng ngày → bảng tổng hợp chỉ hiện phụ cấp xăng **1 lần**, không nhân 3.

Sau khi làm xong, chạy typecheck + build, báo lại danh sách file đã sửa.
