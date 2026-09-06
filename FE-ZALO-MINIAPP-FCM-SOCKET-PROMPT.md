# PROMPT: ZALO MINI APP — THÔNG BÁO FCM (nền/đóng) + SOCKET.IO (đang mở)

Bạn là Senior Frontend Developer làm Zalo Mini App cho giáo viên. Đây là tài liệu **tổng hợp** cách nhận mọi thông báo liên quan tới giảng dạy — 2 kênh song song, không kênh nào thay được kênh kia:

| Kênh | Dùng khi | Cơ chế |
|---|---|---|
| **FCM push** | App đã đóng, hoặc đang chạy nền | Backend gửi qua Firebase Cloud Messaging tới token đã đăng ký |
| **Socket.IO** | App đang mở (foreground) | Backend bắn realtime qua `NotificationGateway`, cùng hạ tầng kido-app (web) đang dùng |

Cả hai đều xuất phát từ cùng một hành động nghiệp vụ (ví dụ: Nhân sự xếp lịch) — backend gửi **cả hai** mỗi lần, không phải chọn một. Mini App nên: nếu socket đang kết nối và nhận được sự kiện → không cần đợi push; nếu app đóng/nền → dựa vào push.

> Phần `/auth/login` cần `zaloId` đã có prompt riêng: `FE-ZALO-MINIAPP-LOGIN-PROMPT.md`. Không nhắc lại ở đây, chỉ tham chiếu.

---

## 1. FCM — đăng ký & huỷ token thiết bị

### 1.1 Đăng ký (đã có, xác nhận lại cho đủ)

```http
POST /employee-fcm-token/save
Authorization: Bearer <token>
Content-Type: application/json

{ "token": "<FCM registration token>", "platform": "android" | "ios" | "web" }
```

Gọi **mỗi lần đăng nhập thành công** và **mỗi khi Firebase cấp lại token mới** (`onTokenRefresh`), không chỉ lần đầu cài app. Backend lưu theo `(employeeId, token)` — nhiều thiết bị của cùng giáo viên **không giẫm lên nhau**, mỗi thiết bị một dòng riêng, tất cả đều nhận được push khi có thông báo (đã kiểm chứng qua unit test multi-device, xem `EmployeeFcmTokenService`).

### 1.2 ⚠️ Huỷ token lúc đăng xuất — endpoint MỚI, trước đây chưa có

```http
DELETE /employee-fcm-token
Authorization: Bearer <token>
Content-Type: application/json

{ "token": "<FCM registration token của chính thiết bị này>" }
```

Đã kiểm chứng thật: `POST .../save` xong `DELETE` cùng token → `{"removed": true}`, HTTP 200.

**Bắt buộc gọi endpoint này trong luồng đăng xuất**, trước khi xoá JWT khỏi bộ nhớ máy. Không gọi thì thiết bị vẫn nằm trong danh sách nhận push của tài khoản cũ — nếu máy đó sau này đăng nhập bằng tài khoản khác, dòng cũ sẽ **tự động đổi chủ** sang tài khoản mới khi họ `save` token cùng giá trị (hành vi backend đã thiết kế vậy để xử lý máy dùng chung/cài lại app), nhưng trong lúc chưa ai đăng nhập lại, tài khoản cũ vẫn nhận nhầm push của thiết bị đã không còn dùng.

Chỉ xoá đúng token của thiết bị đang đăng xuất — **không** có cách xoá "tất cả token của tôi" qua endpoint này (thiết kế cố ý, để không lỡ tay xoá nhầm token của thiết bị khác đang đăng nhập cùng tài khoản).

---

## 2. Socket.IO — kết nối

```ts
import { io } from "socket.io-client";

const socket = io(SOCKET_BASE_URL, {
  transports: ["websocket"], // nên thêm "polling" dự phòng nếu mạng chặn WS
  query: { employeeId: String(currentEmployeeId) },
});
```

