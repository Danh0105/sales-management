# PROMPT: ZALO MINI APP — ĐĂNG NHẬP PHẢI GỬI KÈM zaloId

Bạn là Senior Frontend Developer làm Zalo Mini App. Backend vừa siết: **giáo viên đăng nhập từ Mini App bắt buộc gửi kèm `zaloId`**, thiếu thì bị từ chối.

> ⚠️ **Đây là breaking change với Mini App.** Nếu app đang chỉ gửi `phone` + `password`, hoặc gửi `uid` mà không gửi `zaloId`, giáo viên sẽ **không đăng nhập được** sau khi backend lên bản mới. Web và app thường không bị ảnh hưởng.

## 0. Vì sao

`zaloId` là `userInfo.idByOA` — đích để hệ thống gửi cảnh báo Zalo cho giáo viên (ví dụ "sắp tới giờ dạy mà chưa check-in"). Không có nó thì tài khoản đăng nhập được nhưng **không bao giờ nhận được cảnh báo nào**, và không ai biết cho tới lúc lỡ buổi dạy.

Trước đây field này tuỳ chọn nên phần lớn tài khoản trống. Giờ Mini App phải cung cấp ngay lúc đăng nhập.

## 1. Backend nhận biết Mini App bằng cách nào

Qua sự có mặt của **`uid`**. Chỉ Mini App lấy được `userInfo.id` từ Zalo SDK; web/app thường không gửi field này.

```
có uid  +  tài khoản là giáo viên  +  thiếu zaloId   →  400
```

Hệ quả cần nhớ: **gửi `uid` là tự nhận mình là Mini App.** Đừng gửi `uid` nếu chưa lấy được `zaloId` — sẽ bị chặn. Hoặc gửi cả hai, hoặc không gửi gì.

## 2. Hợp đồng API

**POST** `/auth/login`

```json
{
  "phone": "0900000008",
  "password": "123456",
  "uid": "<userInfo.id>",
  "zaloId": "<userInfo.idByOA>"
}
```

| Field | Bắt buộc | Nguồn |
|---|---|---|
| `phone`, `password` | ✅ | người dùng nhập |
| `uid` | Mini App | `userInfo.id` từ Zalo SDK |
| `zaloId` | Mini App, khi là giáo viên | `userInfo.idByOA` |

Thành công:

```json
{
  "access_token": "eyJ...",
  "user": {
    "id": 141, "name": "Giáo viên A", "roles": ["giaovien"],
    "zaloUid": "u-a", "zaloId": "idByOA-999"
  }
}
```

`zaloUid` và `zaloId` **chỉ xuất hiện với tài khoản có role `giaovien`**. Role khác không có hai field này — đừng đọc mù.

## 3. Lấy uid và zaloId từ Zalo SDK

Hai giá trị nằm trong cùng một lời gọi lấy thông tin người dùng:

```ts
// zmp-sdk
const { userInfo } = await getUserInfo({ autoRequestPermission: true });

const uid = userInfo.id;         // luôn có
const zaloId = userInfo.idByOA;  // CHỈ có khi người dùng đã quan tâm OA
```

> Tên hàm và hình dạng tham số theo phiên bản `zmp-sdk` bạn đang dùng — kiểm lại trong dự án. Điều chắc chắn là backend cần đúng hai giá trị `userInfo.id` và `userInfo.idByOA`.

## 4. Cạm bẫy lớn nhất: idByOA rỗng khi chưa quan tâm OA

`idByOA` **chỉ có giá trị nếu người dùng đã quan tâm (follow) OA** và Mini App được cấp quyền. Người chưa follow sẽ nhận `undefined` hoặc chuỗi rỗng — và backend chặn.

Nên **luồng đăng nhập phải xử lý việc follow OA trước, không phải sau**:

```
mở app
  → getUserInfo
  → có idByOA?
      CÓ    → gọi /auth/login với đủ uid + zaloId
      KHÔNG → hiện màn "Quan tâm OA để nhận thông báo lịch dạy"
              + nút mở OA (followOA / openOfficialAccount)
              → follow xong, gọi lại getUserInfo
              → có idByOA thì mới cho đăng nhập
```

**Đừng gọi `/auth/login` khi chưa có `idByOA` rồi mới xử lý lỗi 400.** Người dùng sẽ thấy "đăng nhập thất bại" trước khi hiểu mình cần làm gì — trải nghiệm tệ, và họ sẽ gọi lên hỗ trợ.

Backend cố tình chọn chặn cứng thay vì cho vào rồi nhắc sau, vì tài khoản chưa liên kết là tài khoản không nhận được cảnh báo — im lặng còn nguy hiểm hơn.

## 5. Ba mã lỗi phải phân biệt

Cả ba đều đã kiểm chứng thật trên server, không phải suy đoán.

