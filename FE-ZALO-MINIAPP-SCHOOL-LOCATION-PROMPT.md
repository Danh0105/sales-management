# PROMPT: CẬP NHẬT FE MINI APP — HIỂN THỊ ĐIỂM TRƯỜNG (CƠ SỞ)

Bạn là Senior Frontend Developer phụ trách Zalo Mini App dành cho giáo viên. Backend vừa bổ sung khái niệm **điểm trường** (cơ sở của một trường). Hãy cập nhật Mini App để hiển thị đúng nơi giáo viên phải đến dạy, tái sử dụng layout, API client, auth, GPS service, toast và design system hiện có.

Đây là thay đổi **hiển thị + ngữ nghĩa vị trí**. Không đổi luồng check-in/check-out, không tự nhóm block ở FE, không thêm màn hình quản trị.

---

## 0. Vì sao

Một trường có thể có nhiều cơ sở nằm ở các địa chỉ khác nhau (ví dụ "Cơ sở 1", "Điểm lẻ Thôn Đông"). Trước đây mọi buổi dạy chỉ gắn với **trường**, nên giáo viên nhìn lịch không biết phải đến cơ sở nào, và GPS check-in luôn đo tới toạ độ trường mẹ.

Từ nay:

- Lớp học được gắn vào một điểm trường. Lịch dạy và buổi dạy **kế thừa điểm trường từ lớp** — backend tự suy, FE không gửi lên.
- **Check-in/check-out đo theo toạ độ của chính điểm trường đó**, không phải trường mẹ.
- Trường không khai cơ sở nào thì mọi thứ giữ nguyên như cũ.

---

## 1. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**.
- **Auth**: JWT Bearer cho mọi request.
- Endpoint liên quan (không đổi đường dẫn, chỉ thêm field trong response):
  - `GET /teaching-sessions/me` — lịch dạy của chính giáo viên đang đăng nhập
  - `GET /teaching-sessions/:id` — chi tiết một buổi
  - `POST /teaching-sessions/:id/checkin`, `POST /teaching-sessions/:id/checkout` — **payload không đổi**

---

## 2. Hai field mới trên mỗi buổi dạy

```ts
type TeachingSession = {
  // ... các field cũ giữ nguyên
  schoolId: number;
  schoolName: string;

  /** null = trường không chia cơ sở. Có giá trị = buổi dạy tại cơ sở này. */
  schoolLocationId: number | null;
  /** Tên cơ sở để hiển thị, ví dụ "Cơ sở 1". null khi schoolLocationId null. */
  locationName: string | null;
};
```

**Quy tắc hiển thị chung, áp dụng ở mọi nơi đang hiện `schoolName`:**

- `locationName` có giá trị → hiện **cả hai**: tên trường (dòng chính) và tên cơ sở (dòng phụ, chữ nhỏ hơn / màu nhạt hơn).
- `locationName` là `null` → hiện y như hiện tại, **không** render dòng trống, không hiện "—" hay "Không có cơ sở".

Không suy đoán tên cơ sở từ `schoolLocationId`; luôn dùng `locationName` backend trả về.

---

## 3. ⚠️ Toạ độ geofence đã đổi ý nghĩa

Ba field dưới đây **vẫn giữ nguyên tên** nhưng backend đã trả về toạ độ của **điểm trường** khi buổi dạy thuộc một cơ sở, và tự lùi về toạ độ trường mẹ khi không có:

```ts
schoolLatitude: number | null;
schoolLongitude: number | null;
schoolCheckinRadius: number | null;   // mặc định 200 nếu chưa khai
```

**FE không cần đổi công thức tính khoảng cách** — cứ dùng ba field này như đang làm. Nhưng phải sửa **phần chữ** đang nói "quanh {schoolName}", vì câu đó giờ sai sự thật khi buổi dạy thuộc một cơ sở.

Ví dụ câu đúng:

```
Cho phép trong bán kính {schoolCheckinRadius} m quanh {locationName || schoolName}.
Đứng ngoài vẫn chấm được nhưng sẽ bị đánh dấu để Nhân sự xem lại.
```

Tương tự cho câu khi chưa có toạ độ: đổi "Trường chưa gắn toạ độ…" thành "Chưa gắn toạ độ…" để không khẳng định sai là lỗi của trường mẹ.

