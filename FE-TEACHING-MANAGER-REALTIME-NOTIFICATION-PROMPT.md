# PROMPT: THÔNG BÁO REALTIME CHO GIÁO VỤ/NHÂN SỰ — XÁC NHẬN LỊCH & BÁO GIẢNG

Bạn là Frontend Developer của **kido-app** (`/var/www/kido-app` — web, không phải Zalo Mini App). Backend đã có 3 loại thông báo mới liên quan tới module giảng dạy, nhắm tới Giáo vụ/Nhân sự, nhưng **chưa được nối vào tầng realtime hiện có**. Việc cần làm: nối 3 event socket mới vào đúng pipeline đang chạy cho `POLICY`/`REPORT` — không xây cơ chế mới.

> Đã có một prompt riêng mô tả việc viết lại toàn bộ tầng socket (`FE-REALTIME-NOTIFICATION-PROMPT.md`) — **không nhắc lại phạm vi đó ở đây**. Nếu prompt kia đã làm xong, áp dụng các bước dưới vào kiến trúc mới của nó. Nếu chưa làm, áp dụng vào kiến trúc hiện tại (mô tả ở mục 1) — đừng trộn hai việc vào một PR.

## 0. 3 loại thông báo mới, ai nhận

| `NotificationType` | Event socket | Ai nhận | Khi nào |
|---|---|---|---|
| `TEACHING_SCHEDULE_CONFIRM_RESULT` | `teaching-schedule-confirm-result:new` | **Giáo vụ + Nhân sự** (mọi tài khoản có role `giaovu`/`nhansu`) + chính giáo viên | Giáo viên vừa bấm Đồng ý/Từ chối một lịch/buổi được giao |
| `TEACHING_SCHEDULE_CONFIRM_ALERT` | `teaching-schedule-confirm-alert:new` | **Giáo vụ + Nhân sự** + giáo viên liên quan | Còn dưới 1 ngày mà giáo viên chưa phản hồi lịch được giao |
| `TEACHING_LESSON_REPORT_ALERT` | `teaching-lesson-report-alert:new` | **Giáo vụ + Nhân sự** (thông báo tổng hợp) — *và riêng* giáo viên (thông báo cá nhân) | 19:00 mỗi ngày, giáo viên đã chấm công nhưng chưa báo giảng |

Cả 3 type đều **đã tồn tại từ trước** trên FE cho vài luồng khác (không phải type mới hoàn toàn với hệ thống) — chỉ riêng 2 type đầu và việc gửi `TEACHING_LESSON_REPORT_ALERT` cho quản lý là **mới, chưa ai lắng nghe ở FE**. Đã kiểm tra bằng grep: không route socket nào trong 3 cái này xuất hiện trong `src/` hiện tại.

Payload = nguyên bản ghi `Notification` (giống mọi type khác, xem `FE-REALTIME-NOTIFICATION-PROMPT.md` mục 1.2):

```jsonc
{
  "id": 13751,
  "receiverId": 140,
  "senderId": null,
  "type": "TEACHING_SCHEDULE_CONFIRM_RESULT",
  "entityId": 110,
  "message": "Giáo viên C (test) đã từ chối lịch dạy Thứ Sáu 15:00–15:45. Lý do: Trùng lịch dạy trường khác",
  "meta": { "kind": "TEACHING_SCHEDULE_CONFIRM_RESULT", "entityType": "schedule", "scheduleId": 110, "status": "REJECTED", "reason": "..." },
  "isRead": false,
  "createdAt": "2026-08-26T06:25:22.000Z"
}
```

`TEACHING_LESSON_REPORT_ALERT` bản gửi cho quản lý có `meta` khác (không có `entityType`/id buổi cụ thể — đây là bản tổng hợp nhiều giáo viên):

```jsonc
{
  "type": "TEACHING_LESSON_REPORT_ALERT",
  "message": "2 giáo viên còn tiết chưa báo giảng hôm nay (hạn 08:00 sáng mai):\n• Cô An (2 tiết)\n• Thầy Bình (1 tiết)",
  "meta": { "kind": "lesson_report_missing", "module": "teaching", "route": "/nhan-su/cham-cong", "url": "/#/nhan-su/cham-cong", "date": "2026-08-26", "teacherCount": 2 }
}
```

Khi chỉ 1 giáo viên thiếu, `message` ngắn gọn hơn: `"Cô An còn 1 tiết chưa báo giảng hôm nay. Hạn 08:00 sáng mai."` — không có ký tự xuống dòng, không cần parse danh sách, hiển thị nguyên `message` là đủ trong mọi trường hợp.

## 1. Hiện trạng (đọc trước khi sửa)

