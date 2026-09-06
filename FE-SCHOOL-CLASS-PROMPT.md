# PROMPT: CẬP NHẬT FRONTEND — LỚP HỌC, ÁP MÔN HÀNG LOẠT & ĐƠN GIÁ MỖI TIẾT

Bạn là Senior Frontend Developer. Backend đã đổi 3 thứ ở module Giảng dạy:

1. Nhân sự **tạo lớp học cho từng trường**, chọn **nhiều môn cho một lớp**, rồi **lên lịch dạy cho lớp** thay vì cho cả trường.
2. Một môn **áp được cho nhiều lớp của nhiều trường trong một lần bấm** — phần giảm thao tác nhiều nhất, xem mục 4.
3. **Đơn giá mỗi tiết** cho giáo viên, bảng công tính ra tiền — xem mục 5.

Hãy cập nhật UI theo tài liệu này.

> ⚠️ **Đây là breaking change.** `POST /teaching-schedules` giờ **bắt buộc `classId`**. Màn "Lịch dạy" hiện tại (`ScheduleTemplateTab.tsx`) gửi `schoolId` mà không có `classId` sẽ bị **400** cho tới khi cập nhật.

## 0. Bối cảnh (đọc kỹ)

Trước đây một mẫu lịch chỉ gắn tới **trường** + **môn**. Nhưng một trường có nhiều lớp cùng học một môn ở các khung giờ khác nhau, nên:

- không biết buổi đó dạy lớp nào,
- không chặn được việc xếp hai buổi trùng giờ cho **cùng một lớp**.

Giờ mô hình là: **Trường → Lớp → Lịch dạy → Buổi dạy**.

| | Trước | Sau |
|---|---|---|
| Xếp lịch cho | `schoolId` | `classId` (trường suy ra từ lớp) |
| Chặn trùng | chỉ theo giáo viên | theo giáo viên **và** theo lớp |
| Buổi dạy | có `schoolId` | có thêm `classId` / `className` |

**Dữ liệu cũ được giữ nguyên**: lịch/buổi tạo trước khi có module này có `classId = null` và vẫn xem/sửa/chấm công bình thường — UI phải hiển thị "—" chứ không được crash.

## 1. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**.
- **Auth**: JWT Bearer, bắt buộc ở mọi endpoint dưới đây.
- Role `nhansu` toàn quyền; `director`, `director_la`, `troly_gd`, `ketoan_truong` chỉ xem; `giaovien` **đọc được** `/school-classes` (để hiển thị tên lớp) nhưng không ghi.

---

## 2. API lớp học

### 2.1 Danh sách lớp

**GET** `/school-classes`

| Param | Kiểu | Mô tả |
|---|---|---|
| `schoolId` | number | Lọc theo trường — dùng cho dropdown chọn lớp |
| `schoolYear` | string | `"2026-2027"`, `"Hè 2026-2027"`… |
| `gradeLevel` | 1–12 | Khối |
| `isActive` | boolean | `false` = lớp đã ngừng dùng |
| `search` | string | Theo tên lớp hoặc GVCN, không phân biệt hoa/thường |
| `page` / `limit` | number | mặc định 1 / 50, `limit` tối đa 200 |

```json
{
  "data": [
    {
      "id": 1,
      "schoolId": 494,
      "schoolName": "TIỂU HỌC THẮNG NHÌ",
      "name": "1A",
      "gradeLevel": 1,
      "schoolYear": "2026-2027",
      "studentCount": 35,
      "homeroomTeacher": "Cô Lan",
      "isActive": true,
      "note": null,
      "scheduleCount": 0,
      "sessionCount": 0,
      "subjectIds": [794, 795],
      "subjects": [
        {
          "id": 794,
          "name": "STEM",
          "code": "STEM",
          "catalogId": 1,
          "recommendedTeachers": [{ "id": 12, "name": "Nguyễn Văn A" }]
        }
      ]
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 1, "totalPages": 1 }
}
```