---

## 4. ⚠️ Block chấm công giờ ngắt theo địa điểm

Backend gộp các tiết liên tiếp thành một "lần đến trường" (block) để quyết định `checkinRequired` / `checkoutRequired`. **Quy tắc gộp đã đổi**: trước đây gộp theo `schoolId`, nay gộp theo **địa điểm vật lý** — đổi trường **hoặc đổi điểm trường** đều ngắt block.

Hệ quả với giáo viên dạy nhiều cơ sở trong cùng một ngày:

| Tình huống | Trước | Nay |
|---|---|---|
| Tiết 1 và tiết 2 cùng "Cơ sở 1" | 1 block | 1 block (không đổi) |
| Tiết 1 ở "Cơ sở 1", tiết 2 ở "Cơ sở 2" | gộp 1 block — **sai** | 2 block: phải check-out ở cơ sở 1 rồi check-in ở cơ sở 2 |

**FE không cần tự tính lại.** Vẫn render nút đúng theo hai cờ `checkinRequired` / `checkoutRequired` backend trả về, như quy ước hiện có. Chỉ cần bảo đảm màn hình hiển thị rõ **cơ sở nào** để giáo viên không bấm nhầm buổi.

Nếu Mini App đang có chỗ nào tự gom tiết theo `schoolId` để hiển thị nhóm, hãy đổi sang gom theo `schoolLocationId ?? schoolId`. Lưu ý dùng khoá chuỗi có tiền tố (`L{id}` / `S{id}`), vì id cơ sở và id trường đánh số độc lập nên gom bằng số thuần sẽ nhầm cơ sở #1 với trường #1.

---

## 5. Nơi cần cập nhật trong Mini App

1. **Danh sách lịch dạy của tôi** — mỗi dòng buổi dạy: thêm tên cơ sở dưới tên trường.
2. **Chi tiết buổi dạy** — thêm một dòng thông tin "Điểm trường", đặt ngay dưới dòng "Trường". Ẩn hoàn toàn khi `locationName` null.
3. **Màn check-in và check-out** — tiêu đề/phụ đề nêu rõ đang chấm công tại cơ sở nào; sửa câu mô tả bán kính theo mục 3.
4. **Thông báo đẩy / nhắc lịch** (nếu Mini App tự dựng nội dung từ dữ liệu buổi) — thêm cơ sở vào dòng địa điểm.
5. **Màn xin dạy tiết đang mở** (nếu có) — hiện cơ sở để giáo viên biết quãng đường thật trước khi nhận.

---

## 6. Nghiệm thu

- [ ] Buổi thuộc cơ sở: danh sách và chi tiết đều hiện tên cơ sở; câu bán kính nêu tên cơ sở.
- [ ] Buổi không thuộc cơ sở nào: giao diện **giống hệt trước khi có thay đổi này**, không có dòng thừa.
- [ ] Check-in đứng trong bán kính của cơ sở → không bị cảnh báo ngoài phạm vi.
- [ ] Giáo viên có tiết ở hai cơ sở khác nhau trong cùng ngày → thấy nút check-out ở tiết cuối cơ sở 1 **và** nút check-in ở tiết đầu cơ sở 2 (không còn bị gộp thành một lần).
- [ ] Không có màn nào vỡ layout khi tên cơ sở dài (ví dụ "Điểm lẻ Thôn Đông Nam"); cho xuống dòng hoặc cắt bằng ellipsis.

---

## 7. Kiểm chứng phía backend (đã chạy thật)

Contract dưới đây lấy từ một buổi dạy thật trên môi trường dev:

```json
{
  "schoolName": "TEST XL",
  "schoolLocationId": 1,
  "locationName": "Cơ sở 1",
  "schoolLatitude": 0,
  "schoolLongitude": 0,
  "schoolCheckinRadius": 200,
  "checkinRequired": true,
  "checkoutRequired": true
}
```

Lưu ý khi test: nếu cơ sở được khai toạ độ `0, 0` thì đó là một điểm ngoài Đại Tây Dương, nên mọi lần check-in sẽ báo ngoài phạm vi. Đây là **dữ liệu khai thiếu**, không phải lỗi Mini App — cần vào màn "Điểm trường" bên web quản trị đặt lại toạ độ trước khi nghiệm thu bước check-in.
