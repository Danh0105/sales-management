# PROMPT: FRONTEND — ROLE GIÁO VỤ

Bạn là Senior Frontend Developer. Backend vừa thêm role **`giaovu`** (Giáo vụ): làm được **mọi việc của Nhân sự trong module Giảng dạy**, trừ một thứ duy nhất — **khai tiền**.

Hãy cập nhật FE theo tài liệu này.

> ⚠️ **Không endpoint nào đổi, không field nào đổi.** Chỉ thêm một role và một ranh giới quyền. Nhưng nếu FE không cập nhật, Giáo vụ sẽ **không thấy menu Giảng dạy** (vì `canManageTeaching()` đang hard-code `nhansu`), và nếu bạn chỉ mở menu mà quên ẩn ô đơn giá thì họ nhập xong bấm lưu sẽ nhận **403**.

## 0. Ranh giới

| | `nhansu` | `giaovu` |
|---|---|---|
| Giáo viên, lớp học, lịch dạy, buổi dạy | ✅ | ✅ |
| Chấm công (trạng thái, ghi chú) | ✅ | ✅ |
| Nhập TKB bằng ảnh | ✅ | ✅ |
| Gán giáo viên, sinh buổi, xếp lịch hàng loạt | ✅ | ✅ |
| **Đơn giá mỗi tiết** (`ratePerPeriod`) | ✅ | ❌ |
| **Đơn giá mặc định giáo viên** (`defaultRatePerPeriod`) | ✅ | ❌ |
| **Phụ cấp khi chấm công** (`otherCosts`) | ✅ | ❌ |

**Giáo vụ vẫn *đọc* được số tiền.** Cột đơn giá, thành tiền, bảng công vẫn hiển thị đầy đủ. Chỉ chặn *ghi*.

**Kiêm nhiệm giữ quyền rộng nhất.** Ai có cả `nhansu` lẫn `giaovu` thì khai tiền được bình thường — cấp thêm role không bao giờ làm mất quyền đang có.

## 1. Phân quyền — sửa ở đúng 3 chỗ

### 1.1 `pages/Teaching/lib.ts`

```ts
// CŨ
export const canManageTeaching = () => hasRole("nhansu");

// MỚI
export const canManageTeaching = () => hasRole("nhansu", "giaovu");

/** Khai tiền: đơn giá tiết, đơn giá giáo viên, phụ cấp. Giáo vụ KHÔNG được. */
export const canSetTeachingRates = () => hasRole("nhansu");
```

Cập nhật luôn `canViewTeaching()` để Giáo vụ vào được các màn chỉ-xem:

```ts
export const canViewTeaching = () =>
  hasRole("nhansu", "giaovu", "director", "director_la", "troly_gd", "ketoan_truong");
```

Và sửa comment ở `TEACHING_MENUS.manageOnly` — hiện đang ghi "Chỉ nhansu thấy", giờ là "nhansu và giaovu".

### 1.2 `utils/nav.ts`

Dòng 23 đang có `"nhansu"` trong danh sách role vào được module. Thêm `"giaovu"` ngay cạnh.

### 1.3 `routes/Teaching.tsx`

Comment dòng 19 và 72 ghi "Chỉ nhansu dùng được" — cập nhật thành "nhansu và giaovu". Logic route dùng `canManageTeaching()` nên tự đúng sau 1.1, nhưng comment sai sẽ khiến người sau sửa nhầm.

## 2. Ẩn ô nhập tiền

Dùng `canSetTeachingRates()` ở đúng 4 chỗ có ô nhập:

| File | Ô cần ẩn |
|---|---|
| `components/TeacherFormModal.tsx` | Đơn giá mỗi tiết (`defaultRatePerPeriod`) |
| `components/ScheduleFormModal.tsx` | Đơn giá mỗi tiết (`ratePerPeriod`) |
| `components/SessionFormModal.tsx` | Đơn giá mỗi tiết (`ratePerPeriod`) |
| `tabs/AttendanceTab.tsx` | Toàn bộ khối **Chi phí khác** (`otherCosts`) |

**Ẩn hẳn ô nhập, không disable.** Ô mờ khiến người dùng tưởng hệ thống lỗi hoặc đi xin quyền; ẩn thì họ hiểu đây không phải việc của mình. Nếu muốn giải thích, để một dòng chú thích nhỏ thay chỗ ô đó:

> *Đơn giá do phòng Nhân sự khai.*

**Quan trọng — không gửi field lên khi đã ẩn.** Backend chặn theo *sự có mặt của field*, kể cả khi giá trị là `null`:

```ts
// SAI — vẫn bị 403 dù người dùng không nhập gì
const payload = { ...form, ratePerPeriod: form.ratePerPeriod ?? null };

// ĐÚNG — không có quyền thì không đưa key vào payload
const payload = { ...form };
if (!canSetTeachingRates()) delete payload.ratePerPeriod;
```

Gợi ý gom thành một helper dùng chung cho cả 4 form, thay vì `delete` rải rác:

```ts
const RATE_FIELDS = [
  "ratePerPeriod",
  "defaultRatePerPeriod",
  "otherCosts",
] as const;

/** Bỏ field tiền khỏi payload khi user không có quyền khai. */
export function stripRateFields<T extends Record<string, unknown>>(payload: T): T {
  if (canSetTeachingRates()) return payload;
  const out = { ...payload };
  for (const f of RATE_FIELDS) delete out[f];
  return out;
}
```

Với endpoint hàng loạt phải bỏ cả trong `items[]` — backend quét cả hai cấp:

```ts
const body = stripRateFields({
  ...batch,
  items: items.map((i) => stripRateFields(i)),
});
```