### 400 — thiếu zaloId

```json
{
  "statusCode": 400,
  "message": "Thiếu zaloId. Vui lòng quan tâm OA của trường rồi mở lại ứng dụng để đăng nhập."
}
```

Cũng xảy ra khi `zaloId` chỉ có khoảng trắng. Xử lý: đưa về màn hướng dẫn quan tâm OA ở mục 4, kèm nút mở OA. **Không** hiện toast "Đăng nhập thất bại".

### 409 — Zalo này đã gắn cho giáo viên khác

```json
{
  "statusCode": 409,
  "message": "Tài khoản Zalo này đã được liên kết với một giáo viên khác"
}
```

Xảy ra khi hai giáo viên dùng chung một tài khoản Zalo (máy dùng chung, đăng nhập hộ). `zalo_user_id` là **unique** ở database.

**Quan trọng: 409 nghĩa là KHÔNG có token** — backend lưu liên kết trước khi sinh token, nên xung đột làm hỏng cả lượt đăng nhập. Người dùng không vào được app.

Xử lý: hiện thông báo rõ ràng, hướng dẫn liên hệ Nhân sự để gỡ liên kết cũ. Đừng thử lại tự động — thử lại bao nhiêu lần cũng vẫn 409.

### 401 — sai thông tin đăng nhập

```json
{ "statusCode": 401, "message": "Sai số điện thoại hoặc mật khẩu" }
```

Cùng một câu cho cả "sai mật khẩu" lẫn "số không tồn tại" — cố ý, để không lộ số nào có trong hệ thống. Đừng cố đoán và hiện thông báo khác nhau.

## 6. Điểm dễ bỏ sót

**Gửi `zaloId` ở mọi lần đăng nhập, không chỉ lần đầu.** Backend cập nhật lại mỗi lần, nên người dùng đổi Zalo hoặc cài lại app vẫn được đồng bộ.

**Role không phải giáo viên vẫn vào bình thường** dù thiếu `zaloId`. Đừng chặn ở phía client theo cách áp cho mọi role — sẽ khoá nhầm nhân sự và giáo vụ nếu họ dùng Mini App.

**Đừng gửi `uid` rỗng hoặc chuỗi trắng "cho đủ".** Backend coi `uid` có giá trị là dấu hiệu Mini App; gửi `uid` rác mà thiếu `zaloId` sẽ tự chuốc lấy 400.

**`zaloUid`/`zaloId` trong response có thể là giá trị đã lưu từ trước**, không nhất thiết là thứ vừa gửi lên. Dùng nó để hiển thị trạng thái liên kết, đừng dùng để xác nhận "lần này gửi thành công".

## 7. Nghiệm thu

Tài khoản thử: `0900000008` / `123456` (Giáo viên A) và `0900000007` / `123456` (Nhân sự).

- [ ] Giáo viên chưa follow OA → app hiện màn hướng dẫn quan tâm OA, **không** gọi `/auth/login`.
- [ ] Follow OA xong → lấy lại `idByOA` → đăng nhập thành công.
- [ ] Đăng nhập thành công → response có `zaloId`, app lưu token.
- [ ] Cố tình gọi API thiếu `zaloId` (qua devtools) → 400, app hiện hướng dẫn follow OA chứ không phải "thất bại".
- [ ] Hai giáo viên dùng chung một Zalo → người thứ hai nhận 409 với thông báo riêng, không phải 400, không tự thử lại.
- [ ] Sai mật khẩu → 401, thông báo chung.
- [ ] Tài khoản nhân sự đăng nhập từ Mini App → vào được kể cả khi không có `zaloId`.
- [ ] Đăng xuất rồi đăng nhập lại → `zaloId` được gửi lại.

## 8. Kiểm chứng phía backend

Đã chạy thật qua HTTP:

```
GIÁO VIÊN (0900000008)
  không uid (web)                    → 200
  có uid, thiếu zaloId               → 400
  có uid, zaloId toàn khoảng trắng   → 400
  đủ uid + zaloId                    → 200 · zaloId=idByOA-999

NHÂN SỰ (0900000007)
  có uid, thiếu zaloId               → 200

XUNG ĐỘT
  GV A gắn zaloId SHARED-1           → 200
  GV B gắn cùng SHARED-1             → 409

KHÔNG LỘ THÔNG TIN
  sai mật khẩu + uid                 → 401 (cùng câu)
  số không tồn tại + uid             → 401 (cùng câu)
```

Chốt kiểm tra `zaloId` đặt **sau** bước so mật khẩu — nếu đặt trước, người chỉ đoán số điện thoại sẽ phân biệt được số nào là giáo viên qua việc nhận 400 thay vì 401.

8 unit test cho module `auth`; toàn bộ 538 test của backend đang pass.