Danh sách đã sắp xếp sẵn theo khối rồi tới tên lớp — FE **giữ nguyên thứ tự trả về**.

`scheduleCount` / `sessionCount` = lớp đang được dùng ở bao nhiêu lịch / buổi. Dùng để:
- hiển thị cột "Đang dùng" ở màn quản lý,
- disable nút Xoá khi > 0 (BE cũng chặn bằng 409).

### 2.2 Chi tiết

**GET** `/school-classes/:id` → 1 object như trên. Không có → `404`.

### 2.3 Tạo lớp (`nhansu`)

**POST** `/school-classes`

```json
{
  "schoolId": 494,           // bắt buộc
  "name": "1A",              // bắt buộc, ≤ 100 ký tự, tự bỏ khoảng trắng thừa
  "schoolYear": "2026-2027", // bắt buộc, ≤ 20 ký tự (chuỗi tự do, cùng quy ước với môn học)
  "subjectIds": [794, 795],  // tuỳ chọn; chọn nhiều môn thuộc đúng trường và năm học
  "gradeLevel": 1,           // tuỳ chọn, 1–12; null với mầm non
  "studentCount": 35,        // tuỳ chọn, 0–1000, mặc định 0
  "homeroomTeacher": "Cô Lan", // tuỳ chọn — GVCN phía trường, KHÔNG phải hồ sơ giáo viên
  "isActive": true,          // tuỳ chọn, mặc định true
  "note": null
}
```

Lỗi:

| Mã | Khi nào |
|---|---|
| 400 | thiếu `name` / `schoolYear`, `schoolId` không tồn tại |
| 400 | môn không tồn tại, không thuộc trường hoặc không đúng năm học của lớp |
| 409 | trùng tên lớp trong **cùng trường + cùng năm học** (so không phân biệt hoa/thường) |

Cùng tên lớp ở **năm học khác** thì tạo được — đó là lớp của khoá sau.

### 2.4 Sửa lớp (`nhansu`)

**PATCH** `/school-classes/:id` — như POST nhưng mọi field đều tuỳ chọn.

Gửi `subjectIds: []` để bỏ toàn bộ môn; không gửi `subjectIds` thì giữ nguyên. Mỗi
môn trong response có `recommendedTeachers`: các giáo viên đang hoạt động, được
phép dạy tại trường và đã khai năng lực cho đúng danh mục môn. Đây là gợi ý để
Nhân sự chọn, backend không tự động phân công.

> **`schoolId` bị bỏ qua**: không đổi được trường của lớp (lịch đã sinh sẽ trỏ sai trường). Form sửa **không hiển thị ô chọn trường**, chỉ hiển thị tên trường ở dạng chỉ đọc.

### 2.5 Xoá lớp (`nhansu`)

**DELETE** `/school-classes/:id` → `{ "deleted": true, "id": 1 }`

`409` khi lớp đã có lịch hoặc buổi dạy, message nêu rõ số lượng. Toast hiển thị nguyên message của BE và gợi ý tắt `isActive`.

---

## 3. Thay đổi ở lịch dạy & buổi dạy

### 3.1 `POST /teaching-schedules` — **`classId` bắt buộc**

```json
{
  "teacherId": 1,
  "classId": 1,          // ⬅️ MỚI, bắt buộc
  "subjectId": 794,
  "dayOfWeek": 3,
  "startTime": "07:30",
  "endTime": "09:00",
  "effectiveFrom": "2026-09-01",
  "effectiveTo": "2026-09-30"
}
```

- **Không cần gửi `schoolId`** — BE lấy trường theo lớp. Gửi kèm cũng được nhưng phải khớp, lệch thì `400 "Lớp học không thuộc trường đã chọn"`.
- Lớp `isActive = false` → `400 "Lớp ... đang ngừng sử dụng"`.
- **`409` mới**: lớp đã có mẫu lịch cùng thứ, giao giờ, giao khoảng hiệu lực — **kể cả giáo viên khác**. Message nêu rõ môn và tên giáo viên đang giữ chỗ.

