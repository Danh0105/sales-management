# PROMPT: ZALO MINI APP — HIỂN THỊ VÀ CẬP NHẬT VỊ TRÍ GIÁO VIÊN

Bạn là Senior Frontend Developer làm Zalo Mini App cho giáo viên. Backend đã có sẵn API ghi nhận vị trí dạy của giáo viên, dùng để tính khoảng cách check-in tại trường. Mini App **chưa có UI nào cho việc này** — đây là tính năng mới hoàn toàn.

## 0. Vì sao

Giáo viên cần khai vị trí (toạ độ) của mình để hệ thống so khoảng cách khi check-in tại trường. Lần đầu khai thì ghi thẳng luôn. Nhưng nếu giáo viên **đã có vị trí rồi** mà gửi vị trí khác đi — ví dụ chuyển nhà, hoặc bấm nhầm — backend **không ghi đè ngay**: nó tạo một yêu cầu chờ Giáo vụ/Nhân sự duyệt, vị trí cũ vẫn giữ nguyên cho tới khi có người duyệt. Lý do: vị trí sai lệch ảnh hưởng trực tiếp tới việc chấm công (kiểm tra giáo viên có check-in đúng chỗ không), nên đổi vị trí sau lần đầu phải qua kiểm soát, không tự động.

Mini App cần cho giáo viên biết rõ 3 trạng thái: **chưa có vị trí**, **đã có vị trí**, và **có vị trí nhưng đang chờ duyệt vị trí mới**.

## 1. Lấy trạng thái vị trí hiện tại

### `GET /teachers/me`

**Headers:** `Authorization: Bearer <token>` (role `giaovien`)

Response (rút gọn, chỉ phần liên quan vị trí):

```json
{
  "id": 17,
  "name": "Giáo viên C (test)",
  "latitude": 10.8231,
  "longitude": 106.6297,
  "locationChangeStatus": null,
  "pendingLocation": null
}
```

| Field | Kiểu | Ý nghĩa |
|---|---|---|
| `latitude`, `longitude` | `number \| null` | Vị trí **đã được duyệt/ghi nhận**, dùng để chấm công. `null` = giáo viên chưa từng khai vị trí. |
| `locationChangeStatus` | `"pending" \| null` | `"pending"` = đang có một yêu cầu đổi vị trí chờ Giáo vụ/Nhân sự xử lý. `null` = không có yêu cầu nào đang chờ (dù `latitude`/`longitude` có giá trị hay không). |
| `pendingLocation` | `{ latitude, longitude } \| null` | Vị trí **mới đang chờ duyệt**, chỉ có giá trị khi `locationChangeStatus === "pending"`. Đây **không phải** vị trí dùng để chấm công — chỉ hiển thị để giáo viên biết mình đã gửi gì. |

Ba trạng thái cần phân biệt trên UI, suy ra trực tiếp từ 2 field `latitude`/`locationChangeStatus`:

| `latitude` | `locationChangeStatus` | Trạng thái hiển thị |
|---|---|---|
| `null` | `null` | **Chưa có vị trí** — chưa từng khai lần nào |
| có giá trị | `null` | **Đã có vị trí** — hiển thị toạ độ hiện tại |
| có giá trị | `"pending"` | **Đã có vị trí, đang chờ duyệt vị trí mới** — hiển thị cả 2 toạ độ |
| `null` | `"pending"` | Không xảy ra trong thực tế (lần đầu ghi thẳng, không qua duyệt) — nhưng nếu gặp thì xử lý như dòng trên với vị trí hiện tại là "Chưa có" |

## 2. Hiển thị vị trí hiện tại (nếu có)

Khi `latitude`/`longitude` khác `null`:

- Hiện dòng **"Vị trí hiện tại"** kèm toạ độ (làm tròn hiển thị, ví dụ `10.823100, 106.629700` — giữ nguyên số thập phân backend trả, không tự làm tròn khi gửi lại lên server).
- Kèm nút **"Xem trên bản đồ"** mở Google Maps bằng toạ độ, dựng URL từ dữ liệu số (không nối chuỗi thô chưa qua kiểm tra kiểu):