- Bell + badge (`AppHeader`, `src/layout/Header.tsx`) và dropdown (`NotificationDropdown`, `src/components/PortalDropdown.tsx`) chỉ được mount ở **2 nơi**: `src/pages/Employee/Home.tsx` và `src/pages/Director/Home.tsx`. Giáo vụ/Nhân sự đăng nhập được điều hướng vào `/director` → dùng `Director/Home.tsx`.
- **Các màn hình module giảng dạy (`/nhan-su/*`, `TeachingLayout`) không có bell** — `TeachingLayout` chỉ render `HeaderWithBack` (nút back đơn giản). Nghĩa là Giáo vụ/Nhân sự đứng trong màn Chấm công/Lịch dạy sẽ **không thấy gì** dù badge ở Home có tăng.
- `type NotificationType` là **literal type khai trùng lặp y hệt 3 nơi** (không import chung): `Employee/Home.tsx:59`, `Director/Home.tsx:161`, `PortalDropdown.tsx:30` — hiện là `"POLICY" | "SUGGEST" | "REPORT" | "WEEKLY_PLAN"`. Phải sửa cả 3 chỗ, thiếu 1 chỗ là type lỗi hoặc rơi vào nhánh mặc định.
- `handleNew` (`Director/Home.tsx:367-399`, `Employee/Home.tsx:267-294`) tăng `notificationStats[data.type].unread` qua một map `statsKeyOf(type)` — type không nằm trong map thì **bị bỏ qua âm thầm**, badge không tăng dù thông báo vẫn vào list.
- Tiền lệ **giống hệt việc bạn cần làm**: `teaching-checkin-alert:new` đã được nối theo kiểu global toast (không qua bell) tại `src/components/CheckinAlertWatcher.tsx` — mount 1 lần ở `src/routes/index.tsx:21`, tự lọc quyền bằng `canViewTeaching()` (`src/pages/Teaching/lib.ts:34`, đúng roles `nhansu`/`director`/...). Đây là cách nhanh nhất để một thông báo urgent tới được Giáo vụ/Nhân sự **bất kể đang ở màn nào**, không cần chờ họ mở Home.

## 2. Việc cần làm — Bell/Badge/List (bám theo POLICY/REPORT)

Ở **cả 2 file** `Employee/Home.tsx` và `Director/Home.tsx`:

1. Thêm 3 giá trị vào `NotificationType` (và xoá bản khai trùng ở `PortalDropdown.tsx`, import dùng chung nếu tiện — không bắt buộc nếu muốn giữ PR nhỏ, nhưng phải sửa cả 3 nơi):
   ```ts
   type NotificationType =
     | "POLICY" | "SUGGEST" | "REPORT" | "WEEKLY_PLAN"
     | "TEACHING_SCHEDULE_CONFIRM_RESULT"
     | "TEACHING_SCHEDULE_CONFIRM_ALERT"
     | "TEACHING_LESSON_REPORT_ALERT";
   ```
2. Thêm 3 dòng `socket.on(...)` trỏ vào `handleNew` (Director/Home.tsx đã có tiền lệ với `"teaching-schedule-notification:new"` ở dòng 411 — thêm cạnh đó), nhớ `socket.off` tương ứng trong cleanup:
   ```ts
   socket.on("teaching-schedule-confirm-result:new", handleNew);
   socket.on("teaching-schedule-confirm-alert:new", handleNew);
   socket.on("teaching-lesson-report-alert:new", handleNew);
   ```
