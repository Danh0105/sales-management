# PROMPT: ZALO MINI APP — GIÁO VIÊN XÁC NHẬN/TỪ CHỐI LỊCH DẠY

Bạn là Senior Frontend Developer làm Zalo Mini App cho giáo viên. Backend đã hoàn thiện luồng: Giáo vụ/Nhân sự xếp lịch → giáo viên phải xác nhận hoặc từ chối → xác nhận xong thì buổi dạy tự động được sinh. Mini App hiện **chưa có UI nào cho luồng này** — đây là tính năng mới hoàn toàn, không phải cập nhật.

## 0. Vì sao

Trước đây Giáo vụ/Nhân sự xếp lịch xong là coi như xong — giáo viên không có bước xác nhận, nhiều trường hợp giáo viên không biết mình có lịch mới cho tới sát giờ dạy. Giờ:

1. Xếp lịch xong → giáo viên nhận thông báo ngay, phải bấm **Xác nhận** hoặc **Từ chối**.
2. Xác nhận xong → hệ thống **tự động sinh buổi dạy** cho cả thời hạn của lịch, Giáo vụ/Nhân sự không phải vào sinh tay.
3. Còn dưới 1 ngày mà giáo viên chưa phản hồi → cả giáo viên lẫn Giáo vụ/Nhân sự đều nhận cảnh báo.
4. Từ chối → chỉ ghi nhận + báo Giáo vụ/Nhân sự, không tự huỷ gì — họ sẽ chủ động xếp lại.

## 1. Hai loại đối tượng cần xác nhận

- **Mẫu lịch lặp** (`TeachingSchedule`) — lịch cố định theo tuần, ví dụ "Thứ Ba, 13:00–13:45, từ 25/08 đến 08/09". Đây là trường hợp phổ biến nhất.
- **Buổi lẻ** (`TeachingSession`) — khi Giáo vụ/Nhân sự gán trực tiếp một buổi cụ thể (không qua mẫu lặp), ví dụ buổi mở đăng ký được chọn giáo viên. API tương tự, endpoint khác.

## 2. Xác nhận/từ chối mẫu lịch lặp

### `PATCH /teaching-schedules/:id/confirmation`

**Headers:** `Authorization: Bearer <token>` (role `giaovien`, phải đúng giáo viên đứng tên lịch)

```json
{
  "status": "CONFIRMED",
  "reason": null
}
```

| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `status` | ✅ | `"CONFIRMED"` hoặc `"REJECTED"` — chỉ 2 giá trị này |
| `reason` | Khi `status = "REJECTED"` | string, tối đa 1000 ký tự — thiếu thì 400 |

Response: object lịch đầy đủ, có thêm 3 field:

```json
{
  "id": 107,
  "confirmationStatus": "CONFIRMED",
  "confirmedAt": "2026-08-25T06:25:22.621Z",
  "rejectionReason": null
}
```

### Lỗi

| Status | Khi nào |
|---|---|
| `403` | Không phải giáo viên đứng tên lịch này |
| `409` | Lịch đã được xử lý (đã CONFIRMED hoặc REJECTED trước đó) — không xác nhận lại được |
| `400` | `REJECTED` mà thiếu `reason` |

## 3. Xác nhận/từ chối buổi lẻ

### `PATCH /teaching-sessions/:id/confirmation`

Cùng contract hệt mục 2 (`{status, reason?}`, cùng mã lỗi 403/409/400), chỉ khác đối tượng là 1 buổi cụ thể thay vì cả mẫu lịch. Dùng khi Giáo vụ/Nhân sự gán trực tiếp 1 buổi cho giáo viên (không qua mẫu lặp).

## 4. Mọi buổi dạy giờ có thêm 3 field xác nhận

`GET /teaching-sessions/me`, `GET /teaching-sessions/:id` trả kèm:

```ts
confirmationStatus: 'PENDING' | 'CONFIRMED' | 'REJECTED';
confirmedAt: string | null;
rejectionReason: string | null;
```

Lịch/buổi cũ (tạo trước khi có tính năng này) đều đã được backfill `CONFIRMED` — chỉ lịch/buổi mới tạo từ giờ mới ở trạng thái `PENDING` chờ giáo viên xử lý.

## 5. ⚠️ Xác nhận xong thì buổi dạy tự sinh — không cần Mini App làm gì thêm

Đây là hành vi **tự động phía backend**, không có API nào để Mini App gọi:

- Khi giáo viên bấm **Xác nhận** ở mục 2, backend tự sinh toàn bộ buổi dạy cho cả thời hạn `effectiveFrom → effectiveTo` của mẫu lịch (nếu để trống hoặc quá xa thì backend tự cắt ở mốc an toàn, không cần Mini App quan tâm).
- Ngay sau khi gọi `PATCH .../confirmation` thành công, **refetch `GET /teaching-sessions/me`** cho khoảng ngày liên quan — các buổi mới sẽ xuất hiện với `confirmationStatus: "CONFIRMED"` sẵn (giáo viên không phải xác nhận lại từng buổi).
- Nếu bấm **Từ chối** thì không có buổi nào được sinh — response trả về ngay, không cần refetch danh sách buổi.

Đã kiểm chứng thật qua HTTP: tạo mẫu lịch Thứ Ba 25/08→08/09, gọi confirm CONFIRMED → `GET /teaching-sessions/me` trả về ngay 3 buổi (25/08, 01/09, 08/09) đều có `confirmationStatus: "CONFIRMED"`, `confirmedAt` trùng thời điểm xác nhận mẫu lịch.

## 6. Ba loại thông báo cần xử lý

Không lọc bỏ 3 type mới này khỏi danh sách/badge thông báo hiện có:

### `TEACHING_SCHEDULE_CONFIRM_REQUEST` — gửi cho giáo viên khi có lịch/buổi mới

Bắn ngay lúc Giáo vụ/Nhân sự xếp lịch (tạo mới, gán buổi lẻ, hoặc đổi sang giáo viên khác).

```json
{
  "type": "TEACHING_SCHEDULE_CONFIRM_REQUEST",
  "message": "Bạn được xếp lịch dạy Thứ Ba 13:00–13:45, bắt đầu từ 2026-08-25. Vui lòng xác nhận hoặc từ chối.",
  "meta": { "kind": "TEACHING_SCHEDULE_CONFIRM_REQUEST", "entityType": "schedule", "scheduleId": 107 }
}
```

`entityType` là `"schedule"` hoặc `"session"` — dùng để biết gọi API xác nhận ở mục 2 hay mục 3, và `scheduleId`/`sessionId` tương ứng nằm trong `meta`. Bấm thông báo → mở màn xác nhận lịch, chưa cần chi tiết hơn nếu Mini App chưa có màn riêng — mở màn "Lịch của tôi" hiện có là đủ.

### `TEACHING_SCHEDULE_CONFIRM_RESULT` — kết quả sau khi giáo viên xác nhận/từ chối

Gửi cho **cả Giáo vụ, Nhân sự lẫn chính giáo viên** (echo lại hành động của mình) — 3 bên đều nhận, không chỉ 1 bên.

```json
{
  "type": "TEACHING_SCHEDULE_CONFIRM_RESULT",
  "message": "Bạn đã xác nhận lịch dạy thành công.",
  "meta": { "kind": "TEACHING_SCHEDULE_CONFIRM_RESULT", "entityType": "schedule", "scheduleId": 107, "status": "CONFIRMED" }
}
```

Với người nhận là Giáo vụ/Nhân sự, `message` khác đi (nêu tên giáo viên): `"Giáo viên A (test) đã xác nhận lịch dạy Thứ Ba 13:00–13:45."`. Nếu từ chối, `meta.reason` chứa lý do.

### `TEACHING_SCHEDULE_CONFIRM_ALERT` — còn dưới 1 ngày mà chưa phản hồi

Cron quét mỗi 30 phút; buổi dạy gần nhất trong mẫu/buổi còn `PENDING` mà sắp tới trong 24h sẽ bắn cảnh báo cho **cả giáo viên lẫn Giáo vụ/Nhân sự**, nội dung khác nhau theo người nhận:

- Giáo viên: `"Buổi dạy ngày ... lúc ... sắp tới nhưng bạn chưa xác nhận. Vui lòng xác nhận hoặc từ chối sớm."`
- Giáo vụ/Nhân sự: `"Còn buổi dạy ngày ... lúc ... mà giáo viên chưa xác nhận nhận lịch."`

```json
{ "type": "TEACHING_SCHEDULE_CONFIRM_ALERT", "meta": { "kind": "TEACHING_SCHEDULE_CONFIRM_ALERT", "sessionId": 953 } }
```

Chỉ bắn 1 lần cho mỗi buổi (có chống gửi trùng phía backend) — Mini App không cần tự chặn lặp, nhưng nên hiển thị nổi bật (badge/màu cảnh báo) vì đây là cảnh báo khẩn.

## 7. Gợi ý UI

