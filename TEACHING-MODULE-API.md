# MODULE GIẢNG DẠY — NHÂN SỰ & GIÁO VIÊN

Hai role mới (`nhansu`, `giaovien`) và hai màn hình của phòng Nhân sự: **quản lý lịch dạy** và **chấm công**.

> Code nằm trong [src/teaching/](src/teaching/). Trước đó hệ thống chưa có gì về lịch dạy/chấm công — `employee_face` chỉ dùng cho đăng nhập bằng khuôn mặt, không liên quan.

---

## 1. Role mới

Role là chuỗi tự do trong `employee.roles` (`text[]`), đặt tên theo quy ước tiếng Việt không dấu sẵn có (`thuquy`, `ketoan_congno`, `troly_gd`).

| Slug | Vai trò | Quyền trong module |
|---|---|---|
| `nhansu` | Phòng Nhân sự | Toàn quyền: CRUD giáo viên, lịch dạy, buổi dạy, chấm công |
| `giaovien` | Giáo viên | Chỉ xem lịch dạy **của chính mình** (`/teaching-sessions/me`, `/teachers/me`) |

Role sẵn có được thêm quyền **chỉ xem**: `director`, `director_la`, `troly_gd`, `ketoan_truong`.
Mọi role khác (`sales`, `thuquy`, `saleadmin`, …) → **403**.

Phạm vi luôn suy ra từ access token ([teaching-roles.ts](src/teaching/teaching-roles.ts)); `teacherId` FE gửi lên chỉ là bộ lọc, không mở rộng được phạm vi.

```
manage (nhansu) > view (director/director_la/troly_gd/ketoan_truong) > self (giaovien)
```

Endpoint ghi được chặn hai lớp: `RolesGuard` (`@Roles`) rồi `assertCanManageTeaching(req.user)` trong controller — role chỉ-xem lọt qua guard vẫn bị chặn.

---

## 2. Mô hình dữ liệu

```
schools ──< school_classes ──┐
                             ├──< teaching_schedules ──< teaching_sessions
teachers ────────────────────┘        (mẫu lặp tuần)      (buổi cụ thể + chấm công)
   └── employee_id (nullable) → employee
```

### `school_classes` — lớp học của trường

Lịch dạy được xếp cho **lớp**, không phải cho trường. Một trường có nhiều lớp học
cùng một môn ở các khung giờ khác nhau; nếu chỉ gắn theo trường thì không biết
buổi đó dạy lớp nào và không chặn được hai buổi trùng giờ của cùng một lớp.

`schoolYear` là một phần định danh của lớp — "1A" năm 2025-2026 khác "1A" năm
2026-2027 — nên unique key là `(school_id, name, school_year)`, so tên không phân
biệt hoa/thường.

`class_id` trên `teaching_schedules` / `teaching_sessions` **nullable** để giữ
nguyên các lịch/buổi tạo trước khi có module lớp học; API tạo mới thì bắt buộc.

### `teachers`
Giáo viên là **thực thể riêng**, quản lý được cả giáo viên thuê ngoài không có tài khoản. `employee_id` (unique, nullable) chỉ gắn khi giáo viên cơ hữu cần đăng nhập xem lịch — và tài khoản đó **bắt buộc đã có role `giaovien`**, nếu chưa thì trả 400.

`default_rate_per_period` = đơn giá mặc định mỗi tiết của giáo viên (xem mục 6).

Hồ sơ giáo viên còn lưu dữ liệu phục vụ gợi ý lịch về sau:

- `googleMapsUrl`: link vị trí Google Maps của giáo viên.
- `schoolIds`: nhiều trường giáo viên có thể nhận dạy.
- `subjectCatalogIds`: nhiều môn giáo viên có thể dạy, dùng ID từ danh mục môn
  dùng chung (`subject_catalogs`) để không phụ thuộc các ID môn riêng của từng trường.

POST/PATCH `/teachers` nhận hai mảng ID trên. PATCH gửi mảng rỗng để xoá toàn bộ
lựa chọn; bỏ field thì giữ nguyên. Response trả thêm `allowedSchools` và
`teachableSubjects` (gồm ID + tên) để FE không phải gọi từng bản ghi.

### `teaching_schedules` — mẫu lặp theo tuần
`classId` + `dayOfWeek` + `startTime`–`endTime` + `effectiveFrom`–`effectiveTo`. Ví dụ: *Lớp 1A, Thứ Ba, 07:30–09:00, từ 01/08/2026 đến 31/08/2026*.

`schoolId` **suy ra từ lớp** (vẫn lưu lại để lọc/thống kê theo trường không phải join thêm bảng). FE gửi kèm `schoolId` cũng được — không khớp trường của lớp thì 400.

`dayOfWeek` theo cách gọi tiếng Việt: **2 = Thứ Hai … 7 = Thứ Bảy, 8 = Chủ Nhật**.

### `teaching_sessions` — buổi cụ thể + phiếu chấm công
Lịch dạy và chấm công **nằm chung một bảng** nên số liệu luôn khớp: mỗi buổi có `status` là kết quả chấm công, kèm `checked_by_id` / `checked_at` để biết ai chấm lúc nào.

`teacher_id` / `school_id` / `class_id` / `subject_id` được lưu trực tiếp (không chỉ qua `schedule_id`) để tạo được buổi lẻ, buổi dạy bù, và đổi giáo viên dạy thay cho một buổi mà không đụng vào mẫu lặp. Buổi sinh từ mẫu mang theo `class_id` của mẫu; buổi dạy bù kế thừa lớp của buổi gốc khi FE không gửi `classId`.

| `status` | Nhãn | Ý nghĩa |
|---|---|---|
| `SCHEDULED` | Chưa chấm | Đã lên lịch, Nhân sự chưa chốt |
| `PRESENT` | Có dạy | |
| `ABSENT` | Vắng | Vắng không phép |
| `EXCUSED` | Nghỉ có phép | |
| `CANCELLED` | Huỷ buổi | Trường nghỉ, đổi lịch — không tính công |