3. Thêm 3 key vào `statsKeyOf`/state khởi tạo `notificationStats` — mặc định `{ unread: 0, read: 0 }`, không để `undefined` (giống lưu ý có sẵn ở `FE-REALTIME-NOTIFICATION-PROMPT.md` mục 8.3 về `TEACHING_SCHEDULE`).
4. Toast ngay khi nhận — khuyến nghị bật cho **`TEACHING_SCHEDULE_CONFIRM_ALERT`** (khẩn, có hạn 24h) theo đúng cách `Employee/Home.tsx` đang làm riêng cho `POLICY` (`handleRealtimeNotification`, gọi `toast.success/error` tuỳ nội dung — ở đây dùng `toast(...)` trung tính vì không phải lỗi/thành công). `CONFIRM_RESULT` và `LESSON_REPORT_ALERT` có thể chỉ tăng badge như REPORT đang làm (không bắt buộc toast) — tuỳ bạn, nhưng đã nêu ra để không bị hỏi lại.
5. Điều hướng khi bấm — thêm case vào `switch (noti.type)` trong `handleClickNotification` (cả 2 file). Backend đã gửi sẵn `meta.route`/`meta.url`, **ưu tiên dùng nó** (đúng quy tắc chung mục 1.5 của `FE-REALTIME-NOTIFICATION-PROMPT.md`) thay vì hardcode:
   ```ts
   case "TEACHING_SCHEDULE_CONFIRM_RESULT":
   case "TEACHING_SCHEDULE_CONFIRM_ALERT":
   case "TEACHING_LESSON_REPORT_ALERT":
     navigate(noti.meta?.route ? `/#${noti.meta.route}` : "/nhan-su/cham-cong");
     break;
   ```
   Lưu ý: cả 3 type hiện đều trỏ về `/nhan-su/cham-cong` (chưa có màn "chờ xác nhận lịch" hay "báo giảng" riêng ở BE) — đây là điểm dùng tạm đã biết trước, không phải bạn làm sai nếu 3 loại thông báo cùng mở một màn.
6. Danh sách/API REST: **không cần endpoint mới**. `GET /notifications?type=TEACHING_SCHEDULE_CONFIRM_RESULT` (và 2 type kia) đã dùng được ngay qua endpoint chung `/notifications` — validate theo đúng `NotificationType` enum phía BE, không giới hạn theo danh sách cứng.

## 3. Việc nên làm thêm — toast tới nơi kể cả không ở Home

Vì Giáo vụ/Nhân sự dành phần lớn thời gian trong `/nhan-su/*` (không có bell), khuyến nghị mở rộng `CheckinAlertWatcher.tsx` (đang chỉ nghe `teaching-checkin-alert:new`) để nghe thêm `teaching-schedule-confirm-alert:new` — cùng cơ chế toast + điều hướng theo `data.meta.route`, cùng guard `canViewTeaching()` đã có sẵn. Đây là **việc duy nhất nên làm ở đây, không cần dựng bell mới trong `TeachingLayout`** — giữ thay đổi nhỏ, tận dụng đúng component đã chứng minh hoạt động cho đúng nhu cầu "cảnh báo khẩn tới Giáo vụ/Nhân sự dù đang ở màn nào".

`TEACHING_SCHEDULE_CONFIRM_RESULT` và `TEACHING_LESSON_REPORT_ALERT` không khẩn bằng (không có hạn tính bằng giờ) — để nguyên trong bell là đủ, không cần thêm vào watcher này.

## 4. Nghiệm thu

- [ ] Đang ở màn `/director` (Home) → có giáo viên xác nhận/từ chối lịch → badge tăng ngay, không cần F5; bấm vào thông báo → mở đúng `/nhan-su/cham-cong`; sau khi bấm, thông báo chuyển đã đọc.
- [ ] Test cả 2 trường hợp Đồng ý và Từ chối — nội dung `message` khác nhau (đã kiểm chứng thật ở backend, xem prompt `FE-ZALO-MINIAPP-SCHEDULE-CONFIRM-PROMPT.md` mục 9), FE chỉ cần hiển thị nguyên `message`, không tự suy diễn lại.
- [ ] Một lịch còn `PENDING` sắp tới giờ dạy trong 24h → tài khoản Nhân sự và Giáo vụ đều nhận `TEACHING_SCHEDULE_CONFIRM_ALERT` (kiểm bằng 2 tài khoản test khác nhau), có toast hiện dù đang đứng trong màn Chấm công (`/nhan-su/cham-cong`), không chỉ ở Home.
- [ ] Sau 19:00, có giáo viên đã chấm công nhưng chưa báo giảng → Giáo vụ/Nhân sự nhận **đúng 1** thông báo tổng hợp `TEACHING_LESSON_REPORT_ALERT` (không phải 1 thông báo/giáo viên) — nội dung liệt kê tên + số tiết nếu có từ 2 giáo viên trở lên.
- [ ] Đăng nhập bằng tài khoản `giaovien` thuần (không có quyền quản lý) → **không** thấy 2 thông báo dành cho quản lý xuất hiện lẫn trong list của họ (họ chỉ nhận `TEACHING_SCHEDULE_CONFIRM_REQUEST`/bản cá nhân của `TEACHING_LESSON_REPORT_ALERT`, đến từ `receiverId` khác — không phải việc FE phải lọc, BE đã tách theo `receiverId` đúng người).
- [ ] Rời Home sang màn khác rồi quay lại → không tạo listener trùng (mở/đóng 5 lần, 1 thông báo vẫn chỉ hiện đúng 1 lần trong list, không nhân bản).

## 5. Kiểm chứng phía backend

Đã chạy thật, không suy đoán:

```
Giáo viên C (test) từ chối lịch #110
  → receiverId 140 (Nhân sự, role nhansu): TEACHING_SCHEDULE_CONFIRM_RESULT
  → receiverId 149 (Giáo vụ, role giaovu): TEACHING_SCHEDULE_CONFIRM_RESULT
  → receiverId 154 (chính giáo viên): TEACHING_SCHEDULE_CONFIRM_RESULT (biên nhận)
```

`TEACHING_LESSON_REPORT_ALERT` gửi thêm cho quản lý (tính năng vừa bổ sung trong cùng đợt này) đã có unit test xác nhận: gộp đúng 1 thông báo/quản lý (không lặp theo giáo viên), `message` liệt kê tên từng giáo viên kèm số tiết, `meta.teacherCount` đúng số giáo viên đang thiếu — 604 test của backend đang pass.