```ts
const googleMapsUrl = (latitude: number, longitude: number) =>
  `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
```

Khi `latitude`/`longitude` là `null`:

- Hiện dòng **"Chưa có vị trí"** thay cho toạ độ, ẩn nút "Xem trên bản đồ".
- Hiện nút **"Ghi nhận vị trí"** để giáo viên bấm khai lần đầu (xem mục 3) — dùng label khác với nút "Cập nhật vị trí" ở trạng thái đã có, vì hành vi backend khác nhau (ghi thẳng vs. tạo yêu cầu).

Khi `locationChangeStatus === "pending"` (bất kể vị trí hiện tại có hay không):

- Thêm khối **"Đang chờ duyệt"** ngay dưới vị trí hiện tại, hiển thị toạ độ trong `pendingLocation` kèm nhãn rõ đây là vị trí **đề nghị**, chưa được dùng để chấm công.
- Vô hiệu hoá (hoặc ẩn) nút gửi vị trí mới trong lúc đang chờ — gửi lại lúc này sẽ **ghi đè** yêu cầu đang chờ bằng toạ độ mới (xem mục 3), không tạo yêu cầu thứ hai song song. Nếu vẫn cho phép gửi lại, phải nói rõ trong UI rằng gửi lại sẽ thay thế yêu cầu đang chờ, không phải xếp hàng thêm.
- Không hiện nút "Xem trên bản đồ" cho `pendingLocation` là bắt buộc — có thể thêm nếu muốn, chỉ là không phải yêu cầu tối thiểu.

## 3. Gửi vị trí mới

### `POST /teachers/me/location`

**Headers:** `Authorization: Bearer <token>` (role `giaovien`)

```json
{ "latitude": 10.8231, "longitude": 106.6297 }
```

| Field | Bắt buộc | Ràng buộc |
|---|---|---|
| `latitude` | ✅ | số, -90 đến 90, tối đa 7 chữ số thập phân |
| `longitude` | ✅ | số, -180 đến 180, tối đa 7 chữ số thập phân |

Lấy toạ độ bằng Geolocation API của trình duyệt/Mini App SDK (độ chính xác cao nhất có thể — không cần gửi kèm `accuracy`, backend không nhận field này).

Response khác nhau tuỳ giáo viên đã có vị trí hay chưa — **đọc `status` để biết hiển thị gì, không giả định luôn thành công ngay:**

```json
// Lần đầu khai — ghi thẳng, không cần duyệt
{ "status": "captured", "requiresApproval": false, "latitude": 10.7756, "longitude": 106.7019 }
```

```json
// Đã có vị trí, gửi vị trí khác — tạo yêu cầu chờ duyệt
{ "status": "pending", "requiresApproval": true, "requestId": 2 }
```

Xử lý theo `status`:

- `"captured"` → toast thành công ngay (VD "Đã ghi nhận vị trí"), cập nhật `latitude`/`longitude` tại chỗ từ chính response, không cần gọi lại `GET /teachers/me`.
- `"pending"` → toast khác hẳn (VD "Đã gửi yêu cầu, chờ Giáo vụ/Nhân sự duyệt"), **không** cập nhật vị trí hiện tại (vẫn giữ nguyên vị trí cũ trên UI) — chỉ chuyển sang hiển thị khối "Đang chờ duyệt" ở mục 2. An toàn nhất là gọi lại `GET /teachers/me` để lấy đúng `pendingLocation` vừa tạo thay vì tự suy từ toạ độ vừa gửi.

### Lỗi

| Status | Khi nào |
|---|---|
| `400` | `latitude`/`longitude` thiếu, sai kiểu, hoặc ngoài khoảng cho phép |
| `403` | Tài khoản không phải role `giaovien` |
| `404` | Tài khoản chưa được gắn hồ sơ giáo viên nào |

Không có mã lỗi riêng cho "đang có yêu cầu chờ" — gửi lại lúc đang `pending` **không báo lỗi**, mà cập nhật thẳng toạ độ của yêu cầu đang chờ (ghi đè, xem mục 2).

## 4. Thông báo kết quả duyệt — `TEACHER_LOCATION_CHANGE_RESULT`

Sau khi Giáo vụ/Nhân sự duyệt hoặc từ chối yêu cầu, giáo viên nhận thông báo qua kênh thông báo chung hiện có (không phải API riêng) — Mini App phải xử lý type này giống các type khác, không lọc bỏ:

```json
{
  "type": "TEACHER_LOCATION_CHANGE_RESULT",
  "message": "Yêu cầu đổi vị trí của bạn đã được duyệt. Vị trí mới đã được cập nhật.",
  "meta": {
    "kind": "teacher_location_change_result",
    "module": "teaching",
    "route": "/giao-vien/lich-day",
    "url": "/giao-vien/lich-day",
    "teacherId": 17,
    "approved": true
  }
}
```

Khi bị từ chối, `message` kèm lý do và `meta.approved: false`:

```
"Yêu cầu đổi vị trí của bạn đã bị từ chối. Lý do: Sai địa chỉ, cần xác minh lại"
```

**Sự kiện Socket.IO:** `teacher-location-change-result:new` (bắn tới đúng phòng của giáo viên, tương tự các thông báo lịch dạy khác đã tích hợp — xem `FE-ZALO-MINIAPP-FCM-SOCKET-PROMPT.md` cho phần khởi tạo kết nối chung, không lặp lại ở đây). Ngoài socket, cùng nội dung cũng được gửi qua FCM push nếu thiết bị đã đăng ký token.

Nhận được thông báo này thì:

- Nếu Mini App đang mở đúng màn vị trí, gọi lại `GET /teachers/me` để đồng bộ `latitude`/`longitude`/`locationChangeStatus` mới nhất thay vì tự suy từ nội dung thông báo.
- `meta.approved === true` → vị trí trong `pendingLocation` cũ giờ đã là vị trí chính thức.
- `meta.approved === false` → vị trí hiện tại **không đổi**, chỉ có `locationChangeStatus` trở lại `null`.

## 5. Gợi ý UI

- Màn hồ sơ giáo viên (hoặc màn riêng "Vị trí dạy"): hiện đúng 1 trong 3 trạng thái ở mục 2, không gộp chung "Chưa có vị trí" và "Đang chờ duyệt" vào cùng một dòng vì ý nghĩa khác nhau.
- Nút gửi vị trí nên tự lấy toạ độ qua Geolocation, hiện rõ đang lấy vị trí (loading), rồi mới gọi API — không để giáo viên tự nhập tay toạ độ.
- Chặn double-submit trong lúc đang gọi API (disable nút, không phụ thuộc riêng debounce phía UI).
- Toast phân biệt rõ 2 kết quả `"captured"` và `"pending"` ở mục 3 — dùng chung 1 toast "Thành công" là gây hiểu lầm rằng vị trí đã đổi ngay trong khi thực ra còn chờ duyệt.
- Khi nhận `TEACHER_LOCATION_CHANGE_RESULT` lúc app đang mở màn khác, vẫn nên cập nhật badge/toast — không bắt buộc điều hướng ngay, giáo viên có thể xem lại khi mở màn vị trí.

## 6. Nghiệm thu

Tài khoản thử: `0900000011` / `123456` (Giáo viên C, teacherId=17). Tài khoản Nhân sự thử để duyệt qua Postman/API trực tiếp nếu cần dựng dữ liệu: bất kỳ tài khoản role `nhansu` hoặc `giaovu` nào.

- [ ] Giáo viên chưa từng khai vị trí → `GET /teachers/me` trả `latitude: null`, màn hiện "Chưa có vị trí".
- [ ] Bấm "Ghi nhận vị trí" lần đầu → `POST /teachers/me/location` trả `status: "captured"` → màn cập nhật ngay, hiện toạ độ + nút "Xem trên bản đồ".
- [ ] Bấm "Cập nhật vị trí" với toạ độ khác → trả `status: "pending", requestId` → màn chuyển sang "Đang chờ duyệt", **vị trí hiện tại không đổi**.
- [ ] Trong lúc đang chờ duyệt, gọi lại `GET /teachers/me` → thấy `locationChangeStatus: "pending"` và đúng `pendingLocation` vừa gửi.
- [ ] Giáo vụ/Nhân sự duyệt (`PATCH /teachers/location-change-requests/:id/approve`) → giáo viên nhận `TEACHER_LOCATION_CHANGE_RESULT` với `meta.approved: true` → `GET /teachers/me` lại thấy `latitude`/`longitude` đã đổi sang vị trí mới, `locationChangeStatus` về `null`.
- [ ] Lặp lại nhưng bấm từ chối (`.../reject` kèm `note`) → giáo viên nhận `TEACHER_LOCATION_CHANGE_RESULT` với `meta.approved: false` và lý do trong `message` → `GET /teachers/me` vẫn giữ vị trí cũ, `locationChangeStatus` về `null`.
- [ ] Gửi vị trí mới trong lúc đang có yêu cầu `pending` → yêu cầu cũ bị ghi đè bằng toạ độ mới (không tạo yêu cầu thứ hai) — kiểm bằng cách duyệt và xác nhận toạ độ áp dụng là toạ độ gửi sau cùng.

## 7. Kiểm chứng phía backend

Đã chạy thật qua HTTP + kiểm tra DB trên môi trường dev (không phải suy đoán), dùng tài khoản `0900000011` (Giáo viên C, employeeId 154, teacherId 17):

```
GET /teachers/me (chưa khai gì)
  → latitude: null, longitude: null, locationChangeStatus: null, pendingLocation: null