Dạy bù là **một buổi mới** với `isMakeup = true` + `makeupForSessionId` trỏ về buổi gốc, và bản thân nó cũng được chấm công.

### Shape response

`GET list` / `GET :id` / `POST` / `PATCH` của cả ba tài nguyên đều trả **cùng một shape** — FE không phải xử lý hai dạng dữ liệu. Cụ thể giờ luôn là `"07:30"` (không phải `"07:30:00"`), ngày luôn `"YYYY-MM-DD"`, và kèm sẵn nhãn `dayOfWeekLabel` / `statusLabel` cùng tên trường/môn/giáo viên.

Response **không** load entity `Employee` qua relations mà chỉ select `e.name` → không lộ `password` băm, `fcmToken`, `email` của tài khoản.

---

## 3. Endpoints

Bắt buộc `Authorization: Bearer <access_token>`. Không có prefix `/api`.

### Lớp học — `/school-classes`

| Method | Path | Role | Mô tả |
|---|---|---|---|
| GET | `/school-classes` | xem + `giaovien` | Lọc `schoolId` / `schoolYear` / `gradeLevel` / `isActive` / `search`, phân trang. Thêm `catalogId` để mỗi lớp trả kèm môn tương ứng của trường |
| GET | `/school-classes/:id` | xem + `giaovien` | |
| POST | `/school-classes` | `nhansu` | Tạo lớp cho một trường |
| PATCH | `/school-classes/:id` | `nhansu` | Sửa, bật/tắt `isActive`. **`schoolId` bị bỏ qua** — không đổi trường của lớp |
| DELETE | `/school-classes/:id` | `nhansu` | Chỉ xoá được khi **chưa có lịch/buổi dạy nào**, ngược lại 409 |

`giaovien` đọc được danh sách lớp (để hiển thị tên lớp trong lịch của mình) nhưng không sửa.

### Giáo viên — `/teachers`

| Method | Path | Role | Mô tả |
|---|---|---|---|
| GET | `/teachers/me` | `giaovien` + xem | Hồ sơ giáo viên của tài khoản đang đăng nhập |
| GET | `/teachers` | xem | Danh sách, lọc `search` / `isActive` / `schoolId`, phân trang |
| GET | `/teachers/:id` | xem | |
| POST | `/teachers` | `nhansu` | Tạo hồ sơ |
| PATCH | `/teachers/:id` | `nhansu` | Sửa, bật/tắt `isActive` |
| DELETE | `/teachers/:id` | `nhansu` | Chỉ xoá được khi **chưa có buổi dạy nào**, ngược lại 409 |

### Lịch dạy (mẫu lặp) — `/teaching-schedules`

| Method | Path | Role | Mô tả |
|---|---|---|---|
| GET | `/teaching-schedules` | xem | Lọc `teacherId` / `schoolId` / `classId` / `subjectId` / `dayOfWeek` / `isActive` |
| GET | `/teaching-schedules/:id` | xem | |
| POST | `/teaching-schedules` | `nhansu` | Tạo mẫu lặp |
| PATCH | `/teaching-schedules/:id` | `nhansu` | |
| DELETE | `/teaching-schedules/:id` | `nhansu` | 409 nếu đã có buổi được chấm công |
| POST | `/teaching-schedules/:id/generate-sessions` | `nhansu` | Sinh buổi cụ thể cho khoảng ngày |
| POST | `/teaching-schedules/bulk` | `nhansu` | **Áp một môn cho nhiều lớp của nhiều trường**, kèm tuỳ chọn sinh buổi luôn |

### Buổi dạy & chấm công — `/teaching-sessions`

| Method | Path | Role | Mô tả |
|---|---|---|---|
| GET | `/teaching-sessions/me` | `giaovien` | Lịch của chính mình — `teacherId` lấy từ token |
| GET | `/teaching-sessions` | xem | Lọc `teacherId`/`schoolId`/`classId`/`subjectId`/`scheduleId`/`status`/`unchecked`/`fromDate`/`toDate` |
| GET | `/teaching-sessions/:id` | xem | |
| GET | `/teaching-sessions/attendance/summary` | xem | Tổng hợp công theo giáo viên trong khoảng ngày, lọc thêm `schoolId` / `classId` |
| POST | `/teaching-sessions` | `nhansu` | Tạo buổi lẻ / buổi dạy bù |
| POST | `/teaching-sessions/bulk` | `nhansu` | **Tạo tiết cho nhiều lớp × nhiều ngày**; không có `teacherId` thì tiết ở trạng thái `OPEN` |
| PATCH | `/teaching-sessions/:id` | `nhansu` | Đổi giờ, đổi ngày, đổi giáo viên dạy thay |
| DELETE | `/teaching-sessions/:id` | `nhansu` | 409 nếu đã chấm công |
| PATCH | `/teaching-sessions/:id/attendance` | `nhansu` | **Chấm công 1 buổi** |
| PATCH | `/teaching-sessions/attendance/bulk` | `nhansu` | **Chấm công hàng loạt** (tối đa 200 buổi/lần) |

---

## 4. Luồng dùng thực tế

