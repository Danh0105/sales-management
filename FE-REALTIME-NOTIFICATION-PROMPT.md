# PROMPT: CẬP NHẬT FE MINI APP — NHẬN THÔNG BÁO REALTIME

Bạn là Senior Frontend Developer của mini app **KIDO Office** (`/var/www/kido-app` — React 19 + Vite + Capacitor, `socket.io-client` đã có sẵn).

Nhiệm vụ: **làm lại tầng nhận thông báo realtime cho toàn app** — hiện mỗi màn hình tự mở socket, tự lắng nghe, tự đếm badge nên thông báo hay bị mất khi reconnect / app chạy nền / đổi tài khoản.

Backend **không đổi** — dưới đây là mô tả đúng những gì BE đang phát ra. FE bám theo, không yêu cầu BE sửa.

---

## 0. Nền tảng

| Mục | Giá trị |
|---|---|
| REST base URL | `VITE_API_URL` (prod `https://sales.kidoedu.vn`, dev `http://160.250.132.143:3011`) — **không có prefix `/api`** |
| Socket URL | `VITE_SOCKET_URL` (cùng host/cổng với REST) |
| Auth REST | JWT Bearer mọi request |
| Auth socket | **Không có JWT.** Socket định danh bằng `employeeId` trong handshake |

---

## 1. HẠ TẦNG REALTIME CỦA BACKEND (sự thật hiện tại)

### 1.1 Namespace & room

| Namespace | Handshake BE đọc | Room BE join | Dùng để |
|---|---|---|---|
| `/` (mặc định) | `query.employeeId` → `query.userId` → `auth.employeeId` → `auth.userId` | `user_{employeeId}` | **Tất cả thông báo chuông** |
| `/report` | `auth.userId` hoặc `query.userId` | `user_{userId}` | Realtime chi tiết báo cáo ngày |
| `/suggest` | `query.employeeId` | `suggest_user_{employeeId}` | ⚠️ Xem mục 1.4 |

> Ba gateway `NotificationGateway`, `PolicyGateway`, `WeeklyPlanGateway` **đều nằm trên namespace mặc định** và join cùng room `user_{employeeId}` → chỉ cần **một** kết nối tới `/` là nhận hết.

### 1.2 Event trên namespace mặc định — nguồn chính

`NotificationService` map `type` của bản ghi notification sang tên event:

| `NotificationType` | Event socket |
|---|---|
| `POLICY` | `policy-notification:new` |
| `SUGGEST` | `suggest-notification:new` |
| `REPORT` | `report-notification:new` |
| `WEEKLY_PLAN` | `weekly-plan:new` |
| `EXPENSE_REQUEST` | `expense-request-notification:new` |
| `TEACHING_SCHEDULE` | `teaching-schedule-notification:new` |
| `SYSTEM` / khác | `notification:new` |

Payload = **nguyên bản ghi `Notification`**:

```jsonc
{
  "id": 9123,
  "receiverId": 17,
  "senderId": 42,              // có thể null
  "type": "EXPENSE_REQUEST",
  "entityId": 1234,            // id đối tượng liên quan (suggest/policy/report...)
  "meta": { "...": "..." },    // JSON mở rộng, xem 1.5
  "message": "…",
  "isRead": false,
  "createdAt": "2026-08-11T03:12:44.000Z"
}
```

### 1.3 Event "legacy" cùng tên `notification:new` — payload KHÁC

`PolicyGateway.notifyNewPolicy` và `WeeklyPlanGateway.notifyNewWeeklyPlan` bắn thẳng, **không có `id`, không có `type` chuẩn**:

```jsonc
{ "policyId": 55, "message": "… đã gửi yêu cầu duyệt chính sách", "createdAt": "…", "isRead": false }
{ "weeklyPlanId": 12, "type": "weekly_plan", "message": "…", "createdAt": "…", "isRead": false }
```

→ FE **bắt buộc** coi mọi payload thiếu `id` là **tín hiệu refetch** (gọi lại unread-count / invalidate list), không đẩy thẳng vào store rồi mark-as-read (không có id để PATCH).

### 1.4 Namespace `/suggest` — đang chết, đừng phụ thuộc

`SuggestGateway` join client vào `suggest_user_{id}` nhưng `SuggestService` lại emit vào room `user_{id}` **của chính namespace đó** → `suggest:new`, `suggest:updated`, `notification:new` trên `/suggest` **không tới client nào**.

