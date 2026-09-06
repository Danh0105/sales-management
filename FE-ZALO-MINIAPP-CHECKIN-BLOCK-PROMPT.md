# PROMPT: ZALO MINI APP — CHECK-IN/CHECK-OUT THEO BLOCK CÙNG TRƯỜNG

Bạn là Senior Frontend Developer làm Zalo Mini App cho giáo viên. Backend vừa nới lỏng luồng check-in/check-out: **các tiết liên tiếp cùng một trường trong ngày chỉ cần check-in tiết đầu và check-out tiết cuối** — các tiết ở giữa (và tiết đầu của một block nhiều tiết) không cần bấm check-in/check-out GPS nữa, chỉ cần nộp nội dung bài dạy qua một endpoint mới không cần định vị.

> ⚠️ **Không phải breaking change** — API check-in/check-out cũ vẫn hoạt động y hệt cho buổi lẻ (không liên tiếp trường nào khác). Đây là tính năng cộng thêm: 2 field mới trên mỗi buổi dạy (`checkinRequired`, `checkoutRequired`) và 1 endpoint mới (`/lesson`). Nếu Mini App không đọc 2 field mới, giáo viên vẫn phải check-in/check-out từng tiết như cũ — không hỏng gì, chỉ là chưa tận dụng được tính năng.

## 0. Vì sao

Giáo viên dạy 2-3 tiết liền nhau cùng một trường (ví dụ 07:30–08:15, 08:15–09:00, 09:00–09:45 đều tại "Tiểu học ABC") trước đây phải check-in + check-out GPS cho **từng tiết** — thao tác thừa vì họ không rời trường giữa các tiết. Giờ chỉ cần: check-in ở tiết đầu, check-out ở tiết cuối. Các tiết ở giữa vẫn phải ghi lại nội dung bài dạy (tên bài, đánh giá, ảnh) — chỉ bỏ phần định vị GPS.

Nếu các tiết **khác trường** (kể cả liền giờ nhau, ví dụ 09:00 trường A rồi 09:45 trường B) thì check-in/check-out vẫn bắt buộc cho từng tiết như cũ — không có gì đổi.

## 1. "Liên tiếp cùng trường" tính thế nào

Thuần theo **thứ tự tiết trong ngày của giáo viên** (sắp theo giờ bắt đầu), **không** xét khoảng nghỉ giữa hai tiết. Tiết ngay trước và tiết ngay sau cùng `schoolId` → gộp vào một block. Đổi `schoolId` → ngắt block, tiết đó là "tiết đầu" của block mới.

Ví dụ: 07:30–08:15 (trường A), nghỉ 30 phút, 08:45–09:30 (trường A) → **vẫn là 1 block** dù có nghỉ giữa, vì trường không đổi.

## 2. Hai field mới trên mọi buổi dạy

`GET /teaching-sessions/me`, `GET /teaching-sessions/:id` (và các API danh sách buổi khác) giờ trả kèm:

```json
{
  "id": 943,
  "startTime": "09:00",
  "endTime": "09:45",
  "schoolId": 529,
  "schoolName": "Trường TEST",
  "checkinRequired": true,
  "checkoutRequired": false,
  "checkinAt": null,
  "checkoutAt": null
}
```

| Field | Ý nghĩa |
|---|---|
| `checkinRequired: true` | Tiết đầu block (hoặc buổi lẻ) — cần bấm **Check-in** |
| `checkoutRequired: true` | Tiết cuối block (hoặc buổi lẻ) — cần bấm **Check-out** (kèm nội dung bài dạy) |
| Cả hai `true` | Buổi lẻ/buổi đầu = buổi cuối — luồng y hệt hiện tại, không đổi gì |
| Cả hai `false` | Tiết giữa block — **không** cần GPS, chỉ nộp nội dung bài dạy qua endpoint mới (mục 4) |
| `checkinRequired: false, checkoutRequired: true` | Tiết cuối một block nhiều tiết — bấm **Check-out** dù tiết này **chưa từng tự check-in** (xem mục 3) |

**Quyết định hiện nút hoàn toàn dựa vào 2 field này, không dựa vào `checkinAt`/`checkoutAt` của chính tiết đó** (vì tiết giữa/tiết cuối có thể có `checkinAt = null` vĩnh viễn mà vẫn hợp lệ).

Logic chọn nút (áp dụng khi `checkoutAt` còn `null` — có `checkoutAt` thì tiết đã xong, không hiện nút nào):

```
checkinRequired && !checkinAt  → nút "Check-in"
checkoutRequired               → nút "Check-out" (mở form nội dung bài dạy + GPS)
còn lại (checkinRequired=false, checkoutRequired=false,
         hoặc checkinRequired=true && đã checkinAt && checkoutRequired=false)
                                → nút "Nộp nội dung bài dạy" (không cần GPS)
```

## 3. Check-out được nới lỏng — không còn bắt tự check-in