POST /teachers/me/location {latitude:10.7756, longitude:106.7019}   (lần đầu)
  → 200 {status:"captured", requiresApproval:false, latitude:10.7756, longitude:106.7019}

GET /teachers/me
  → latitude:10.7756, longitude:106.7019, locationChangeStatus:null, pendingLocation:null

POST /teachers/me/location {latitude:10.8231, longitude:106.6297}   (đổi vị trí)
  → 200 {status:"pending", requiresApproval:true, requestId:2}

GET /teachers/me
  → latitude:10.7756, longitude:106.7019   (giữ nguyên, CHƯA đổi)
  → locationChangeStatus:"pending"
  → pendingLocation:{latitude:10.8231, longitude:106.6297}

PATCH /teachers/location-change-requests/2/approve {note:"Đã kiểm tra"}  (Nhân sự duyệt)
  → 200 {id:2, status:"approved"}

GET /teachers/me
  → latitude:10.8231, longitude:106.6297   (đã đổi sang vị trí mới)
  → locationChangeStatus:null, pendingLocation:null

Notification tạo ra (bảng notification):
  receiverId 154 (giáo viên) — TEACHER_LOCATION_CHANGE_RESULT
  message: "Yêu cầu đổi vị trí của bạn đã được duyệt. Vị trí mới đã được cập nhật."
  meta: {kind:"teacher_location_change_result", module:"teaching",
         route:"/giao-vien/lich-day", url:"/giao-vien/lich-day",
         teacherId:17, approved:true}

--- Lặp lại với luồng từ chối ---

POST /teachers/me/location {latitude:10.79, longitude:106.68}
  → 200 {status:"pending", requiresApproval:true, requestId:3}

PATCH /teachers/location-change-requests/3/reject {note:"Sai địa chỉ, cần xác minh lại"}
  → 200 {id:3, status:"rejected"}

GET /teachers/me
  → latitude:10.8231, longitude:106.6297   (giữ nguyên vị trí đã duyệt trước đó, KHÔNG đổi sang 10.79/106.68)
  → locationChangeStatus:null, pendingLocation:null

Notification tạo ra:
  receiverId 154 (giáo viên) — TEACHER_LOCATION_CHANGE_RESULT
  message: "Yêu cầu đổi vị trí của bạn đã bị từ chối. Lý do: Sai địa chỉ, cần xác minh lại"
  meta: {..., approved:false}
```

631 unit test của backend đang pass, gồm các case: duyệt cập nhật đúng vị trí, từ chối kèm lý do không đổi vị trí, và giáo viên chưa gắn tài khoản thì không gửi thông báo (không lỗi âm thầm).
