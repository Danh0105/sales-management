# PROMPT: CẬP NHẬT FRONTEND — CHỨC NĂNG "VỊ TRÍ TRƯỜNG"

Bạn là Senior Frontend Developer. Backend module **Trường** (`/schools`) đã hỗ trợ **vị trí GPS + bán kính check-in** cho mỗi trường. Hãy cập nhật UI quản lý trường để nhập/sửa/hiển thị **vị trí trường**.

## 0. Bối cảnh (đọc kỹ)

- **Vị trí trường** gồm: `latitude`, `longitude` (tọa độ GPS) và `checkinRadius` (bán kính check-in, mét).
- Dữ liệu này dùng cho **check-in dạy học**: khi giáo viên check-in tại trường, backend tính khoảng cách từ GPS giáo viên tới tọa độ trường; nếu **vượt `checkinRadius`** thì đánh dấu **ngoài phạm vi** (`outOfRange`). Vì vậy nhập đúng tọa độ + bán kính là quan trọng.
- Nếu trường **chưa có tọa độ** → không kiểm tra khoảng cách. Nếu có tọa độ nhưng **không đặt `checkinRadius`** → hệ thống dùng **mặc định 200m**.

## 1. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**. Endpoint là `/schools/...`.
- **Auth**: JWT Bearer. Endpoint `POST /schools/resolve-google-maps` **bắt buộc** header `Authorization: Bearer <token>`. Gắn Bearer cho mọi request schools.
- Trường số: `latitude` (−90…90), `longitude` (−180…180), `checkinRadius` (số nguyên **20…2000** mét).

---

## 2. API

### 2.1 Phân giải link Google Maps → tọa độ

**POST** `/schools/resolve-google-maps` (JWT)

```json
{ "url": "https://maps.app.goo.gl/xxxxx" }
```

Response:
```json
{ "latitude": 10.762622, "longitude": 106.660172 }
```

- **Chỉ nhận link chia sẻ Google Maps qua HTTPS**, host thuộc: `maps.app.goo.gl`, `goo.gl`, `maps.google.com`, `www.google.com`, `google.com`. Link rút gọn (`maps.app.goo.gl`/`goo.gl`) sẽ được backend tự mở redirect để lấy tọa độ.
- Lỗi trả về (hiển thị nguyên message cho user):
  - `Link Google Maps không hợp lệ`
  - `Chỉ hỗ trợ link chia sẻ Google Maps`
  - `Không mở được link chia sẻ Google Maps`
  - `Không tìm thấy tọa độ trong link Google Maps`

### 2.2 Tạo / cập nhật trường (kèm vị trí)

**POST** `/schools` (tạo) · **PUT** `/schools/:id` (cập nhật) — các field liên quan vị trí:

```json
{
  "address": "123 Đường ABC",       // optional
  "latitude": 10.762622,             // optional
  "longitude": 106.660172,           // optional
  "checkinRadius": 200               // optional, số nguyên 20..2000 (mét)
  // ...các field trường khác giữ nguyên: name, representative, scale, classCount, taxCode, phone, employeeId, wardId...
}
```

Response = object trường vừa lưu (bao gồm `latitude`, `longitude`, `checkinRadius`, `address`).

### 2.3 Đọc trường

- **GET** `/schools/:id`, **GET** `/schools` (danh sách, phân trang) — đều trả `latitude`, `longitude`, `checkinRadius`, `address` của trường.

---

## 3. QUY TẮC VỊ TRÍ (BẮT BUỘC TUÂN THỦ — backend validate)

1. **Đi theo cặp**: phải gửi **đủ cả `latitude` và `longitude`**, hoặc **không gửi cả hai**. Gửi lẻ một trong hai → lỗi **400 "Cần đủ cả vĩ độ và kinh độ"**.
2. **Xóa vị trí**: gửi `latitude: null` (hoặc `longitude: null`) → backend **xóa toàn bộ vị trí** (đặt `latitude`, `longitude`, `checkinRadius` = `null`). FE dùng đúng cách này cho nút "Xóa vị trí".
3. `checkinRadius` chỉ có ý nghĩa khi đã có tọa độ. Giá trị hợp lệ **20…2000** (số nguyên). Ngoài khoảng → 400.

---

## 4. YÊU CẦU UI

Trong form **tạo/sửa trường**, thêm section **"Vị trí trường"** gồm:

1. **Ô dán link Google Maps** + nút **"Lấy tọa độ"**:
   - Bấm → gọi `POST /schools/resolve-google-maps` với `{ url }`.
   - Thành công → tự điền `latitude`, `longitude` vào 2 ô tọa độ.
   - Lỗi → hiển thị message backend trả về; không đổi tọa độ đang có.
   - Hướng dẫn ngắn: "Mở Google Maps → chọn địa điểm → Chia sẻ → sao chép link, dán vào đây".
2. **Ô nhập tay `latitude` / `longitude`** (số thực, ràng buộc −90…90 và −180…180) — cho phép chỉnh sau khi resolve.
3. **Ô `checkinRadius`** (số nguyên 20…2000, gợi ý mặc định 200) kèm chú thích "bán kính cho phép check-in (mét)".
4. **Nút "Xóa vị trí"**: gửi `latitude: null` khi submit để xóa toàn bộ tọa độ + bán kính.
5. **(Khuyến nghị)** Bản đồ xem trước (marker tại lat/lng + vòng tròn bán kính `checkinRadius`) để người dùng kiểm tra trực quan. Nếu không dùng bản đồ, ít nhất hiển thị link "Xem trên Google Maps" (`https://www.google.com/maps?q=<lat>,<lng>`).

**Validation phía FE trước khi submit** (khớp backend):
- Nếu người dùng nhập 1 trong 2 tọa độ → chặn submit, báo "Cần đủ cả vĩ độ và kinh độ".
- `checkinRadius` ngoài 20…2000 → báo lỗi tại chỗ.
- Nếu không có tọa độ → ẩn/disable ô `checkinRadius` (vì vô nghĩa).

**Hiển thị ở chi tiết / danh sách trường**:
- Nếu có tọa độ: hiện tọa độ + bán kính + link "Xem trên Google Maps".
- Nếu chưa có: badge "Chưa đặt vị trí" (để nhắc, vì ảnh hưởng check-in dạy học).

---

## 5. CHECKLIST NGHIỆM THU

- [ ] Dán link Google Maps rút gọn (`maps.app.goo.gl/...`) → "Lấy tọa độ" tự điền lat/lng.
- [ ] Các message lỗi resolve hiển thị đúng nguyên văn từ backend.
- [ ] Tạo/sửa trường lưu được `latitude`, `longitude`, `checkinRadius`; đọc lại đúng.
- [ ] Nhập lẻ 1 tọa độ bị chặn ("Cần đủ cả vĩ độ và kinh độ").
- [ ] `checkinRadius` giới hạn 20…2000; ẩn khi chưa có tọa độ.
- [ ] Nút "Xóa vị trí" gửi `latitude: null` và xóa sạch tọa độ + bán kính.
- [ ] Chi tiết/danh sách trường hiển thị vị trí + link Google Maps; trường chưa có tọa độ hiện badge nhắc nhở.
