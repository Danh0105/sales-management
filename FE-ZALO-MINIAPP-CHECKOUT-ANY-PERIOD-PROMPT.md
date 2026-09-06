# PROMPT: ZALO MINI APP — CẬP NHẬT CHECK-OUT (BẤT KỲ TIẾT NÀO TRONG BLOCK)

Bạn là Senior Frontend Developer làm Zalo Mini App cho giáo viên. Đây là bản **cập nhật** cho `FE-ZALO-MINIAPP-CHECKIN-BLOCK-PROMPT.md` — bản đó vẫn đúng phần "liên tiếp cùng trường tính thế nào" (mục 1) và check-in (không đổi gì). Phần **check-out và nộp bài đã đổi** — đọc kỹ mục 3 dưới đây trước khi sửa code, vì có 2 chỗ bản cũ ghi **sai** so với backend thật hiện tại (mục 3.1 và 3.2).

## 0. Vì sao đổi tiếp

Bản trước: chỉ tiết **cuối** một block nhiều tiết được check-out; tiết giữa chỉ nộp nội dung bài dạy qua `/lesson`, và bản thân `/lesson` phụ thuộc tiết cuối đã check-out (cascade) thì mới gọi được — nghĩa là **giáo viên không thể báo giảng ngay khi vừa dạy xong một tiết giữa**, phải đợi hết cả block. Giờ **tiết nào cũng tự check-out trực tiếp được**, để báo giảng đúng lúc vừa dạy xong, không phải chờ.

## 1. Điều gì đổi so với bản trước

| | Bản cũ | Bản mới |
|---|---|---|
| Nút hiện cho tiết giữa (`checkoutRequired=false`) khi chưa xong | "Nộp nội dung bài dạy" thẳng, không GPS | **"Check-out"** (GPS) trước, "Nộp nội dung bài dạy" sau khi check-out xong |
| `POST /:id/checkout` khi gọi ở tiết giữa | 400 `TEACHING_SESSION_CHECKOUT_NOT_REQUIRED` | **200 OK** — tự check-out đúng tiết đó, không đụng tiết khác |
| Check-out tiết cuối có ảnh hưởng tiết khác trong block không | Có — set `checkoutAt` cho cả block | Vẫn có (giữ nguyên), nhưng **bỏ qua** tiết nào đã tự check-out riêng từ trước, và tiết bị "ăn theo" được đánh dấu `checkoutViaAdjacent: true` (field mới, mục 2) |
| `POST /:id/checkout` có nhận `lessonName`/`lessonEvaluation`/`images` không | Tài liệu cũ ghi **có** | **Không bao giờ có** — xem cảnh báo mục 3.1 |

## 2. Field mới: `checkoutViaAdjacent`

```json
{ "id": 1080, "checkoutAt": "2026-08-27T13:11:52.000Z", "checkoutViaAdjacent": true }
```

| Giá trị | Ý nghĩa |
|---|---|
| `false` | Giáo viên **tự bấm Check-out** cho đúng tiết này (kể cả tiết giữa) |
| `true` | Tiết này **chưa từng tự check-out** — `checkoutAt` có được là do tiết **cuối cùng block** vừa check-out và "đóng" hộ |

Không bắt buộc phải hiển thị field này ra UI, nhưng nên dùng để phân biệt khi debug/hỗ trợ ("sao tiết này có check-out mà tôi không nhớ đã bấm?" → vì tiết cuối vừa đóng hộ).

## 3. ⚠️ Sửa lại đúng contract của 2 endpoint — bản cũ ghi sai

### 3.1. `POST /teaching-sessions/:id/checkout` — CHỈ nhận GPS, không nhận nội dung bài dạy

```json
{ "latitude": 10.82513, "longitude": 106.639023, "accuracy": 12 }
```

Backend **không có field** `lessonName`/`lessonEvaluation`/`images` ở endpoint này — DTO chỉ có `latitude`, `longitude`, `accuracy?`. Nếu Mini App đang gửi kèm nội dung bài dạy/ảnh vào request `/checkout` (giống hướng dẫn ở bản `FE-ZALO-MINIAPP-CHECKIN-BLOCK-PROMPT.md` mục 5 cũ), **các field đó bị bỏ qua lặng lẽ, không lỗi** — check-out vẫn trả 200 nhưng nội dung bài dạy **mất trắng, không lưu ở đâu cả**. Đây là lỗi thật đã phát hiện khi sửa app web tương đương (kido-app) — rất có thể Mini App đang mắc lỗi y hệt.