`PATCH /teaching-schedules/:id` nhận `classId` để đổi lớp; không gửi thì giữ nguyên lớp cũ.

### 3.2 `POST /teaching-sessions` — `classId` tuỳ chọn nhưng nên gửi

- Gửi `classId` → **không cần `schoolId`**.
- Buổi **dạy bù** (`makeupForSessionId`) không gửi `classId` thì **tự kế thừa lớp của buổi gốc**.
- Không có cả `classId` lẫn `schoolId` → `400 "Vui lòng chọn lớp học cho buổi dạy"`.
- **`409` mới**: lớp đã có buổi giao giờ trong cùng ngày (kể cả giáo viên khác). Buổi `CANCELLED` không chiếm chỗ; chạm biên giờ (10:30 kết thúc / 10:30 bắt đầu) không tính là trùng.

`PATCH /teaching-sessions/:id` nhận `classId` để đổi lớp — **lớp phải cùng trường** với buổi đang sửa.

### 3.3 Field mới trong response

`GET/POST/PATCH` của `/teaching-schedules` và `/teaching-sessions` đều trả thêm:

```jsonc
"classId": 1,          // null với lịch/buổi cũ chưa gắn lớp
"className": "1A",     // null tương ứng
"classGradeLevel": 1   // null khi lớp không khai báo khối
```

### 3.4 Bộ lọc mới

`classId` dùng được ở:

- `GET /teaching-schedules?classId=`
- `GET /teaching-sessions?classId=` (và `/teaching-sessions/me`)
- `GET /teaching-sessions/attendance/summary?classId=`
- `POST /teaching-sessions/notify-schedule` (giới hạn phạm vi gửi lịch theo lớp)

---

## 4. Áp một môn cho nhiều lớp của nhiều trường (phần quan trọng nhất)

### 4.1 Vì sao không gửi thẳng `subjectId` cho mọi lớp được

Môn của trường (`/subjects`) là **bản ghi riêng cho từng trường** kèm hợp đồng, số tiết, năm học — `subjectId` của trường A **không dùng được** cho trường B. Cái dùng chung là **danh mục môn** (`/subject-catalogs`: STEM, Kỹ năng sống, Công dân số…).

Nên luồng đúng là: Nhân sự chọn môn **một lần trong danh mục** → gửi `catalogId` → backend tự tra ra `subjectId` của từng trường theo `(trường của lớp, catalogId, năm học của lớp)`.

```
catalogId = 6 ("Kỹ năng sống")
  ├── lớp 1B @ TIỂU HỌC TÂN THÀNH   -> subjectId 748 "Kỹ năng sống"
  ├── lớp 6A @ THCS GIA LỘC          -> subjectId 751 "KỸ NĂNG SỐNG"
  └── lớp 5A @ TH ABC                -> bỏ qua: trường chưa khai môn này
```

### 4.2 Bước 1 — xem trước lớp nào áp được

**GET** `/school-classes?catalogId=6&schoolYear=2026-2027` (thêm `schoolId` nếu lọc theo trường).

Mỗi lớp trả thêm:

| Field | Ý nghĩa |
|---|---|
| `subjectStatus` | `RESOLVED` = áp được · `MISSING` = trường chưa khai môn · `AMBIGUOUS` = trường có nhiều môn trùng tên |
| `subjectId`, `subjectName` | môn của trường, chỉ có khi `RESOLVED` |
| `subjectReason` | lý do khi không `RESOLVED` — hiển thị thẳng, đừng tự viết lại |

UI: bảng tick chọn lớp, nhóm theo trường. Lớp `MISSING` để **disabled** kèm tooltip `subjectReason`. Lớp `AMBIGUOUS` cho chọn nhưng bắt Nhân sự chọn môn cụ thể (dropdown `/subjects?schoolId=...`) rồi gửi kèm `subjectId` ở item đó.

### 4.3 Bước 2 — tạo hàng loạt