- **Namespace mặc định (`/`)** — không cần path riêng.
- **Không có xác thực JWT ở bước bắt tay** — backend nhận diện thuần bằng `employeeId` trong `query` (chấp nhận cả `query.userId`/`auth.employeeId`/`auth.userId` làm dự phòng, nhưng dùng đúng `query.employeeId` cho đơn giản và nhất quán với kido-app). Kết nối xong, server tự `client.join('user_' + employeeId)` — **không cần emit thêm gì để "đăng ký"**, cứ kết nối đúng `employeeId` là vào đúng phòng nhận thông báo.
- Vì không xác thực bằng token, **ai gửi đúng `employeeId` số của người khác cũng join được phòng của họ** — hạn chế đã biết phía backend, không phải lỗi khi tích hợp. Không cần Mini App xử lý gì thêm, chỉ để biết đây không phải kênh bảo mật tuyệt đối.
- Khi đăng xuất, nhớ `socket.disconnect()` trước khi đăng nhập tài khoản khác trong cùng phiên app (tránh giữ kết nối cũ join nhầm phòng của tài khoản trước).

---

## 3. Danh sách sự kiện giáo viên cần lắng nghe

Payload mọi event = **nguyên bản ghi `Notification`** (`id`, `receiverId`, `senderId`, `type`, `entityId`, `message`, `meta`, `isRead`, `createdAt`).

| Event | `type` | Khi nào | Có gửi FCM song song? |
|---|---|---|---|
| `teaching-schedule-notification:new` | `TEACHING_SCHEDULE` | Nhân sự/Giáo vụ gửi lịch dạy hàng loạt (`notify-schedule`) | ✅ |
| `teaching-schedule-confirm-request:new` | `TEACHING_SCHEDULE_CONFIRM_REQUEST` | Có mẫu lịch/buổi mới cần xác nhận | ✅ |
| `teaching-schedule-confirm-result:new` | `TEACHING_SCHEDULE_CONFIRM_RESULT` | Echo lại sau khi **chính giáo viên** bấm Đồng ý/Từ chối | ✅ |
| `teaching-schedule-confirm-alert:new` | `TEACHING_SCHEDULE_CONFIRM_ALERT` | Còn dưới 1 ngày mà giáo viên chưa phản hồi lịch | ✅ |
| `teaching-lesson-report-alert:new` | `TEACHING_LESSON_REPORT_ALERT` | 19:00, giáo viên đã chấm công nhưng chưa báo giảng | ✅ |

**`teaching-checkin-alert:new` (`TEACHING_CHECKIN_ALERT`) không nằm trong danh sách này** — báo động "chưa check-in" chỉ gửi cho Giáo vụ/Nhân sự, giáo viên không bao giờ nhận loại này. Đừng tốn công lắng nghe.

### Payload mẫu — đã kiểm chứng thật (không suy đoán)

```jsonc
// teaching-schedule-confirm-request:new
{
  "type": "TEACHING_SCHEDULE_CONFIRM_REQUEST",
  "message": "Bạn được xếp lịch dạy Thứ Sáu 15:00–15:45, bắt đầu từ 2026-08-28. Vui lòng xác nhận hoặc từ chối.",
  "meta": { "kind": "TEACHING_SCHEDULE_CONFIRM_REQUEST", "entityType": "schedule", "scheduleId": 110 }
}

// teaching-schedule-confirm-result:new (gửi về chính giáo viên vừa thao tác)
{
  "type": "TEACHING_SCHEDULE_CONFIRM_RESULT",
  "message": "Bạn đã từ chối lịch dạy này.",
  "meta": { "kind": "TEACHING_SCHEDULE_CONFIRM_RESULT", "entityType": "schedule", "scheduleId": 110, "status": "REJECTED" }
}

// teaching-schedule-confirm-alert:new
{
  "type": "TEACHING_SCHEDULE_CONFIRM_ALERT",
  "message": "Buổi dạy ngày 27/08 lúc 08:00 sắp tới nhưng bạn chưa xác nhận. Vui lòng xác nhận hoặc từ chối sớm.",
  "meta": { "kind": "TEACHING_SCHEDULE_CONFIRM_ALERT", "sessionId": 982 }
}

// teaching-lesson-report-alert:new (bản cá nhân của giáo viên — khác bản gộp gửi Giáo vụ/Nhân sự)
{
  "type": "TEACHING_LESSON_REPORT_ALERT",
  "message": "Bạn còn 2 tiết chưa báo giảng. Hạn hoàn thành trước 08:00 sáng mai.",
  "meta": { "kind": "lesson_report_missing", "module": "teaching", "route": "teaching-sessions", "url": "/teacher/teaching-sessions", "date": "2026-08-26", "sessionIds": [953, 954] }
}
```