**Cách sửa đúng: gọi 2 API tuần tự**, không gộp làm một:

```
1. POST /teaching-sessions/:id/checkout   { latitude, longitude, accuracy? }
   → 200, trả session đã có checkoutAt

2. POST /teaching-sessions/:id/lesson     { lessonName, lessonEvaluation, actualStudentCount, images[] }
   → 200, trả session đã có lessonSubmittedAt
```

Bước 2 luôn gọi được ngay sau bước 1 thành công, vì lúc này tiết đã có `checkoutAt` của chính nó (không cần đợi cascade).

Nếu bước 1 thành công nhưng bước 2 lỗi (mất mạng, ảnh quá nặng…): **đừng gọi lại bước 1** (sẽ nhận `409 TEACHING_SESSION_ALREADY_CHECKED_OUT`) — giữ nguyên state "đã check-out, chưa nộp bài" và cho bấm lại nút "Nộp nội dung bài dạy" (chỉ gọi bước 2).

### 3.2. `POST /teaching-sessions/:id/lesson` — điều kiện là "đã check-out", không phải "đã check-in"

Bản cũ ghi endpoint này lỗi `400 TEACHING_SESSION_NOT_CHECKED_IN` khi block chưa ai check-in. Thực tế điều kiện chặn của `/lesson` là **`checkoutAt` của chính tiết đó phải có giá trị**:

```
400 { code: "TEACHING_SESSION_NOT_ATTENDED", message: "Tiết dạy chưa hoàn tất chấm công" }
```

Vì giờ mỗi tiết tự check-out được (mục 1), thứ tự luôn là: check-in (nếu là tiết đầu) → **check-out chính tiết đó** → `/lesson` cho chính tiết đó. Không còn cách nào gọi `/lesson` mà bỏ qua bước check-out của tiết đó nữa.

`SubmitLessonDto` cũng có 1 field **bắt buộc** mà bản cũ không nhắc tới:

| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `lessonName` | ✅ | tối đa 255 ký tự |
| `lessonEvaluation` | ✅ | tối đa 2000 ký tự |
| `actualStudentCount` | ✅ | số nguyên ≥ 0 — **thiếu field này thì 400**, kể cả khi Mini App coi đây là optional trước giờ |
| `images` | ✅ | tối thiểu **1 file** — thiếu thì `400 TEACHING_SESSION_LESSON_EVIDENCE_REQUIRED` (khác hẳn "optional" mà một số chỗ có thể đang hiểu nhầm) |

## 4. Logic chọn nút — thay hẳn công thức cũ

Bỏ hoàn toàn cách chọn nút dựa vào `checkinRequired`/`checkoutRequired` của bản cũ (mục 2 file cũ). Công thức mới, áp dụng cho MỌI tiết (kể cả buổi lẻ):

```
checkinRequired && !checkinAt   → "Check-in"
!checkoutAt                     → "Check-out"   (bất kể checkinRequired/checkoutRequired)
checkoutAt && !lessonSubmittedAt → "Nộp nội dung bài dạy"
checkoutAt && lessonSubmittedAt  → "Đã xong" (ẩn hết nút)
```

`checkinRequired`/`checkoutRequired` vẫn tồn tại và vẫn đúng ý nghĩa cũ (tiết đầu/cuối block), nhưng giờ chỉ còn dùng để:
- quyết định có bắt tự check-in không (`checkinRequired`),
- và (tuỳ chọn) hiện gợi ý "tiết cuối, check-out xong sẽ đóng cả block" khi `checkoutRequired=true` — không bắt buộc phải hiện, chỉ là UX tốt hơn.

**Không** còn nhánh nào bỏ qua "Check-out" để nhảy thẳng sang "Nộp nội dung bài dạy" nữa — mọi tiết đều phải tự check-out (của chính nó) trước khi nộp bài, kể cả tiết giữa.

## 5. Gợi ý UI