**POST** `/teaching-schedules/bulk`

```jsonc
{
  "catalogId": 6,
  "teacherId": 1,
  "dayOfWeek": 4, "startTime": "07:30", "endTime": "09:00",
  "effectiveFrom": "2026-10-01", "effectiveTo": "2026-10-31",
  "items": [
    { "classId": 5 },
    { "classId": 6, "startTime": "09:15", "endTime": "10:45" },
    { "classId": 7, "teacherId": 2, "dayOfWeek": 5 },
    { "classId": 9, "subjectId": 724 }
  ],
  "generateSessions": { "fromDate": "2026-10-01", "toDate": "2026-10-31" }
}
```

- Giá trị ở cấp lô = **mặc định**; field nào có trong `items[i]` thì lớp đó dùng giá trị riêng.
- `generateSessions` gộp luôn bước "sinh buổi" — bỏ được một lần bấm nữa.
- Giới hạn: 200 lớp/lần.

Trả **200** (không phải 201) kèm kết quả từng lớp:

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

### 4.4 Tạo tiết hàng loạt

**POST** `/teaching-sessions/bulk` — nhân **lớp × ngày**, dùng cho tiết lẻ không theo mẫu lặp.

```jsonc
{
  "catalogId": 6,
  "startTime": "14:00", "endTime": "15:30",
  "dates": ["2026-11-03", "2026-11-10", "2026-11-17"],
  "items": [
    { "classId": 6 },
    { "classId": 7, "date": "2026-11-20" }
  ]
}
```

**Bỏ `teacherId` → tiết được tạo ở `assignmentStatus = OPEN`** cho giáo viên đăng ký ở màn "Tiết đang mở". Đây là cách nhanh nhất để mở một loạt tiết cho nhiều lớp.

Mỗi dòng `results` có thêm `date`. Giới hạn: 200 lớp, 31 ngày, 500 tiết mỗi lần.

### 4.5 ⚠️ Hai loại lỗi — UI phải xử lý khác nhau

| Loại | Ví dụ | BE trả | UI |
|---|---|---|---|
| Sai từ phía client | thiếu `teacherId`, giờ ngược, `classId` lặp, vượt trần | **400**, không ghi gì | toast lỗi, giữ nguyên form |
| Trạng thái dữ liệu | trường chưa khai môn, lớp trùng giờ, lớp ngừng dùng | **200**, lớp đó `SKIPPED` | **màn hình kết quả**, không phải toast |

**Đừng coi `skipped > 0` là thất bại.** Sau khi gọi xong, hiện một màn kết quả:

- Dòng tóm tắt: *"Đã tạo 18 lịch, sinh 72 buổi. 2 lớp bị bỏ qua."*
- Bảng các lớp `SKIPPED` kèm `reason` nguyên văn của BE (đã đủ ngữ cảnh: tên trường, tên môn, năm học, giờ trùng).
- Nút "Thử lại các lớp bị bỏ qua" gửi lại lô chỉ gồm những `classId` đó — sau khi Nhân sự đã khai môn cho trường thiếu.

### 4.6 Gợi ý UI

Thêm nút **"Áp môn cho nhiều lớp"** ở màn Lịch dạy, mở wizard 3 bước:

1. **Chọn môn** — dropdown `/subject-catalogs` + năm học.
2. **Chọn lớp** — bảng từ `/school-classes?catalogId=...`, nhóm theo trường, có "chọn tất cả lớp của trường". Hiện ngay số lớp `RESOLVED` / `MISSING`.
3. **Khai giờ & giáo viên** — form mặc định cho cả lô, cho phép mở rộng từng dòng để override. Checkbox "Sinh buổi luôn" kèm khoảng ngày.

Bấm Lưu → gọi bulk → màn kết quả ở 4.5.

---

## 5. Đơn giá mỗi tiết & tiền công

### 5.1 Chuỗi đơn giá

