# PROMPT: FE — MÀN QUẢN LÝ GIÁO VIÊN (NHÂN SỰ): PHÂN XÃ/PHƯỜNG THAY VÌ TỪNG TRƯỜNG

> Đã triển khai trực tiếp trong `kido-app` (nhánh hiện tại) — file này là tài
> liệu mô tả lại đúng thay đổi để review/đối chiếu, không phải việc cần làm từ
> đầu. Nếu team có nhánh/khu vực khác cũng render màn "Quản lý giáo viên" (vd.
> bản build riêng, PR chưa merge...), dùng đúng nội dung dưới đây để áp lại.

## 0. Vì sao

Trước đây Nhân sự khai **từng trường** giáo viên được nhận dạy
(`teacher.schoolIds`). Giờ đổi sang khai **xã/phường** — giáo viên được gán 1
xã/phường sẽ tự động nhận dạy được **toàn bộ trường thuộc xã/phường đó**,
tính động tại thời điểm tra cứu (trường thêm/xoá khỏi xã/phường sau này tự
cộng/trừ theo, không phải danh sách chốt cứng lúc gán).

Lý do đổi field thay vì giữ nguyên: một giáo viên thường nhận dạy cả một khu
vực, chọn từng trường một rất mất công và dễ sót khi có trường mới mở trong
khu vực đó.

## 1. API thay đổi

`POST /teachers`, `PATCH /teachers/:id` — field mới **`wardIds: number[]`**
thay cho `schoolIds` cũ. Cùng ngữ nghĩa PATCH như trước: bỏ field = giữ
nguyên, gửi `[]` = xoá hết. Validate giống hệt cơ chế cũ, chỉ đổi tên field và
thông báo lỗi:

```json
// 400 khi ID không tồn tại
{ "message": ["Xã/phường không tồn tại: 999"] }
```

`GET /teachers`, `GET /teachers/:id` — response giờ trả **cả 4 field**:

```json
{
  "wardIds": [138],
  "allowedWards": [{ "id": 138, "name": "Lâm Viên - Đà Lạt" }],
  "schoolIds": [372, 359, 354, "... toàn bộ trường thuộc các ward trên"],
  "allowedSchools": [{ "id": 372, "name": "TH AN DƯƠNG VƯƠNG" }, "..."]
}
```

`schoolIds`/`allowedSchools` **vẫn giữ nguyên hình dạng như cũ** — không phải
field mới, chỉ đổi nguồn: giờ là **suy ra động** từ các xã/phường đã gán (hợp
tất cả trường của mọi ward trong `allowedWards`, loại trùng), không còn là
danh sách khai tay. Field này chỉ để đọc/hiển thị — có gửi `schoolIds` lên
`POST`/`PATCH` cũng bị bỏ qua (DTO chỉ nhận `wardIds`, bật
`forbidNonWhitelisted` nên gửi field lạ sẽ bị **400**, không phải bị lờ đi
âm thầm).

Danh sách xã/phường để render dropdown: `GET /wards` (đã có sẵn, dùng chung
với màn phân vùng kinh doanh — `wardApi.getAll()`).

## 2. Thay đổi UI đã áp dụng

**`TeacherFormModal.tsx`** — ô "Trường có thể dạy" (`MultiSelect` + state
`schoolIds`) đổi thành **"Xã/phường có thể dạy"** (`MultiSelect` + state
`wardIds`), options lấy từ `wardApi.getAll()` qua `useTeachingRefData()`.
Payload gửi lên đổi `schoolIds` → `wardIds`. Thông báo lỗi 400 map theo prefix
mới `"Xã/phường không tồn tại"` thay vì `"Trường không tồn tại"`.

**`TeacherList.tsx`** — cột bảng đổi tên **"Trường có thể dạy"** →
**"Xã/phường có thể dạy"**, nội dung đổi từ `teacher.allowedSchools` sang
`teacher.allowedWards`. Lý do đổi cả nội dung hiển thị chứ không chỉ đổi
input: `allowedSchools` giờ là danh sách suy ra, có thể rất dài (một xã/phường
có hàng chục trường) — hiện theo `allowedWards` (gọn, đúng cái Nhân sự vừa
chọn) mới đúng ngữ cảnh thao tác, tránh bảng bị vỡ layout vì liệt kê 40+
trường trên 1 dòng.

Bộ lọc **"Tất cả trường"** ở đầu danh sách (`schoolId` query param, lọc theo
`teaching_schedules` — trường **đã lên lịch thật**, khác hẳn khái niệm "trường
được phép dạy") — **giữ nguyên, không đổi**, vẫn lọc theo trường như cũ.

**`types/teaching.ts`** — `Teacher` có thêm `wardIds`/`allowedWards`;
`schoolIds`/`allowedSchools` giữ lại với comment nói rõ là suy ra động, chỉ
để hiển thị. `TeacherPayload` đổi `schoolIds?` → `wardIds?`.

## 3. Không đổi

- Mọi nơi khác đang đọc `teacher.schoolIds`/`allowedSchools` để hiển thị (gợi
  ý giáo viên, chấm công...) — **không cần sửa gì**, dữ liệu vẫn đúng hình
  dạng cũ, chỉ khác nguồn.
- Giáo viên tự xem hồ sơ (`GET /teachers/me` — dùng cho Zalo Mini App) —
  **không có field này**, response chỉ gồm tên/SĐT/email/avatar/vị trí, không
  liên quan tới trường hay xã/phường. Không cần đụng tới Mini App cho thay đổi
  này.

## 4. Nghiệm thu

- [ ] Mở "Thêm giáo viên" → thấy ô "Xã/phường có thể dạy" (không còn ô chọn
      trường lẻ), chọn 1 xã/phường rồi lưu → mở lại thấy đúng xã/phường đã
      chọn, cột danh sách hiện đúng tên xã/phường đó.
- [ ] Sửa một giáo viên đã có xã/phường từ trước (dữ liệu cũ đã migrate từ
      `schoolIds`) → ô chọn phải hiện sẵn đúng xã/phường tương ứng, không
      trống.
- [ ] Bỏ trống toàn bộ lựa chọn rồi lưu → giáo viên không còn bị giới hạn xã/
      phường (giống hành vi "không giới hạn trường" cũ).
- [ ] Chọn 1 xã/phường có nhiều trường, mở màn "Gợi ý giáo viên" cho một
      trường thuộc xã/phường đó → giáo viên vẫn được đề xuất bình thường
      (đủ điều kiện tiêu chí "trường được dạy").