Cùng lúc đó `SuggestService` vẫn gọi `notificationService.createNotifications(...)` → thông báo tương ứng **vẫn tới đủ** ở namespace mặc định qua `suggest-notification:new` / `expense-request-notification:new`.

**Yêu cầu:** bỏ `getSuggestSocket()` khỏi mọi màn hình (`pages/Director/Home.tsx` đang dùng), không mở kết nối `/suggest` nữa. Đừng mất thời gian debug event của namespace này.

### 1.5 `meta` — dữ liệu điều hướng

- Đề xuất chi: `{ suggestType: "EXPENSE_REQUEST", suggestId, suggestCode, employeeId, employeeName, employeePhone, kind: "created|reminder|due_today|overdue", status, daysLate }`
- Lịch dạy: `{ kind: "TEACHING_SCHEDULE", module: "teaching", route: "/giao-vien/lich-day", url: "/#/giao-vien/lich-day", fromDate, toDate, sessionCount, periodCount }`
- Xin dạy thay: `{ kind: "TEACHING_REPLACEMENT_REQUEST", sessionId }`

Quy tắc chung: **nếu `meta.route` tồn tại thì ưu tiên dùng nó**, còn lại fallback theo bảng ở mục 5.

### 1.6 Namespace `/report`

Chỉ dùng cho màn chi tiết báo cáo (`components/ReportDetailPopup.tsx`): `report:new`, `report:message:new`, `notification:new`. Handshake phải gửi **`userId`** (không phải `employeeId`).

---

## 2. FE ĐANG SAI / THIẾU Ở ĐÂU

Đọc kỹ trước khi sửa:

1. `src/utils/socket.ts` — singleton cache theo module, **giữ nguyên `employeeId` cũ sau khi đăng xuất/đăng nhập tài khoản khác** (query chỉ gắn lúc `io()` lần đầu). Không ai gọi `disconnectSockets()` khi logout.
2. `transports: ["websocket"]` — không có fallback `polling`. Qua nginx/HTTPS hoặc mạng 4G chặn WS là mất realtime **hoàn toàn, im lặng**.
3. Listener bị nhân bản 3 nơi: `pages/Employee/Home.tsx`, `pages/Director/Home.tsx`, `pages/ExpenseRequest/useExpenseSocket.ts` — mỗi nơi một tập event khác nhau (Employee Home thiếu `teaching-schedule-notification:new` và `expense-request-notification:new`). Rời khỏi Home là **không còn nhận gì**.
4. Không có bước **đồng bộ lại sau khi reconnect**: thông báo phát sinh trong lúc mất kết nối bị mất vĩnh viễn cho tới lần F5 kế tiếp.
5. App chạy nền (Capacitor) → WebSocket bị OS ngắt; khi resume không reconnect + không refetch.
6. Push: mới có web push (`utils/webPush.ts` → `POST /employee-fcm-token/save`). Native push (`@capacitor/push-notifications` đã cài) **chưa wire**. Foreground message chỉ `console.log`.

---

## 3. YÊU CẦU TRIỂN KHAI

### A. Một socket manager duy nhất — viết lại `src/utils/socket.ts`

```ts
// Yêu cầu hành vi:
// - 1 kết nối namespace "/" cho toàn app; namespace "/report" tạo theo yêu cầu (lazy).
// - transports: ["websocket", "polling"]  ← BẮT BUỘC có polling.
// - reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay 1000 → max 10000.
// - Nhớ employeeId đã dùng để tạo instance. getSocket() thấy employeeId khác
//   → disconnect instance cũ, tạo instance mới (fix bug đổi tài khoản).
// - Không throw khi thiếu employeeId → trả về null, caller tự bỏ qua.
// - disconnectSockets() được gọi trong luồng logout (và khi token hết hạn).
```

`/report` giữ nguyên API cũ (`getReportSocket()`), nhưng handshake phải là `{ query: { userId }, auth: { userId } }`.

### B. Tầng thông báo toàn cục — mount **một lần** ở `src/app.tsx`

Tạo `src/hook/useRealtimeNotifications.ts` + provider/store (dùng `jotai` đã có sẵn, hoặc React Query cache — chọn 1, đừng trộn):