```
teachers.defaultRatePerPeriod       đơn giá mặc định của giáo viên
        ↓ chốt khi tạo mẫu lịch
teaching_schedules.ratePerPeriod    đơn giá riêng cho mẫu lịch
        ↓ chốt khi sinh buổi
teaching_sessions.ratePerPeriod     ĐƠN GIÁ CHỐT — nguồn duy nhất tính tiền
```

Ở mỗi bước, giá FE gửi lên thắng giá kế thừa. **`0` là đơn giá hợp lệ** (dạy không công) và không rơi về mức kế thừa — chỉ bỏ trống mới kế thừa. Ô nhập tiền phải phân biệt "để trống" với "gõ số 0".

### 5.2 ⚠️ Đơn giá được CHỐT, không tra ngược

Buổi dạy lưu đơn giá tại thời điểm tạo. **Sửa đơn giá giáo viên không làm đổi buổi đã tạo** — nếu không thì tăng giá hôm nay sẽ làm lệch bảng công các tháng trước.

UI phải nói rõ điều này, nếu không Nhân sự sẽ tưởng sửa giá là xong:

- Form sửa giáo viên: chú thích dưới ô đơn giá — *"Đơn giá mới chỉ áp cho buổi dạy tạo về sau. Buổi đã tạo giữ nguyên đơn giá cũ."*
- Muốn sửa buổi đã tạo → `PATCH /teaching-sessions/:id { ratePerPeriod }` cho từng buổi (nên có thao tác sửa nhanh ngay trên bảng chấm công).

### 5.3 Field mới trong response

| Nơi | Field | Ghi chú |
|---|---|---|
| `/teachers` | `defaultRatePerPeriod: number \| null` | null = chưa khai |
| `/teaching-schedules` | `ratePerPeriod: number \| null` | |
| `/teaching-sessions` | `ratePerPeriod: number \| null`, `amount: number \| null` | `amount = ratePerPeriod × periods` |

**`amount: null` ≠ `amount: 0`.** `null` = *chưa khai giá* (hiển thị "—" hoặc badge cảnh báo), `0` = *dạy không công* (hiển thị "0đ"). Đừng dùng `amount || 0`.

### 5.4 Gửi đơn giá lên

`ratePerPeriod` nhận được ở: `POST/PATCH /teaching-schedules`, `POST/PATCH /teaching-sessions`, và cả hai endpoint bulk (cấp lô + override từng `items[i]`). `defaultRatePerPeriod` ở `POST/PATCH /teachers`.

Giá trị 0 → 100.000.000, tối đa 2 chữ số thập phân; ngoài khoảng → 400.

### 5.5 Bảng công có tiền

`GET /teaching-sessions/attendance/summary` trả thêm mỗi dòng:

| Field | Ý nghĩa |
|---|---|
| `totalPeriods` | tổng số tiết, mọi trạng thái |
| `payablePeriods` | số tiết được trả tiền |
| `payableAmount` | tiền công |
| `missingRateSessions` | **số buổi đã dạy nhưng chưa khai giá** |

Kèm `grandTotal` cộng dồn cả bảng — dùng cho dòng tổng cuối bảng.

> **Chỉ buổi `PRESENT` được tính tiền.** `ABSENT` / `EXCUSED` / `CANCELLED` không trả công.

**`missingRateSessions > 0` phải hiện cảnh báo**, ví dụ banner đỏ: *"3 buổi đã dạy chưa khai đơn giá — bảng công chưa đầy đủ."* kèm link lọc ra đúng các buổi đó. Đây là nguồn sai số lương phổ biến nhất; đừng chỉ hiện con số rồi thôi.

### 5.6 Định dạng tiền

Dùng `Intl.NumberFormat("vi-VN")`, hậu tố "đ". Ô nhập nên có tách nhóm hàng nghìn khi gõ, nhưng **gửi lên API là số thuần** (`150000`, không phải `"150.000"`).

---

## 6. Việc cần làm ở FE