`entityType` (khi có) là `"schedule"` hoặc `"session"` — quyết định gọi API xác nhận nào (`PATCH /teaching-schedules/:id/confirmation` hay `PATCH /teaching-sessions/:id/confirmation`, xem `FE-ZALO-MINIAPP-SCHEDULE-CONFIRM-PROMPT.md`).

`meta.route`/`meta.url` — dùng để điều hướng khi người dùng bấm vào thông báo (từ push hoặc từ danh sách trong app), luôn ưu tiên field này thay vì tự đoán màn hình.

---

## 4. Xử lý khi nhận

- **Socket đang mở** → cập nhật badge/danh sách thông báo trong app ngay, có thể toast nhẹ cho `CONFIRM_REQUEST`/`CONFIRM_ALERT` (cần hành động), không nhất thiết toast cho `CONFIRM_RESULT`/`LESSON_REPORT_ALERT` (chỉ mang tính thông tin).
- **Dedupe theo `id`** nếu cùng lúc nhận cả socket lẫn push foreground — tránh hiện 2 lần cho cùng một thông báo.
- **Push khi app đóng/nền**: bấm vào push → mở app, điều hướng theo `data.route`/`data.url` (Firebase truyền `data` payload, không phải `notification` payload, khi app ở nền — kiểm tra đúng cách đọc theo SDK push đang dùng).
- Không có endpoint liệt kê thông báo riêng cho 4 type mới — dùng chung `GET /notifications?type=<TYPE>` (đã hỗ trợ sẵn mọi giá trị `NotificationType`, không cần BE mở thêm route).

---

## 5. Nghiệm thu

Tài khoản thử: `0900000008` / `123456` (Giáo viên A, employeeId 141).

- [ ] Đăng nhập → gọi `POST /employee-fcm-token/save` với token thiết bị hiện tại.
- [ ] Đăng xuất → gọi `DELETE /employee-fcm-token` với đúng token đó **trước khi** xoá JWT; đăng nhập lại → token được đăng ký lại từ đầu.
- [ ] Mở app (foreground), kết nối socket với đúng `employeeId` → Nhân sự/Giáo vụ tạo lịch mới cho giáo viên này → nhận `teaching-schedule-confirm-request:new` ngay, không cần F5/mở lại app.
- [ ] Đóng hẳn app → lặp lại thao tác trên → nhận push FCM, bấm vào mở đúng màn theo `route`.
- [ ] Giáo viên tự bấm Đồng ý/Từ chối trong app → nhận lại `teaching-schedule-confirm-result:new` qua socket (vì app đang mở lúc gọi API).
- [ ] Không nhận được bất kỳ `teaching-checkin-alert:new` nào dù Giáo vụ/Nhân sự đang nhận đều — xác nhận đúng thiết kế (không phải bug thiếu lắng nghe).
- [ ] Ngắt mạng, có 2 thông báo phát sinh phía backend trong lúc mất mạng, bật mạng lại → socket reconnect, không yêu cầu tự đồng bộ lại (biết trước: backend không có cơ chế "gửi lại tin nhắn đã lỡ" qua socket — nếu cần đảm bảo không mất, phải tự gọi `GET /notifications/unread-count` lúc `socket.on("connect")`).

---

## 6. Kiểm chứng phía backend

Đã chạy thật qua HTTP, không suy đoán:

```
POST /employee-fcm-token/save {token:"mini-app-test-token-verify", platform:"zalo-miniapp"}
  → 201 { employeeId: 141, token: "...", platform: "zalo-miniapp", id: 106, ... }

DELETE /employee-fcm-token {token:"mini-app-test-token-verify"}
  → 200 { removed: true }
```

Danh sách event/type ở mục 3 đối chiếu trực tiếp với `NotificationService.getEventByType()` trong source — không có event nào suy đoán. Payload mẫu của 3/4 event lấy từ dữ liệu thật đã tạo ra trong quá trình test các tính năng liên quan (xem `FE-ZALO-MINIAPP-SCHEDULE-CONFIRM-PROMPT.md` mục 9). 604 unit test của backend đang pass.