- Đăng ký **đủ 7 event** ở mục 1.2 bằng một handler chung.
- State tối thiểu: `items` (20 bản mới nhất), `unreadTotal`, `unreadByType` (khớp key của `GET /notifications/stats`).
- **Dedupe theo `id`** — cùng một thông báo có thể đến 2 lần (socket + push foreground). Payload không có `id` → chỉ refetch.
- Gắn `socket.off(...)` đầy đủ trong cleanup; tuyệt đối không đăng ký listener trong render body.
- Bắn toast (`react-hot-toast` / `notistack` — theo cái app đang dùng ở màn hình đó) và tăng badge chuông ngay lập tức, không chờ refetch.

### C. Đồng bộ lại (reconcile) — quan trọng nhất

Gọi `GET /notifications/unread-count` + `GET /notifications/stats` + invalidate danh sách đang mở tại **mọi mốc**:

1. `socket.on("connect")` — cả lần đầu lẫn mỗi lần reconnect.
2. Capacitor `App.addListener("appStateChange", { isActive: true })` và `document.visibilitychange` → visible.
3. `window.addEventListener("online")`.
4. Sau khi mark-as-read (đồng bộ lại badge thật từ server).

Debounce 500ms để 3 mốc trên nổ cùng lúc không gọi API 3 lần.

### D. Fallback polling

Khi `socket.connected === false` quá **15 giây**: poll `GET /notifications/unread-count` mỗi **60 giây**. Socket `connect` lại → dừng poll ngay. Không poll khi tab/app ở background.

### E. Push (app đóng / chạy nền)

- Giữ web push hiện có; bổ sung native: `@capacitor/push-notifications` → `register()` → lấy FCM token → `POST /employee-fcm-token/save { token, platform }` (JWT). Gọi **sau khi đăng nhập thành công** và mỗi lần token refresh.
- Foreground (`onMessage` / `pushNotificationReceived`): **không** hiện notification hệ thống nếu socket đang connected (tránh trùng với toast) — chỉ refetch counter.
- Tap notification (`pushNotificationActionPerformed` / `notificationclick`): điều hướng theo `data.route` (BE gửi sẵn `route`, `url`, `kind`, `module`).

### F. Điều hướng khi bấm thông báo

Một hàm thuần `notificationPath(notification): string` dùng chung cho cả socket, danh sách chuông và push (bảng ở mục 5). Giữ nguyên `utils/teachingNotification.ts` đang có, gọi lại nó thay vì viết logic mới.

### G. Dọn code trùng

- `pages/Employee/Home.tsx`, `pages/Director/Home.tsx`: **xóa** toàn bộ block `socket.on(...)`, đọc từ store chung.
- `pages/ExpenseRequest/useExpenseSocket.ts`: giữ lại như một hook *filter trên store chung* (lọc `type === "EXPENSE_REQUEST"` hoặc `meta.suggestType === "EXPENSE_REQUEST"`), **không tự `getSocket()` nữa**.
- `components/ReportDetailPopup.tsx`: giữ nguyên namespace `/report`, chỉ đổi sang manager mới.

---

## 4. REST ENDPOINTS THAM CHIẾU (đã có, không đổi)