```bash
# 1. Nhân sự tạo hồ sơ giáo viên
POST /teachers { "name": "Cô Nguyễn Thị Lan", "phone": "0911222333" }

# 2. Tạo lớp học cho trường
POST /school-classes {
  "schoolId": 494, "name": "1A", "schoolYear": "2026-2027",
  "gradeLevel": 1, "studentCount": 35, "homeroomTeacher": "Cô Lan"
}
# -> { "id": 1, "schoolName": "TIỂU HỌC THẮNG NHÌ", "scheduleCount": 0, "sessionCount": 0, ... }

# 3. Khai báo mẫu lịch lặp CHO LỚP: Thứ Ba 07:30–09:00, tháng 8/2026
#    Không gửi schoolId — trường lấy theo lớp.
POST /teaching-schedules {
  "teacherId": 1, "classId": 1, "subjectId": 794,
  "dayOfWeek": 3, "startTime": "07:30", "endTime": "09:00",
  "effectiveFrom": "2026-08-01", "effectiveTo": "2026-08-31"
}

# 3. Sinh buổi dạy cụ thể
POST /teaching-schedules/1/generate-sessions { "fromDate": "2026-08-01", "toDate": "2026-08-31" }
# -> { "created": 4, "skipped": 0, "dates": ["2026-08-04","2026-08-11","2026-08-18","2026-08-25"] }

# 4. Chấm công cuối tuần
PATCH /teaching-sessions/attendance/bulk {
  "items": [
    { "sessionId": 2, "status": "ABSENT" },
    { "sessionId": 3, "status": "EXCUSED", "attendanceNote": "Xin phép ốm" },
    { "sessionId": 4, "status": "CANCELLED", "attendanceNote": "Trường nghỉ lễ" }
  ]
}

# 5. Tạo buổi dạy bù cho buổi vắng — kế thừa lớp của buổi gốc
POST /teaching-sessions {
  "teacherId": 1, "subjectId": 794,
  "date": "2026-08-13", "startTime": "14:00", "endTime": "15:30",
  "makeupForSessionId": 2, "note": "Dạy bù buổi 11/8"
}

# 6. Bảng công cuối tháng
GET /teaching-sessions/attendance/summary?fromDate=2026-08-01&toDate=2026-08-31
```

Response bước 6 (dữ liệu thật):

```json
{
  "fromDate": "2026-08-01",
  "toDate": "2026-08-31",
  "data": [
    {
      "teacherId": 1, "teacherName": "Giáo viên A (test)",
      "totalSessions": 4, "present": 3, "absent": 1,
      "excused": 0, "cancelled": 0, "unchecked": 0, "makeup": 0,
      "totalPeriods": 8, "payablePeriods": 6,
      "payableAmount": 900000, "missingRateSessions": 0
    }
  ],
  "grandTotal": {
    "payablePeriods": 6, "payableAmount": 900000, "missingRateSessions": 0
  }
}
```

Một buổi dạy trả về:

```json
{
  "id": 1,
  "scheduleId": 1,
  "teacherId": 1, "teacherName": "Giáo viên A (test)",
  "schoolId": 494, "schoolName": "TIỂU HỌC THẮNG NHÌ",
  "classId": 1, "className": "1A", "classGradeLevel": 1,
  "subjectId": 794, "subjectName": "Kỹ năng sống", "schoolYear": "2026-2027",
  "date": "2026-08-04",
  "dayOfWeek": 3, "dayOfWeekLabel": "Thứ Ba",
  "startTime": "07:30", "endTime": "09:00",
  "periods": 2, "ratePerPeriod": 150000, "amount": 300000,
  "status": "PRESENT", "statusLabel": "Có dạy",
  "isMakeup": false, "makeupForSessionId": null,
  "attendanceNote": null,
  "checkedById": 140, "checkedByName": "Nhân sự (test)",
  "checkedAt": "2026-08-04T08:32:55.159Z",
  "note": null
}
```

---

## 5. Áp một môn cho nhiều lớp của nhiều trường

Trước đây Nhân sự phải mở từng trường, chọn lại môn của trường đó, rồi xếp lịch từng lớp. Với một môn dạy ở 100+ trường thì đây là phần tốn thao tác nhất của module.

### Vì sao cần `catalogId`

Môn của trường (`subjects`) là **bản ghi riêng cho từng trường** — kèm hợp đồng, số tiết, số học sinh, năm học — nên `subjectId` của trường này không dùng được cho trường khác. Cái dùng chung được là **danh mục môn** (`subject_catalogs`: STEM, Kỹ năng sống, Công dân số…).

Nên Nhân sự chọn môn **một lần trong danh mục**, backend tra ra môn tương ứng của từng trường theo `(trường của lớp, catalogId, năm học của lớp)`:

```
catalogId = 6 ("Kỹ năng sống")
  ├── lớp 1B @ TIỂU HỌC TÂN THÀNH      -> subjectId 748 "Kỹ năng sống"
  ├── lớp 6A @ THCS GIA LỘC            -> subjectId 751 "KỸ NĂNG SỐNG"
  └── lớp 5A @ TH ABC                  -> bỏ qua: trường chưa khai môn này
```

Toàn bộ 385 môn trong `sales_db` đều đã map vào danh mục, và `(trường, danh mục, năm học)` là duy nhất ở 379/381 trường hợp — 2 trường hợp còn lại trả `AMBIGUOUS` để Nhân sự khai `subjectId` cho đúng, backend **không đoán bừa**.

### Xem trước trước khi tạo

`GET /school-classes?catalogId=6&schoolYear=2026-2027` trả mỗi lớp kèm:

| Field | Ý nghĩa |
|---|---|
| `subjectStatus` | `RESOLVED` / `MISSING` / `AMBIGUOUS` |
| `subjectId`, `subjectName` | môn của trường khi `RESOLVED` |
| `subjectReason` | lý do khi không `RESOLVED` |

FE dùng đúng danh sách này để tick chọn lớp, nên Nhân sự thấy trước lớp nào áp được.

### Tạo mẫu lịch hàng loạt

**POST** `/teaching-schedules/bulk` — giá trị ở cấp lô là mặc định, mỗi lớp override được riêng.

```jsonc
{
  "catalogId": 6,
  "teacherId": 1,
  "dayOfWeek": 4, "startTime": "07:30", "endTime": "09:00",
  "effectiveFrom": "2026-10-01", "effectiveTo": "2026-10-31",
  "items": [
    { "classId": 5 },
    { "classId": 6, "startTime": "09:15", "endTime": "10:45" },   // đổi giờ riêng
    { "classId": 7, "teacherId": 2, "dayOfWeek": 5 },             // đổi GV + thứ
    { "classId": 9, "subjectId": 724 }                            // khai thẳng môn
  ],
  "generateSessions": { "fromDate": "2026-10-01", "toDate": "2026-10-31" }  // gộp luôn bước sinh buổi
}
```

Trả **200** kèm kết quả từng lớp:

```json
{
  "created": 2,
  "skipped": 2,
  "sessionsCreated": 9,
  "results": [
    { "classId": 6, "className": "1B", "schoolId": 294, "schoolName": "TIỂU HỌC TÂN THÀNH",
      "status": "CREATED", "subjectId": 748, "subjectName": "Kỹ năng sống" },
    { "classId": 8, "className": "5A", "schoolId": 280, "schoolName": "TH ABC",
      "status": "SKIPPED", "reason": "Trường \"TH ABC\" chưa khai môn \"Kỹ năng sống\" cho năm học 2026-2027" }
  ]
}
```

### Tạo tiết hàng loạt

**POST** `/teaching-sessions/bulk` — nhân **lớp × ngày**. Bỏ `teacherId` thì tiết được tạo ở `assignmentStatus = OPEN` để giáo viên đăng ký.

```jsonc
{
  "catalogId": 6,
  "startTime": "14:00", "endTime": "15:30",
  "dates": ["2026-11-03", "2026-11-10", "2026-11-17"],
  "items": [
    { "classId": 6 },
    { "classId": 7, "date": "2026-11-20" }   // ngày riêng thắng `dates` chung
  ]
}
```

Mỗi dòng trong `results` có thêm `date`.

### Hai loại lỗi được xử lý khác nhau

| Loại | Ví dụ | Hành vi |
|---|---|---|
| **Sai từ phía client** | thiếu `teacherId`, giờ ngược, `classId` lặp, vượt trần | **400 trước khi ghi bất cứ gì** — không bao giờ tạo được nửa lô |
| **Trạng thái dữ liệu** | trường chưa khai môn, lớp trùng giờ, lớp ngừng dùng | lớp đó `SKIPPED` kèm lý do, các lớp còn lại **vẫn tạo** |

Chặn cả lô chỉ vì một trường chưa khai môn thì Nhân sự không dùng được, nên lỗi nghiệp vụ được cô lập theo từng dòng.

Mỗi dòng đi qua đúng service tạo đơn lẻ (`TeachingScheduleService.create` / `TeachingSessionService.create`) nên **mọi quy tắc ở mục 7 giữ nguyên**, không có đường tắt nào bỏ qua kiểm tra trùng giờ.

Giới hạn: 200 lớp/lần, 31 ngày/lần, 500 tiết/lần.

---

## 6. Đơn giá mỗi tiết & tiền công

### Chuỗi đơn giá

```
teachers.default_rate_per_period      đơn giá mặc định của giáo viên
        ↓ chốt khi tạo mẫu lịch
teaching_schedules.rate_per_period    đơn giá riêng cho mẫu lịch (trường xa trả cao hơn…)
        ↓ chốt khi sinh buổi
teaching_sessions.rate_per_period     ĐƠN GIÁ CHỐT — nguồn duy nhất để tính tiền
```

Ở mỗi bước, giá trị FE gửi lên thắng giá trị kế thừa. `0` là đơn giá hợp lệ (dạy không công) và **không** rơi về mức kế thừa — chỉ `null`/không gửi mới kế thừa.

### Vì sao chốt vào từng buổi

Đơn giá thay đổi theo thời gian. Nếu lúc tính lương mới tra ngược về `teachers`, thì tăng giá hôm nay sẽ làm **lệch cả bảng công đã chốt của các tháng trước**. Chốt vào từng buổi lúc tạo nên bảng công của tháng cũ đứng yên.

E2E đã kiểm chứng: tăng đơn giá giáo viên từ 150k lên 200k → 4 buổi đã sinh vẫn giữ `ratePerPeriod: 150000`.

Hệ quả: **sửa đơn giá chỉ áp cho buổi tạo về sau.** Muốn sửa buổi đã tạo thì `PATCH /teaching-sessions/:id { "ratePerPeriod": ... }` cho từng buổi.

### Tiết mở (`OPEN`)

Tiết chưa có giáo viên thì chưa chốt được đơn giá (`ratePerPeriod: null`). `PATCH /teaching-sessions/:id/assign` chốt đơn giá của giáo viên được phân công — nhưng **chỉ khi buổi chưa có đơn giá**. Đã chốt rồi thì đổi giáo viên không làm đổi giá: đơn giá đã chốt là cam kết.

### Tiền công

`amount = ratePerPeriod × periods`, tính khi trả response chứ không lưu cột riêng — một nguồn sự thật duy nhất.

`amount: null` nghĩa là **chưa khai đơn giá**, khác hẳn `amount: 0` (dạy không công). FE phải hiển thị hai trạng thái này khác nhau.

### Bảng công

`GET /teaching-sessions/attendance/summary` trả thêm cho mỗi giáo viên:

| Field | Ý nghĩa |
|---|---|
| `totalPeriods` | tổng số tiết trong khoảng, mọi trạng thái |
| `payablePeriods` | số tiết **được trả tiền** |
| `payableAmount` | tiền công = Σ `rate × periods` |
| `missingRateSessions` | số buổi đã dạy nhưng **chưa khai đơn giá** — tiền đang thiếu |

Kèm `grandTotal` cộng dồn cả bảng.

> **Chỉ buổi `PRESENT` được tính tiền.** `ABSENT` / `EXCUSED` / `CANCELLED` đều không trả công. Nếu công ty muốn trả cho `EXCUSED` (nghỉ có phép) thì sửa bộ lọc trong `attendanceSummary` — hiện tại quy ước là không trả.

`missingRateSessions > 0` là tín hiệu bảng công **chưa đầy đủ**, FE nên cảnh báo trước khi Nhân sự chốt lương.

### Khai đơn giá ở đâu

| Nơi | Endpoint | Dùng khi |
|---|---|---|
| Giáo viên | `PATCH /teachers/:id { defaultRatePerPeriod }` | đơn giá chung của giáo viên |
| Mẫu lịch | `POST/PATCH /teaching-schedules { ratePerPeriod }` | một mẫu trả khác mức chung |
| Buổi cụ thể | `PATCH /teaching-sessions/:id { ratePerPeriod }` | sửa/bổ sung cho đúng một buổi |
| Hàng loạt | `POST /teaching-schedules/bulk`, `/teaching-sessions/bulk` | `ratePerPeriod` ở cấp lô, mỗi `items[i]` override được |