- Nút "Check-out" cho tiết giữa dùng cùng UI/label với tiết cuối — không cần phân biệt bằng chữ, chỉ khác ở chỗ tiết cuối còn "đóng hộ" các tiết chưa check-out khác trong block (âm thầm, không cần thông báo gì thêm cho giáo viên).
- Sau khi check-out xong (bước 1 ở mục 3.1), **tự động mở luôn** form nộp nội dung bài dạy (bước 2) trong cùng một thao tác của giáo viên — đừng bắt họ bấm thêm một nút riêng, trải nghiệm nên liền mạch như trước (check-out & nộp bài trong 1 lần chạm), chỉ khác là giờ chạy ngầm thành 2 API call thay vì 1.
- Tiết đã `checkoutAt` nhưng chưa `lessonSubmittedAt` (ví dụ do bước 2 từng lỗi) → khi mở lại app vẫn phải hiện nút "Nộp nội dung bài dạy" cho tiết đó, không được coi là "đã xong".

## 6. Nghiệm thu

Tài khoản thử: `0900000018` / `123456` (Giáo viên K, teacherId=41). Trường thử: `schoolId=529` "Trường TEST".

- [ ] Tạo 3 tiết liên tiếp cùng trường hôm nay. Check-in tiết 1.
- [ ] Bấm Check-out tiết 2 (tiết **giữa**) trực tiếp, không cần tiết 1/3 đã xong gì thêm → `200`, `checkoutViaAdjacent: false`.
- [ ] Nộp nội dung bài dạy cho tiết 2 ngay sau đó → `200`, `lessonSubmittedAt` có giá trị — **không cần đợi tiết 3**.
- [ ] Check-out tiết 3 (tiết cuối) → `200`. Gọi lại `GET /teaching-sessions/me`: tiết 1 giờ có `checkoutAt` (mới xuất hiện) và `checkoutViaAdjacent: true`; tiết 2 vẫn giữ nguyên `checkoutViaAdjacent: false` (không bị đè); tiết 3 `checkoutViaAdjacent: false`.
- [ ] Gọi `/checkout` gửi kèm `lessonName` trong body → xác nhận response **không có** field đó được lưu ở đâu cả (đúng như cảnh báo mục 3.1) — nếu Mini App đang làm vậy thì đây là bug cần sửa theo mục 3.1.
- [ ] Gọi `/lesson` cho tiết chưa check-out → `400 TEACHING_SESSION_NOT_ATTENDED` (không phải `NOT_CHECKED_IN` như tài liệu cũ).
- [ ] Gọi `/lesson` thiếu `actualStudentCount` → `400` — xác nhận form Mini App đang có ô này và gửi lên.

## 7. Kiểm chứng phía backend

Đã chạy thật qua HTTP + kiểm tra DB trên môi trường dev, không phải suy đoán (3 tiết liên tiếp cùng `schoolId=529`, teacherId=41, id 1080/1081/1082):

```
Check-in tiết 1 (1080)                          → 200, checkinAt có giá trị

Check-out tiết 2 (1081) — TIẾT GIỮA, trực tiếp  → 200
  checkoutViaAdjacent: false

POST /teaching-sessions/1081/lesson              → 200
  lessonSubmittedAt có giá trị — NGAY SAU khi check-out tiết 2,
  không cần chờ tiết 3

Check-out tiết 3 (1082) — TIẾT CUỐI              → 200

SELECT id, checkin_at IS NOT NULL, checkout_at IS NOT NULL,
       checkout_via_adjacent, lesson_submitted_at IS NOT NULL
FROM teaching_sessions WHERE id IN (1080,1081,1082):

  id   | checked_in | checked_out | checkout_via_adjacent | lesson_submitted
  1080 | true       | true        | true                  | false   ← đóng hộ bởi tiết 1082
  1081 | false      | true        | false                 | true    ← tự check-out + tự báo giảng
  1082 | false      | true        | false                 | false   ← tự check-out (tiết cuối)
```

638 unit test của backend đang pass, gồm cả case tiết cuối không đè lên tiết đã tự check-out riêng, và case check-out tiết giữa/cuối khi block chưa ai check-in đều bị chặn đúng (`TEACHING_SESSION_NOT_CHECKED_IN`).