**Chung** — `/notifications`

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/notifications?page=1&limit=10&tab=unread\|read&type=POLICY\|SUGGEST\|REPORT\|SYSTEM\|WEEKLY_PLAN\|EXPENSE_REQUEST\|TEACHING_SCHEDULE` | `type` sai → 400 |
| GET | `/notifications/unread` | 20 bản mới nhất chưa đọc |
| GET | `/notifications/unread-count` | trả về số nguyên |
| GET | `/notifications/stats` | `{ POLICY: { unread, read }, … }` |
| PATCH | `/notifications/:id/read` | |
| PATCH | `/notifications/read-all` | |

**Theo module** — mỗi nhóm có `GET /`, `GET /unread-count`, `PATCH /:id/read`, `PATCH /read-all`:
`/notifications/policy`, `/notifications/suggest`, `/notifications/report`, `/notifications/plan`, `/notifications/teaching-schedule`

**Riêng:**
- `/notifications/report/grouped`, `/notifications/report/sender/:senderId`, `PATCH /notifications/report/sender/:senderId/read-all`
- `/notifications/expense/summary`, `/notifications/expense/grouped-by-employee`, `/notifications/expense?scope=general|overdue|all` (xem `FE-EXPENSE-NOTIFICATION-PROMPT.md`)

---

## 5. BẢNG ĐIỀU HƯỚNG

Ưu tiên `meta.route` nếu có; nếu không:

| `type` | Đích |
|---|---|
| `EXPENSE_REQUEST` / `SUGGEST` có `meta.suggestType = "EXPENSE_REQUEST"` | `/employee/expense-requests/{meta.suggestId ?? entityId}` — vai trò duyệt: `/director/expense-requests/{id}` |
| `SUGGEST` (thường) | `/employee/suggest` — vai trò duyệt: `/director/suggest-review/{entityId}` |
| `POLICY` | `/employee/policy/{entityId}` — vai trò duyệt: `/director/policy/{entityId}` |
| `REPORT` | `/employee/daily-report` — vai trò duyệt: `/director/daily-report/{senderId}` |
| `WEEKLY_PLAN` | màn kế hoạch tuần hiện hành |
| `TEACHING_SCHEDULE` | `/giao-vien/lich-day` |
| `meta.kind = "TEACHING_REPLACEMENT_REQUEST"` | `/nhan-su/lich-day?tab=sessions&sessionId={meta.sessionId}` |
| `SYSTEM` / không khớp | mở danh sách thông báo, **không** điều hướng bừa |

---

## 6. CHECKLIST NGHIỆM THU

- [ ] Đang ở **bất kỳ màn hình nào** (không chỉ Home) → có thông báo mới: badge tăng + toast hiện, không cần reload.
- [ ] Tắt mạng 30s, BE gửi 2 thông báo, bật mạng lại → socket reconnect, badge và danh sách khớp server (không mất, không nhân đôi).
- [ ] Đưa app xuống nền 5 phút rồi mở lại → tự reconnect + số liệu đúng.
- [ ] Chặn WebSocket (DevTools/proxy) → vẫn nhận được qua transport `polling`; nếu socket chết hẳn thì sau 15s có polling `unread-count` mỗi 60s.
- [ ] Đăng xuất tài khoản A → đăng nhập B: **không** còn nhận thông báo của A (kiểm tra query `employeeId` của socket mới).
- [ ] Nhận đủ **7** event ở mục 1.2 — test riêng `teaching-schedule-notification:new` (Nhân sự gửi lịch dạy cho giáo viên) và `expense-request-notification:new`.
- [ ] Payload legacy không có `id` (tạo policy / gửi kế hoạch tuần) → không crash, badge vẫn đúng nhờ refetch.
- [ ] Bấm thông báo → tới đúng màn hình theo bảng mục 5; thông báo chuyển sang đã đọc.
- [ ] App đóng → push FCM tới; bấm push mở đúng `data.route`.
- [ ] Push foreground khi socket đang sống → **không** hiện 2 lần.
- [ ] Rời màn hình / unmount → không còn listener rác (mở lại 10 lần, một thông báo vẫn chỉ hiện 1 toast).

---

## 7. RÀNG BUỘC

- **Không đổi** tên event, tên room, tên endpoint — BE đang chạy production (`sales.kidoedu.vn`) dùng chung với web.
- Không mở thêm kết nối socket nào ngoài `/` và `/report`.
- Không xoá màn hình / logic nghiệp vụ hiện có; đây là refactor tầng vận chuyển + bổ sung đồng bộ.
- Giữ `VITE_SOCKET_URL` / `VITE_API_URL`, không hardcode host.
- TypeScript strict: khai báo `type NotificationPayload` dùng chung ở `src/types`, đừng dùng `any`.

---

## 8. GHI CHÚ GỬI KÈM CHO BE (ngoài phạm vi FE, chỉ để biết)

1. Socket **không xác thực** — bất kỳ ai gửi `employeeId` tuỳ ý đều join được room người khác và đọc trộm thông báo. Nên chuyển sang xác thực JWT trong `handshake.auth.token`.
2. `SuggestService` emit sai room trên namespace `/suggest` (`user_{id}` trong khi client ở `suggest_user_{id}`) → event `suggest:new` / `suggest:updated` chết. Hoặc sửa room, hoặc bỏ hẳn gateway này.
3. `GET /notifications/stats` chưa có key `TEACHING_SCHEDULE` trong object khởi tạo (chỉ xuất hiện khi có dữ liệu) → FE phải tự default 0.