Đơn giá nhận số 0 → 100.000.000, tối đa 2 chữ số thập phân.

---

## 7. Quy tắc nghiệp vụ được enforce ở BE

| Quy tắc | Kết quả khi vi phạm |
|---|---|
| `startTime` < `endTime` | 400 |
| `effectiveFrom` ≤ `effectiveTo`, `fromDate` ≤ `toDate` | 400 |
| `dayOfWeek` trong 2–8 | 400 |
| Ngày phải có thật (chặn `2026-02-31`, `2026-13-01`) | 400 |
| Môn học phải thuộc trường đã chọn | 400 |
| Giáo viên `isActive = false` không xếp lịch được | 400 |
| Tài khoản gắn làm giáo viên phải có role `giaovien` | 400 |
| Lớp phải tồn tại và `isActive = true` mới xếp lịch được | 400 |
| `classId` không thuộc `schoolId` FE gửi kèm | 400 |
| Tên lớp không trùng trong cùng trường + năm học (không phân biệt hoa/thường) | 409 |
| **Một giáo viên không có 2 mẫu lịch cùng thứ, giao giờ, giao khoảng hiệu lực** | 409 |
| **Một lớp không có 2 mẫu lịch cùng thứ, giao giờ, giao khoảng hiệu lực** (kể cả khác giáo viên) | 409 |
| **Một giáo viên không dạy 2 buổi giao giờ trong cùng ngày** | 409 |
| **Một lớp không học 2 buổi giao giờ trong cùng ngày** (kể cả khác giáo viên) | 409 |
| Xoá lớp đã có lịch/buổi dạy | 409 (gợi ý `isActive = false`) |
| Đổi `schoolId` của lớp qua PATCH | bị bỏ qua |
| Đơn giá ngoài 0–100.000.000 hoặc quá 2 chữ số thập phân | 400 |
| Đổi đơn giá giáo viên **không** đổi buổi đã tạo | — (đơn giá đã chốt) |
| Phân công giáo viên cho tiết mở chỉ chốt giá khi buổi **chưa có** đơn giá | — |
| Chỉ buổi `PRESENT` được tính tiền công | — |
| Xoá giáo viên đã có buổi dạy | 409 (gợi ý `isActive = false`) |
| Xoá mẫu lịch đã có buổi được chấm công | 409 |
| Xoá buổi đã chấm công | 409 (gợi ý chuyển `CANCELLED`) |
| Buổi `CANCELLED` **không** chiếm chỗ khi kiểm tra trùng giờ | — |
| Chạm biên giờ (09:00 kết thúc, 09:00 bắt đầu) **không** tính là trùng | — |
| Sinh buổi chạy lại nhiều lần không nhân đôi | unique `(schedule_id, date)` |
| Sinh buổi chỉ trong phần giao với khoảng hiệu lực của mẫu | — |
| Khoảng sinh buổi tối đa 400 ngày/lần | 400 |
| Bỏ chấm (về `SCHEDULED`) xoá luôn `checkedBy` / `checkedAt` | — |

---

## 8. Migration / Index

[src/migrations/1785500000000-create-teaching-module.ts](src/migrations/1785500000000-create-teaching-module.ts) — **đã áp dụng vào `sales_db`** (idempotent, `IF NOT EXISTS`).

[src/migrations/1786400000000-create-school-classes.ts](src/migrations/1786400000000-create-school-classes.ts) — bảng `school_classes` + cột `class_id` cho `teaching_schedules` / `teaching_sessions`, **đã áp dụng vào `sales_db`** (idempotent).

Index lớp học: `school_classes(school_id)`, `(school_year)`, `(is_active)`, unique `(school_id, name, school_year)`; `teaching_schedules(class_id)`; `teaching_sessions(class_id)`, `(class_id, date)`.

[src/migrations/1786500000000-add-teaching-rate-per-period.ts](src/migrations/1786500000000-add-teaching-rate-per-period.ts) — cột `default_rate_per_period` (teachers) + `rate_per_period` (teaching_schedules, teaching_sessions), kiểu `numeric(15,2)` nullable, **đã áp dụng vào `sales_db`** (idempotent).

Index: `teachers(is_active)`; `teaching_schedules(teacher_id)`, `(school_id)`, `(subject_id)`, `(teacher_id, day_of_week)`; `teaching_sessions(date)`, `(teacher_id, date)`, `(status, date)`, `(school_id)`, `(subject_id)`, và unique một phần `(schedule_id, date) WHERE schedule_id IS NOT NULL`.

Runtime chạy `synchronize: true` nên bảng cũng được TypeORM tạo tự động khi khởi động lại; migration dành cho môi trường tắt synchronize.

---

## 9. Seed & test

```bash
npm run seed:teaching-users   # phòng ban "Nhân sự" + 3 user test + 2 hồ sơ giáo viên
npx jest src/teaching         # 156 test, pass
npx jest                      # 314 test / 7 suite, pass
```

User test (đăng nhập bằng **phone** + mật khẩu `123456`):

| Phone | Role | Ghi chú |
|---|---|---|
| `0900000007` | `nhansu` | Thuộc phòng ban "Nhân sự" |
| `0900000008` | `giaovien` | Gắn hồ sơ giáo viên id=1 |
| `0900000009` | `giaovien` | Gắn hồ sơ giáo viên id=2 |

[src/teaching/teaching.spec.ts](src/teaching/teaching.spec.ts) phủ:

| Nhóm | Nội dung |
|---|---|
| Phân quyền | `nhansu` quản lý; 4 role chỉ xem (chặn cả ở `assertCanManageTeaching`); `giaovien` chỉ dữ liệu của mình; ưu tiên phạm vi rộng nhất; role lạ 403; thiếu token 401 |
| Tiện ích ngày/giờ | Đổi giờ hai chiều, `toDateString` không lệch timezone, `dayOfWeekOf` (2/7/8), liệt kê ngày theo thứ kể cả Chủ Nhật, chạm biên giờ không tính trùng |
| Validate DTO | Ép kiểu số; 400 với `dayOfWeek` 1/9, giờ `7h30`/`25:00`, ngày `2026-02-31`, id = 0, tên quá ngắn, email sai |
| Mẫu lịch | Chuẩn hoá giờ về `HH:mm:ss`; chặn giờ ngược, ngày ngược, GV ngừng hoạt động, môn sai trường; 409 khi trùng; SQL trùng lịch đúng 6 điều kiện; `effectiveTo` rỗng = vô hạn |
| Sinh buổi | Đúng các thứ trong khoảng; chạy lại không nhân đôi (`skipped`); cắt theo khoảng hiệu lực; ngoài hiệu lực trả 0; mẫu ngừng áp dụng bị chặn; khoảng > 400 ngày bị chặn |
| Buổi dạy | Buổi lẻ `scheduleId = null`; buổi bù tự bật `isMakeup`; 409 khi giao giờ cùng ngày; buổi `CANCELLED` không chiếm chỗ |
| Chấm công | 4 trạng thái ghi `checkedBy`/`checkedAt`; bỏ chấm xoá dấu vết; lưu ghi chú; 404 buổi không tồn tại |
| Chấm hàng loạt | Nhiều buổi trong 1 lần save; chặn `sessionId` trùng; 404 nêu rõ id thiếu |
| Lịch của tôi | `teacherId` lấy từ token, bỏ qua tham số FE; 404 khi chưa gắn hồ sơ |
| Lọc/phân trang | Khoảng ngày, `unchecked`, chặn `limit` quá lớn, pagination hợp lệ khi rỗng, map nhãn tiếng Việt |
| Tổng hợp | `GROUP BY` dưới database, ép kiểu số, chặn khoảng ngày ngược |
| Lớp học | Chuẩn hoá tên; 400 khi trường không tồn tại; 409 khi trùng tên trong cùng năm học; cùng tên khác năm học vẫn tạo được; không kiểm tra trùng khi update không đổi tên/năm; 409 khi xoá lớp đã có lịch/buổi; `resolveForScheduling` chặn lớp không tồn tại / ngừng dùng / sai trường |
| Áp môn hàng loạt | Map môn của từng trường từ 1 catalogId; chỉ lấy đúng năm học; `schoolYear` cấp lô ghi đè; `MISSING` khi trường chưa khai môn; `AMBIGUOUS` khi trùng, không đoán bừa; `subjectId` khai thẳng thắng catalogId; 400 khi thiếu cả hai |
| Tạo hàng loạt | Override từng lớp thắng mặc định lô; lớp lỗi bị bỏ qua, lớp còn lại vẫn tạo; không sinh buổi cho lớp bị bỏ qua; 400 **trước khi ghi** khi thiếu field/giờ ngược/lớp lặp; nhân lớp × ngày; ngày riêng thắng `dates` chung; không teacherId -> tiết `OPEN`; chặn vượt trần 500 tiết |
| Đơn giá | `amount = giá × tiết`, thiếu tiết tính 1; chưa khai giá trả `null` chứ không phải 0; giá 0 giữ nguyên không rơi về giá kế thừa; làm tròn 2 chữ số; chuỗi mẫu giáo viên → mẫu lịch → buổi; buổi bù kế thừa giá buổi gốc; tiết mở chưa chốt giá; bảng công cộng tiền + đếm buổi thiếu giá; chỉ `PRESENT` tính tiền; 400 khi giá âm/quá lẻ/vượt trần |
| Xếp lịch theo lớp | `classId` bắt buộc ở mẫu lịch; `schoolId` suy ra từ lớp; 409 khi lớp trùng giờ (cả mẫu lặp lẫn buổi cụ thể); buổi sinh từ mẫu mang `classId`; buổi bù kế thừa lớp gốc; buổi `CANCELLED` không chiếm chỗ của lớp; lịch cũ `classId = null` vẫn sửa được; lọc `classId` ở danh sách buổi và bảng tổng hợp |

### E2E đơn giá đã chạy thực tế (instance test port 3022, DB `sales_db`, dữ liệu test đã xoá sau khi chạy)

| Case | Kết quả |
|---|---|
| `PATCH /teachers/1 { defaultRatePerPeriod: 150000 }` | 200 |
| Xếp lịch **không** khai giá | mẫu lịch tự nhận `ratePerPeriod: 150000` |
| Sinh 4 buổi (2 tiết/buổi) | mỗi buổi `rate=150000, amount=300000` |
| **Tăng giá giáo viên lên 200k** | 4 buổi đã sinh **vẫn giữ 150000** |
| Chấm 3 `PRESENT` + 1 `ABSENT` | `payablePeriods: 6`, `payableAmount: 900000` (buổi vắng không tính) |
| Buổi `PRESENT` của GV chưa khai giá | `payableAmount: 0`, `missingRateSessions: 1` |
| `PATCH` buổi đó `{ ratePerPeriod: 180000 }` | `amount: 360000`, `missingRateSessions` về 0 |
| Bulk `ratePerPeriod: 175000` cấp lô | lớp 1A nhận 175000 |
| `items[i].ratePerPeriod: 250000` | lớp 2A nhận 250000 — override thắng |
| Tạo tiết mở không giáo viên | `ratePerPeriod: null`, `amount: null` |
| Phân công GV1 (giá hiện tại 200k) cho tiết mở đó | chốt `ratePerPeriod: 200000`, `amount: 400000` |

### E2E áp môn hàng loạt đã chạy thực tế (instance test port 3022, DB `sales_db`, dữ liệu test đã xoá sau khi chạy)