Code hiện tại: [src/pages/Teaching/](../kido-app/src/pages/Teaching/) — types ở `src/types/teaching.ts`, helper ở `Teaching/lib.ts`.

### 6.1 Types (`src/types/teaching.ts`)

```ts
export interface SchoolClass {
  id: number;
  schoolId: number;
  schoolName: string;
  name: string;
  gradeLevel: number | null;
  schoolYear: string;
  studentCount: number;
  homeroomTeacher: string | null;
  isActive: boolean;
  note: string | null;
  scheduleCount: number;
  sessionCount: number;
}
```

Thêm `classId: number | null`, `className: string | null`, `classGradeLevel: number | null` vào `TeachingSchedule` và `TeachingSession`.

Đơn giá:

```ts
// Teacher
defaultRatePerPeriod: number | null;

// TeachingSchedule
ratePerPeriod: number | null;

// TeachingSession
ratePerPeriod: number | null;
/** = ratePerPeriod × periods. null = CHƯA khai giá, khác hẳn 0. */
amount: number | null;
```

`AttendanceSummaryRow` thêm `totalPeriods`, `payablePeriods`, `payableAmount`, `missingRateSessions`; response bọc thêm `grandTotal`.

⚠️ `plannedFromSchedules()` trong `Teaching/lib.ts` dựng `CalendarSession` từ mẫu lịch — nhớ map thêm 3 field này, nếu không ô "dự kiến" trên lịch sẽ thiếu tên lớp so với buổi thật.

### 6.2 Màn quản lý lớp học (mới)

Thêm tab **"Lớp học"** vào menu Nhân sự (`TEACHING_MENUS` trong `Teaching/lib.ts`), path gợi ý `/nhan-su/lop-hoc`, đặt **trước** "Lịch dạy" vì phải tạo lớp mới xếp được lịch.

- Bộ lọc: trường (bắt buộc chọn trước, dùng dropdown trường sẵn có), năm học, khối, `isActive`, ô tìm kiếm.
- Bảng: Tên lớp · Khối · Năm học · Sĩ số · GVCN · Đang dùng (`scheduleCount` lịch / `sessionCount` buổi) · Trạng thái · thao tác Sửa / Xoá.
- Modal tạo/sửa dùng lại `components/Modal.tsx`; form sửa khoá ô chọn trường.
- Toggle `isActive` ngay trên hàng (PATCH `{ isActive }`) — đây là cách "ngừng dùng" thay cho xoá.

### 6.3 Form mẫu lịch (`components/ScheduleFormModal.tsx`)

- Thay ô chọn **Trường** bằng cặp **Trường → Lớp**: chọn trường để lọc, nhưng field gửi lên là `classId`.
- Chỉ nạp lớp `isActive = true` (`GET /school-classes?schoolId=<id>&isActive=true`).
- Bỏ `schoolId` khỏi payload.
- Disable nút Lưu khi chưa chọn lớp; hiển thị nguyên message 409 của BE (đã đủ ngữ cảnh: thứ, giờ, môn, giáo viên).
- Trường không có lớp nào → hiện empty state kèm link sang màn Lớp học, đừng để dropdown rỗng không giải thích.

### 6.4 Form buổi dạy (`components/SessionFormModal.tsx`)

- Thêm ô chọn lớp tương tự; với buổi **dạy bù** thì prefill lớp của buổi gốc và cho sửa.
- Bỏ `schoolId` khỏi payload khi đã có `classId`.

### 6.5 Hiển thị tên lớp

- `ScheduleTemplateTab` / `SessionTab` / `AttendanceTab`: thêm cột **Lớp**, `className ?? "—"`.
- `SessionDetailDrawer`, `WeekTemplate`, `SessionViews` (ô trên lịch): hiển thị lớp cạnh tên trường, ví dụ `TIỂU HỌC THẮNG NHÌ · 1A`.
- `MySchedulePage` (màn giáo viên): hiển thị lớp — giáo viên cần biết vào lớp nào.
- `SummaryTab`: thêm bộ lọc theo lớp (truyền `classId` vào `/attendance/summary`).