- Màn "Lịch của tôi": lịch/buổi có `confirmationStatus: "PENDING"` cần nổi bật (badge màu vàng/cam) + 2 nút **Xác nhận** / **Từ chối** ngay trên item, không cần vào chi tiết mới thao tác được.
- Bấm **Từ chối** → mở ô nhập lý do (bắt buộc, tối thiểu vài ký tự cho có ý nghĩa dù backend chỉ chặn rỗng) → gửi kèm `reason`.
- Sau khi xác nhận/từ chối thành công → cập nhật item tại chỗ theo response, và nếu là xác nhận mẫu lịch thì **refetch thêm danh sách buổi dạy** (mục 5) vì có buổi mới xuất hiện.
- Lịch/buổi `confirmationStatus: "CONFIRMED"` hoặc `"REJECTED"` thì ẩn 2 nút, hiện badge trạng thái tương ứng; `"REJECTED"` hiện kèm `rejectionReason`.
- Trung tâm thông báo: 3 type ở mục 6 nên có icon/màu riêng dễ phân biệt — REQUEST (cần hành động), RESULT (thông tin), ALERT (khẩn, còn dưới 1 ngày).

## 8. Nghiệm thu

Tài khoản thử: `0900000008` / `123456` (Giáo viên A, teacherId=1). Tài khoản Nhân sự thử: `0900000007` / `123456` (dùng để tạo lịch test qua Postman/API trực tiếp nếu cần dựng dữ liệu).

- [ ] Tạo 1 mẫu lịch mới cho giáo viên test → giáo viên nhận `TEACHING_SCHEDULE_CONFIRM_REQUEST`, `GET /teaching-sessions/me` cho khoảng ngày đó **chưa** có buổi nào.
- [ ] Bấm **Xác nhận** → gọi đúng `PATCH /teaching-schedules/:id/confirmation` với `{status:"CONFIRMED"}` → response `confirmationStatus:"CONFIRMED"`.
- [ ] Refetch `GET /teaching-sessions/me` → các buổi trong thời hạn mẫu lịch đã xuất hiện, đều `confirmationStatus:"CONFIRMED"`.
- [ ] Giáo vụ/Nhân sự và chính giáo viên đều nhận `TEACHING_SCHEDULE_CONFIRM_RESULT`.
- [ ] Tạo mẫu lịch khác, bấm **Từ chối** không nhập lý do → 400, form báo lỗi tại chỗ, không tự thoát màn.
- [ ] Từ chối kèm lý do → thành công, `GET` lại lịch thấy `confirmationStatus:"REJECTED"`, `rejectionReason` đúng nội dung đã nhập, **không** có buổi nào được sinh.
- [ ] Bấm xác nhận/từ chối lần 2 trên lịch đã xử lý → 409, hiện thông báo "đã được xử lý", không phải lỗi kỹ thuật thô.
- [ ] Tạo lịch có buổi đầu tiên rơi trong vòng 24h tới, để `PENDING` không xử lý → sau tối đa 30 phút nhận `TEACHING_SCHEDULE_CONFIRM_ALERT`.

## 9. Kiểm chứng phía backend

Đã chạy thật qua HTTP + kiểm tra DB (không phải suy đoán):

```
Tạo mẫu lịch #107: Thứ Ba 13:00–13:45, hiệu lực 2026-08-25 → 2026-09-08
  → confirmationStatus: PENDING
  → giáo viên (employeeId 141) nhận TEACHING_SCHEDULE_CONFIRM_REQUEST

GET /teaching-sessions/me (25/08–08/09) → 0 buổi thuộc mẫu #107

PATCH /teaching-schedules/107/confirmation {status:"CONFIRMED"}
  → 200, confirmationStatus: CONFIRMED, confirmedAt: 2026-08-25T06:25:22.621Z

GET /teaching-sessions/me (25/08–08/09) → 3 buổi xuất hiện NGAY (25/08, 01/09, 08/09)
  mỗi buổi: confirmationStatus: CONFIRMED, confirmedAt trùng thời điểm confirm mẫu lịch

Notification tạo ra (bảng notification):
  receiverId 141 (giáo viên)  — TEACHING_SCHEDULE_CONFIRM_REQUEST — lúc tạo lịch
  receiverId 141 (giáo viên)  — TEACHING_SCHEDULE_CONFIRM_RESULT  — "Bạn đã xác nhận lịch dạy thành công."
  receiverId 140 (nhân sự)    — TEACHING_SCHEDULE_CONFIRM_RESULT  — "Giáo viên A (test) đã xác nhận lịch dạy..."
  receiverId 149 (giáo vụ)    — TEACHING_SCHEDULE_CONFIRM_RESULT  — "Giáo viên A (test) đã xác nhận lịch dạy..."
```

595 unit test của backend đang pass, gồm cả các case: từ chối không sinh buổi, `effectiveTo` bỏ trống/quá xa vẫn không lỗi, và lỗi sinh buổi không làm hỏng thao tác xác nhận của giáo viên.