| Case | Kết quả |
|---|---|
| `GET /school-classes?catalogId=6&schoolYear=2026-2027` | 5 lớp: 3 `RESOLVED` (2 subjectId khác nhau ở 2 trường), 2 `MISSING` kèm lý do |
| Bulk 4 lớp / 3 trường + `generateSessions` | `created: 2, skipped: 2, sessionsCreated: 9` |
| Lớp @ TIỂU HỌC TÂN THÀNH | `subjectId 748 "Kỹ năng sống"` |
| Lớp @ THCS GIA LỘC | `subjectId 751 "KỸ NĂNG SỐNG"` — đúng môn của trường đó |
| Lớp @ TH ABC (chưa khai môn) | `SKIPPED` kèm tên trường + tên môn + năm học |
| Lớp bị giáo viên trùng lịch | `SKIPPED` kèm nguyên message 409, các lớp khác vẫn tạo |
| Override giờ / GV / thứ theo từng lớp | áp đúng từng dòng |
| Trường 506 có 4 môn "STEM" 2025-2026 | `AMBIGUOUS`, gợi ý khai `subjectId` |
| Cùng lớp đó khai thẳng `subjectId` | `CREATED` với đúng môn được chọn |
| Thiếu `teacherId` cho 1 lớp | 400, số lịch trong DB **không đổi** (7 → 7) |
| `classId` lặp trong lô | 400 |
| Bulk tiết 2 lớp × 3 ngày, không `teacherId` | `created: 6`, tất cả `assignmentStatus: OPEN`, `teacherId: null` |

### E2E lớp học đã chạy thực tế (instance test port 3022, DB `sales_db`, dữ liệu test đã xoá sau khi chạy)

| Case | Kết quả |
|---|---|
| `nhansu` tạo lớp 1A / 1B cho trường 494 | 201, trả kèm `schoolName`, `scheduleCount`, `sessionCount` |
| Tạo lại lớp "1a" cùng năm học | 409 |
| Tạo lớp "1A" năm học 2025-2026 | 201 |
| `giaovien` GET / POST `/school-classes` | 200 / 403 |
| Xếp lịch cho `classId` không gửi `schoolId` | 201, `schoolId` = 494 suy từ lớp |
| Thiếu `classId` | 400 |
| `classId` không thuộc `schoolId` gửi kèm | 400 |
| Lớp 1A đã bận Thứ Sáu 14:00–15:30, xếp GV **khác** 14:30–16:00 | 409 kèm môn + tên GV đang giữ chỗ |
| Cùng khung giờ nhưng lớp 1B | 201 |
| `GET /teaching-schedules?classId=1` | 1 dòng, đúng `classId`/`className` |
| Sinh buổi tháng 9/2026 | `created: 4`, buổi mang `classId: 1`, `className: "1A"` |
| Buổi lẻ cho lớp 1B không gửi `schoolId` | 201, `schoolId` = 494 |
| Lớp 1B bận 09:00–10:30 ngày 10/9, tạo buổi GV khác 10:00–11:00 | 409 |
| Sát giờ 10:30–11:30 cùng lớp | 201 |
| Buổi dạy bù không gửi `classId` | kế thừa `classId: 1` của buổi gốc |
| Xoá lớp đã có 1 lịch + 5 buổi | 409 kèm số lượng |
| Xoá lớp chưa dùng | `{ deleted: true }` |
| Tắt lớp rồi xếp lịch | 400 "đang ngừng sử dụng" |
| `giaovien` xem `/teaching-sessions/me` | 6 buổi, có `className` |
| PATCH lớp kèm `schoolId` khác | `schoolId` giữ nguyên |
| `GET /teaching-sessions/attendance/summary?classId=1` | chỉ đếm buổi của lớp 1 |

### E2E module giảng dạy đã chạy thực tế (instance test port 3021, DB `sales_db`)

| Case | Kết quả |
|---|---|
| Đăng nhập thật bằng phone seed | `nhansu` id=140, `giaovien` id=141 |
| `GET /teachers` | không token 401 · `nhansu` 200 · `director` 200 · `sales` 403 · `giaovien` 403 |
| `director` tạo giáo viên | 403 (chỉ xem) |
| Môn không thuộc trường | 400 |
| Trùng mẫu lịch (Thứ Ba 08:30–10:00 đè 07:30–09:00) | 409 kèm tên trường |
| Mẫu lịch không giao giờ (09:00–10:30) | 201 |
| Sinh buổi tháng 8/2026 | `created: 4` đúng 4 thứ Ba |
| Sinh lại lần 2 | `created: 0, skipped: 4` |
| Sinh ngoài khoảng hiệu lực | `created: 0` |
| Chấm công 1 buổi | `checkedById: 140`, `checkedByName`, `checkedAt` |
| Chấm hàng loạt 3 buổi | `updated: 3`, `unchecked` còn 0 |
| Bỏ chấm | `checkedById: null`, `checkedAt: null` |
| Xoá buổi đã chấm | 409 |
| `giaovien` chấm công | 403 |
| Buổi dạy bù | `isMakeup: true`, `makeupForSessionId: 2`, `scheduleId: null` |
| Trùng giờ cùng ngày (15:00 đè 14:00–15:30) | 409 |
| Sát giờ (15:30–17:00) | 201 |
| `giaovien` xem `/teaching-sessions/me` | 6 buổi, chỉ `teacherId: 1` |
| `giaovien` gửi `teacherId=2` vào `/me` | vẫn chỉ thấy của mình |
| `giaovien` gọi `/teaching-sessions` | 403 |
| Query sai (4 case) | 400 kèm message tiếng Việt |

OpenAPI 3.1: [openapi/teaching.yaml](openapi/teaching.yaml).

---

## PROMPT FE — BỔ SUNG VỊ TRÍ, TRƯỜNG VÀ MÔN CÓ THỂ DẠY CHO GIÁO VIÊN

> Dùng nguyên phần dưới đây làm yêu cầu triển khai cho Frontend.

Bạn là Senior Frontend Developer của dự án. Hãy cập nhật màn hình **Nhân sự →
Giáo viên**, đặc biệt modal **Thêm giáo viên / Sửa giáo viên**, để quản lý thêm
dữ liệu phục vụ tính năng gợi ý lịch dạy sau này.

### 1. Phạm vi cần sửa

Trong form giáo viên, bổ sung ba field:

1. **Vị trí Google Maps** — input URL, field API là `googleMapsUrl`.
2. **Trường có thể dạy** — multi-select, field API là `schoolIds`.
3. **Môn có thể dạy** — multi-select, field API là `subjectCatalogIds`.