**`POST /teaching-sessions/:id/checkout`** — request body/behavior **không đổi** (vẫn multipart, vẫn cần `latitude`, `longitude`, `lessonName`, `lessonEvaluation`, optional `accuracy`, optional `images[]`). Điều đổi là điều kiện chặn phía sau:

- **Trước:** bắt buộc chính tiết này phải có `checkinAt`.
- **Giờ:** cho qua nếu chính tiết này có `checkinAt`, **hoặc** bất kỳ tiết nào khác cùng block (cùng giáo viên, cùng ngày, chuỗi liên tiếp cùng trường chứa tiết này) đã có `checkinAt`.

Đã kiểm chứng thật qua HTTP (2 tiết cùng trường, tiết 944 là tiết cuối, chưa từng tự check-in):

```
POST /teaching-sessions/944/checkout   (chưa ai trong block check-in)
  → 400 { code: "TEACHING_SESSION_NOT_CHECKED_IN", message: "Buổi dạy chưa check-in" }

POST /teaching-sessions/943/checkin    (tiết đầu, cùng trường với 944)
  → 200

POST /teaching-sessions/944/checkout   (944 tự nó vẫn checkinAt = null)
  → 200 { id: 944, checkinAt: null, checkoutAt: "2026-08-25T01:17:23.548Z",
          checkoutLatitude: 10.82513, checkoutOutOfRange: false, lessonName: "Bai cuoi" }
```

**Lưu ý quan trọng:** tiết cuối check-out thành công vẫn có `checkinAt: null` vĩnh viễn — đây không phải lỗi hiển thị, đó là vì bản thân tiết đó chưa từng có sự kiện check-in riêng. Đừng dùng `checkinAt` của tiết cuối để suy ra trạng thái "đã bắt đầu dạy" — dùng `checkinRequired`/`checkoutRequired` (mục 2) hoặc kiểm tra tiết đầu block.

## 4. API mới: nộp nội dung bài dạy không cần GPS

### `POST /teaching-sessions/:id/lesson`

Dùng cho tiết có `checkinRequired: false` **và** `checkoutRequired: false` (tiết giữa), hoặc tiết có `checkinRequired: true` nhưng đã check-in và `checkoutRequired: false` (tiết đầu của block nhiều tiết — GPS đã xong lúc check-in, giờ chỉ còn thiếu nội dung bài dạy).

**Headers:** `Authorization: Bearer <token>` (role `giaovien`)
**Content-Type:** `multipart/form-data`

| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `lessonName` | ✅ | string, tối đa 255 ký tự |
| `lessonEvaluation` | ✅ | string, tối đa 2000 ký tự |
| `images` | ❌ | tối đa 10 file, mỗi file ≤ 10MB, nhận jpeg/png/webp (server tự convert sang webp) |

**Không gửi** `latitude`/`longitude`/`accuracy` — endpoint này không nhận, có gửi cũng bị bỏ qua vì DTO không khai báo field đó.

Response: object buổi dạy đầy đủ, giống response của `/checkin`, `/checkout`. Trong đó `checkoutAt` được set (tái dùng làm mốc "đã nộp nội dung"), nhưng `checkoutLatitude`/`checkoutLongitude`/`checkoutDistance`/`checkoutOutOfRange` **giữ nguyên `null`** — vì không có GPS nào được gửi. Đừng coi `checkoutLatitude: null` là lỗi dữ liệu ở các tiết này.

### Điều kiện & lỗi

Cùng cơ chế "block đã có ai check-in chưa" như checkout (mục 3):

```
POST /teaching-sessions/944/lesson     (chưa ai trong block check-in)
  → 400 { code: "TEACHING_SESSION_NOT_CHECKED_IN",
          message: "Chưa check-in đầu buổi, vui lòng check-in trước" }
```

Các lỗi khác giống hệt `/checkout`:

| Status | Code | Khi nào |
|---|---|---|
| `403` | `TEACHING_SESSION_NOT_ASSIGNED` | Không phải giáo viên của buổi này |
| `404` | `TEACHER_PROFILE_NOT_FOUND` | Tài khoản chưa gắn hồ sơ giáo viên |
| `400` | `TEACHING_SESSION_CANCELLED` | Buổi đã bị huỷ |
| `400` | `TEACHING_SESSION_NOT_CHECKED_IN` | Cả block chưa ai check-in |
| `409` | `TEACHING_SESSION_ALREADY_CHECKED_OUT` | Tiết này đã nộp nội dung/check-out rồi — không gọi lại được |
| `400` | (validate) | Chỉ trong ngày dạy mới nộp được, giống check-in/check-out |

## 5. ⚠️ Kiểm tra lại luồng check-out hiện tại của Mini App

Khi làm web app tương tự (kido-app) tôi phát hiện checkout đang gọi API dạng JSON `{ latitude, longitude, accuracy }` — **thiếu `lessonName`/`lessonEvaluation`** và sai `Content-Type` (JSON thay vì multipart). Backend validate `lessonName`/`lessonEvaluation` là bắt buộc (`@IsNotEmpty`) nên request đó **luôn bị 400**, tức là check-out không bao giờ thành công qua đường đó.