## 3. Cột và bảng chỉ-đọc — giữ nguyên

**Không ẩn** các chỗ *hiển thị* tiền. Giáo vụ cần thấy để đối chiếu:

- `TeacherList.tsx` — cột Đơn giá
- `tabs/SummaryTab.tsx` — bảng công, `payableAmount` / `otherCostsAmount` / `totalPayableAmount`
- `components/SessionDetailDrawer.tsx` — đơn giá, thành tiền
- `tabs/AttendanceTab.tsx` — cột Chi phí khác (**hiển thị** giữ nguyên, chỉ ẩn phần **sửa**)

## 4. Endpoint có chốt tiền

14 endpoint dưới đây trả **403** nếu payload chứa field tiền mà user không có quyền. Danh sách để bạn rà soát, không phải để gọi khác đi:

```
POST  /teachers                              PATCH /teachers/:id
POST  /school-classes                        PATCH /school-classes/:id
POST  /teaching-schedules                    PATCH /teaching-schedules/:id
POST  /teaching-schedules/bulk               POST  /teaching-schedules/:id/generate-sessions
POST  /teaching-sessions                     PATCH /teaching-sessions/:id
POST  /teaching-sessions/bulk                PATCH /teaching-sessions/:id/assign
PATCH /teaching-sessions/:id/attendance      PATCH /teaching-sessions/attendance/bulk
```

Một số endpoint trong danh sách hiện chưa có field tiền (lớp học, sinh buổi) — chốt gắn sẵn để sau này thêm field là đã được bảo vệ. FE không phải làm gì thêm với chúng.

## 5. Xử lý 403

Thông báo của backend đã đủ ngữ cảnh, hiện nguyên văn qua `getApiErrorMessage`:

```json
{
  "statusCode": 403,
  "message": "Giáo vụ không được khai đơn giá mỗi tiết. Phần tiền do phòng Nhân sự phụ trách."
}
```

Nếu nhiều loại tiền cùng bị đụng, backend gộp trong một câu: *"...không được khai đơn giá mỗi tiết, đơn giá mặc định của giáo viên..."*.

Nhận 403 này sau khi đã làm mục 2 nghĩa là còn sót một form gửi thừa field — **đừng nuốt lỗi**, hiện toast để lộ ra.

Lỗi chung khi role không đủ quyền quản lý đã đổi câu chữ:

> *Chỉ phòng Nhân sự hoặc Giáo vụ được thao tác dữ liệu này*

Nếu FE có hard-code so khớp chuỗi cũ ("Chỉ phòng Nhân sự...") thì sửa lại — nhưng tốt nhất là đừng so khớp message, dùng `statusCode`.

## 6. Điểm dễ bỏ sót

**`giaovu` không phải role chỉ-xem.** Đừng gộp vào nhóm `director`/`troly_gd`. Họ ghi được gần như mọi thứ; ranh giới duy nhất là tiền.

**Menu "Nhập TKB" phải hiện cho Giáo vụ.** Mục này đang gắn `manageOnly: true`, và `teachingMenusForUser()` lọc theo `canManageTeaching()` — sửa 1.1 là tự đúng. Kiểm tra lại để chắc.

**`TimetableImportPage.tsx` dòng 295** có comment và có thể có cả kiểm tra role riêng — rà lại, màn này Giáo vụ dùng được.

**Xoá đơn giá cũng là khai tiền.** Gửi `ratePerPeriod: null` vẫn 403. Form của Giáo vụ không được có đường nào tạo ra key đó.

## 7. Nghiệm thu

Tài khoản thử: **`0900000010` / `123456`** — `Giáo vụ (test)`, đã tạo sẵn trong DB.

- [ ] Đăng nhập Giáo vụ → thấy đủ menu Giảng dạy, kể cả "Nhập TKB".
- [ ] Tạo lớp học, tạo giáo viên (không nhập đơn giá), sửa ghi chú giáo viên → thành công.
- [ ] Form giáo viên **không có** ô Đơn giá mỗi tiết.
- [ ] Form lịch dạy và form buổi dạy **không có** ô Đơn giá.
- [ ] Màn chấm công **không có** phần thêm/sửa Chi phí khác, nhưng **vẫn hiện** cột Chi phí khác của dữ liệu đã có.
- [ ] Chấm công (đổi trạng thái, ghi chú) → thành công.
- [ ] Bảng công vẫn hiển thị đủ tiền cho Giáo vụ.
- [ ] Đăng nhập `nhansu` (`0900000007`) → mọi ô đơn giá và phụ cấp xuất hiện lại, lưu được.
- [ ] Tài khoản có **cả hai** role → hành xử như `nhansu` (thấy đủ ô tiền).
- [ ] Mở DevTools, gửi tay một request có `ratePerPeriod` bằng token Giáo vụ → nhận 403 kèm message tiếng Việt, FE hiện nguyên văn.
- [ ] Build không lỗi TypeScript.

## 8. Kiểm chứng phía backend

Đã chạy end-to-end trên tài khoản `Giáo vụ (test)`:

```
GIÁO VỤ
  tạo lớp học · tạo giáo viên (không giá) · sửa ghi chú   OK
  chấm công (trạng thái) · nhập TKB từ ảnh                OK
  ────────────────────────────────────────────────────────
  tạo/sửa giáo viên KÈM đơn giá                           403
  xếp lịch KÈM đơn giá                                    403
  bulk: đơn giá nằm trong items[]                         403
  gửi ratePerPeriod = null                                403
  chấm công KÈM phụ cấp · bulk KÈM phụ cấp                403

NHÂN SỰ — cùng payload có tiền                            OK
```

12 unit test cho ranh giới role; toàn bộ 487 test của backend đang pass.