Giữ nguyên toàn bộ field và hành vi hiện có: tên, số điện thoại, email, mật
khẩu/gắn tài khoản, trạng thái, số tiết tối đa, đơn giá, ghi chú. Cả form
**Thêm** và **Sửa** đều phải có ba field mới.

### 2. Nguồn dữ liệu cho multi-select

- Trường: tái sử dụng API/component lấy danh sách trường đang có của dự án
  (`GET /schools`). Giá trị option là `school.id`, nhãn là `school.name`.
- Môn: gọi `GET /subject-catalogs` **không truyền `includeInactive=true`** để chỉ
  lấy các môn đang sử dụng. Giá trị option là `id`; nhãn ưu tiên
  `code ? "[code] name" : name`.
- Đây là **danh mục môn dùng chung**, tuyệt đối không lấy danh sách `/subjects`
  theo từng trường. Một môn của từng trường có ID khác nhau và không phù hợp để
  khai năng lực giáo viên.
- Hai ô đều phải tìm kiếm được, chọn/bỏ chọn nhiều giá trị và hiển thị các giá
  trị đã chọn dưới dạng chip/tag dễ đọc.
- Load danh sách option một lần khi mở modal; có loading, empty state và thông
  báo khi tải thất bại. Không gọi API riêng cho từng option.

### 3. Payload tạo giáo viên

Gọi `POST /teachers` và gửi thêm ba field mới:

```json
{
  "name": "Cô Nguyễn Thị Lan",
  "phone": "0911222333",
  "email": "lan@example.com",
  "googleMapsUrl": "https://maps.app.goo.gl/example",
  "schoolIds": [10, 12],
  "subjectCatalogIds": [1, 3]
}
```

- `schoolIds` và `subjectCatalogIds` là mảng số, không gửi object option và
  không gửi ID dưới dạng chuỗi.
- Cho phép không chọn trường/môn; khi tạo có thể gửi `[]`.
- `googleMapsUrl` không bắt buộc. Chỉ chấp nhận link Google Maps. Hiển thị lỗi
  validation ngay dưới input nếu URL không hợp lệ và vẫn hiển thị nguyên
  `message` của backend khi API trả 400.
- Không tự bóc tọa độ hoặc gọi Google Maps từ FE; backend hiện chỉ cần lưu link.

### 4. Dữ liệu và payload sửa giáo viên

`GET /teachers`, `GET /teachers/:id`, response của POST và PATCH trả thêm:

```json
{
  "googleMapsUrl": "https://maps.app.goo.gl/example",
  "schoolIds": [10, 12],
  "allowedSchools": [
    { "id": 10, "name": "Trường A" },
    { "id": 12, "name": "Trường B" }
  ],
  "subjectCatalogIds": [1, 3],
  "teachableSubjects": [
    { "id": 1, "name": "STEM", "code": "STEM" },
    { "id": 3, "name": "Kỹ năng sống", "code": null }
  ]
}
```

- Khi mở modal sửa, prefill bằng `googleMapsUrl`, `schoolIds` và
  `subjectCatalogIds`.
- `allowedSchools` / `teachableSubjects` dùng để hiển thị tên; payload chỉ gửi
  lại hai mảng ID.
- Với PATCH: bỏ một field khỏi payload nghĩa là **giữ nguyên** field đó; gửi
  `schoolIds: []` hoặc `subjectCatalogIds: []` nghĩa là **xoá toàn bộ lựa chọn**;
  gửi `googleMapsUrl: null` hoặc chuỗi rỗng nghĩa là xoá vị trí.
- Sau khi lưu thành công, dùng object API trả về để cập nhật danh sách/cache,
  không tự ghép một response giả từ state form.

### 5. Hiển thị trên danh sách/chi tiết

- Ở danh sách giáo viên, thêm phần tóm tắt gọn cho trường và môn. Hiển thị tối
  đa hai tên, nếu còn thì hiện `+N`; không kéo chiều cao mỗi dòng quá lớn.
- Link vị trí có action **Mở bản đồ**, mở tab mới với
  `target="_blank" rel="noopener noreferrer"`. Không render URL dài nguyên văn.
- Khi chưa khai: hiển thị `Chưa khai vị trí`, `Chưa chọn trường`, hoặc
  `Chưa chọn môn`; không hiển thị mảng rỗng hay dấu gạch khó hiểu.
- Responsive: trên mobile các multi-select chiếm toàn bộ chiều rộng và chip
  được wrap, không làm modal tràn ngang.

### 6. Error handling

- 400 do ID không tồn tại: hiển thị nguyên message backend, ví dụ
  `Trường không tồn tại: 999` hoặc `Môn học trong danh mục không tồn tại: 99`.
- 400 do link sai: focus ô vị trí và hiển thị lỗi dưới field.
- 409 trùng số điện thoại/email/tài khoản: giữ nguyên dữ liệu form để người dùng
  sửa, không đóng modal.
- Disable nút Lưu trong lúc request đang chạy và chống submit hai lần.

### 7. Tiêu chí nghiệm thu

- [ ] Tạo giáo viên với một hoặc nhiều trường và môn thành công.
- [ ] Tạo giáo viên không chọn trường/môn vẫn thành công.
- [ ] Link không phải Google Maps bị báo lỗi rõ ràng.
- [ ] Mở sửa thấy đúng vị trí, toàn bộ trường và môn đã chọn.
- [ ] Thêm/bỏ một lựa chọn rồi lưu; mở lại dữ liệu vẫn chính xác.
- [ ] Bỏ hết trường hoặc môn gửi mảng rỗng và backend lưu rỗng.
- [ ] Xoá vị trí bằng input rỗng và mở lại không còn link.
- [ ] Danh sách hiển thị tên trường/môn từ response, không hiển thị ID thô.
- [ ] Không dùng `/subjects` làm nguồn multi-select môn giáo viên.
- [ ] Các luồng giáo viên cũ và form đơn giá vẫn hoạt động như trước.