**Hãy kiểm tra ngay xem Mini App có đang mắc lỗi tương tự không** — nếu luồng check-out hiện tại của Mini App chỉ gửi toạ độ mà không có ô nhập tên bài + đánh giá buổi học, thì đây là lúc phải bổ sung luôn (không phải lỗi mới do bản này gây ra, nhưng nếu chưa có UI nhập nội dung bài dạy thì check-out chưa từng hoạt động được).

## 6. Gợi ý UI

- Màn "Hôm nay": mỗi tiết hiện đúng 1 trong 3 nút theo công thức ở mục 2 — **Check-in** (xanh lá) / **Check-out** (xanh dương, mở form GPS + nội dung bài dạy) / **Nộp nội dung bài dạy** (tím, mở form chỉ có nội dung bài dạy, không xin quyền định vị).
- Form "Nộp nội dung bài dạy" và form "Check-out" nên dùng chung 1 component (tên bài, đánh giá, chọn ảnh) — khác nhau ở chỗ Check-out có thêm bước lấy GPS trước khi mở form, còn "Nộp nội dung bài dạy" mở form ngay, không xin quyền định vị (giáo viên không cần thấy prompt xin GPS ở tiết giữa — trải nghiệm xấu nếu xin mà không dùng).
- Tiết đã xong (`checkoutAt` khác `null`) → hiện "Đã chấm công xong buổi này", không hiện nút nào, kể cả khi `checkinAt` của chính tiết đó là `null` (trường hợp tiết giữa/cuối).

## 7. Nghiệm thu

Tài khoản thử: `0900000008` / `123456` (Giáo viên A, teacherId=1). Trường thử có toạ độ sẵn: `schoolId=529` "Trường TEST" (10.82513, 106.639023, bán kính 200m).

- [ ] Tạo 3 buổi liên tiếp cùng `schoolId=529` cho hôm nay (ví dụ `POST /teaching-sessions` với `teacherId=1, classId=13, subjectId=798`) → `GET /teaching-sessions/me` phải trả tiết 1: `checkinRequired=true, checkoutRequired=false`; tiết 2: cả hai `false`; tiết 3: `checkinRequired=false, checkoutRequired=true`.
- [ ] Tiết 1 hiện nút Check-in; bấm xong hiện nút "Nộp nội dung bài dạy" (không phải Check-out).
- [ ] Tiết 2 hiện thẳng nút "Nộp nội dung bài dạy" ngay từ đầu, không xin GPS.
- [ ] Tiết 3 hiện nút Check-out; bấm thành công dù tiết 3 chưa từng tự check-in — kiểm tra response `checkinAt: null, checkoutAt: <có giá trị>`.
- [ ] Tạo thêm 1 buổi ở `schoolId` khác cho cùng ngày → cả `checkinRequired` và `checkoutRequired` đều `true`, luồng y hệt hiện tại.
- [ ] Gọi `/checkout` hoặc `/lesson` cho một block **chưa ai check-in** → nhận đúng `400 TEACHING_SESSION_NOT_CHECKED_IN` với message tương ứng ở mục 3/4 — app hiện thông báo "Vui lòng check-in trước", không phải lỗi chung chung.
- [ ] Gọi lại `/checkout` hoặc `/lesson` cho tiết đã xong → `409 TEACHING_SESSION_ALREADY_CHECKED_OUT`.
- [ ] Xác nhận màn check-out hiện tại của Mini App có gửi `lessonName`/`lessonEvaluation` dạng multipart hay chưa (mục 5) — nếu chưa, bổ sung trước khi coi tính năng này là xong.

## 8. Kiểm chứng phía backend

Đã chạy thật qua HTTP + kiểm tra DB, không phải suy đoán (xem mục 3 để có log request/response đầy đủ):

```
2 tiết cùng schoolId=529, cùng giáo viên, cùng ngày — tiết 944 là tiết cuối

GET  /teaching-sessions/me
  → 943: checkinRequired=true,  checkoutRequired=false
  → 944: checkinRequired=false, checkoutRequired=true

POST /teaching-sessions/944/checkout   (chưa ai check-in)  → 400 NOT_CHECKED_IN
POST /teaching-sessions/944/lesson     (chưa ai check-in)  → 400 NOT_CHECKED_IN
POST /teaching-sessions/943/checkin                        → 200
POST /teaching-sessions/944/checkout   (944 tự nó chưa check-in) → 200
  checkinAt: null, checkoutAt: "2026-08-25T01:17:23.548Z",
  checkoutLatitude: 10.82513, checkoutOutOfRange: false
POST /teaching-sessions/944/checkout   (gọi lại lần 2)      → 409 ALREADY_CHECKED_OUT
```

Toàn bộ luồng cũng đã được kiểm qua UI thật (Playwright, web app tương đương) cho cả 2 trường hợp: block 3 tiết cùng trường và buổi lẻ khác trường — 0 lỗi console, 0 request lỗi. 567 unit test của backend đang pass.