### 6.6 Wizard "Áp môn cho nhiều lớp" (mục 4)

Màn mới, gợi ý đặt ở màn Lịch dạy. Việc cần làm:

- Type `SchoolClass` thêm 4 field tuỳ chọn: `subjectStatus`, `subjectId`, `subjectName`, `subjectReason` (chỉ có khi query kèm `catalogId`).
- Hook lấy danh mục môn: `GET /subject-catalogs` (đã có sẵn ở màn môn học của NVKD, dùng lại).
- Bước chọn lớp gọi `GET /school-classes?catalogId=&schoolYear=&limit=200`, gom nhóm theo `schoolName`.
- Bước xác nhận gọi `POST /teaching-schedules/bulk` (hoặc `/teaching-sessions/bulk`), rồi render màn kết quả theo 4.5.
- **Không tự lọc bỏ lớp `MISSING` khỏi payload rồi im lặng** — cứ để BE trả `SKIPPED` và hiện lý do, Nhân sự cần biết trường nào còn thiếu môn để đi khai.

### 6.7 Đơn giá & tiền công (mục 5)

- `TeacherFormModal.tsx`: thêm ô **Đơn giá mỗi tiết** + chú thích "chỉ áp cho buổi tạo về sau"; cột đơn giá ở `TeacherList.tsx`.
- `ScheduleFormModal.tsx` / `SessionFormModal.tsx`: ô đơn giá, placeholder ghi rõ mức sẽ kế thừa nếu để trống (VD: *"Để trống = 150.000đ theo giáo viên"*).
- `SessionTab` / `AttendanceTab` / `SessionDetailDrawer`: cột **Đơn giá** và **Thành tiền**; `amount === null` → hiện "—" kèm badge "chưa khai giá", **không** hiện "0đ".
- `SummaryTab`: cột `payablePeriods` / `payableAmount`, dòng tổng từ `grandTotal`, và banner cảnh báo khi `grandTotal.missingRateSessions > 0`.
- Wizard áp môn hàng loạt: thêm ô đơn giá ở bước 3 (cấp lô), cho override từng dòng.
- Helper `formatMoney` dùng `Intl.NumberFormat("vi-VN")`; ô nhập tách nhóm hàng nghìn nhưng gửi API số thuần.

### 6.8 Kiểm thử tay

1. Tạo 2 lớp cho cùng một trường, xếp lịch cùng khung giờ cho 2 lớp khác nhau → phải thành công.
2. Xếp lịch trùng giờ cho **cùng một lớp** với giáo viên khác → phải thấy 409 với message của BE.
3. Mở một lịch cũ (`classId = null`) → sửa/lưu được, cột Lớp hiện "—".
4. Xoá lớp đang có lịch → thấy 409 và gợi ý tắt `isActive`.
5. Áp một môn cho các lớp thuộc **2 trường khác nhau** → mỗi lớp phải nhận đúng `subjectName` của trường mình (kiểm tra ở màn kết quả).
6. Cố tình chọn thêm một lớp thuộc trường chưa khai môn đó → lô vẫn tạo cho các lớp còn lại, lớp kia hiện `SKIPPED` kèm lý do.
7. Bulk tiết không chọn giáo viên → các tiết phải hiện ở màn "Tiết đang mở" của giáo viên.
8. Khai đơn giá cho giáo viên → xếp lịch **không** nhập giá → mẫu lịch và buổi sinh ra phải tự có đơn giá đó.
9. **Sửa đơn giá giáo viên → mở lại buổi đã tạo: đơn giá phải KHÔNG đổi.** Đây là hành vi dễ bị hiểu nhầm là bug, phải kiểm tra kỹ.
10. Chấm 1 buổi `PRESENT` + 1 buổi `ABSENT` → bảng công chỉ tính tiền buổi `PRESENT`.
11. Một buổi `PRESENT` chưa khai giá → bảng công phải hiện cảnh báo `missingRateSessions`.
