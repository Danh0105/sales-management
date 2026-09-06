# PROMPT: FRONTEND — ÁP CHÍNH SÁCH NĂM TRƯỚC SANG NĂM SAU

Bạn là Senior Frontend Developer. Backend vừa có chức năng: **sao chép môn học + chính sách đã duyệt của một năm học sang năm học tiếp theo** cho một trường.

Việc của bạn: thêm nút **"Áp chính sách năm trước"** vào màn danh sách môn học của trường.

> ⚠️ **Không có breaking change.** Endpoint mới hoàn toàn, không sửa gì cái cũ.

## 0. Vì sao một nút làm hai việc

Chính sách gắn vào **môn của một năm cụ thể** (`policy.subjectId` → `subjects.school_year`). Không có cách nào "dùng lại" chính sách cũ cho năm mới — phải có bản ghi môn của năm mới thì mới có chỗ gắn chính sách.

Nên một lần bấm làm hai việc không tách rời:

1. Tạo môn năm mới, sao chép thông tin từ môn năm cũ (tên, danh mục, sĩ số, số tiết, thời hạn hợp đồng)
2. Sao chép các chính sách **đã được giám đốc duyệt** của môn cũ sang môn mới

Những gì backend **cố ý không** sao chép:

| Trường | Xử lý | Lý do |
|---|---|---|
| `code`, `contractNumber` | sinh mới | suy từ id mới và năm mới (`THABC703\|2025` → `TA804\|2026`) |
| `startDate` | **dời đúng 1 năm** | `2026-05-28` → `2027-05-28`, giữ ngày/tháng khai giảng |
| Chính sách `DRAFT` / `REJECTED` / `PENDING` | **bỏ** | chỉ mang sang cái đã được duyệt |
| `status` của chính sách mới | về **`DRAFT`** | xem mục 5 |
| `currentHistoryId` | bỏ | trỏ vào lịch sử của chính sách năm cũ |

## 1. API

**Base URL**: `VITE_API_URL`, không prefix `/api`. Auth: JWT Bearer.
**Role**: `director`, `director_la`, `saleadmin`, `salesadmin_la` — trùng khít với `canManageSubjects()` sẵn có ở FE, dùng lại được luôn.

### Xem trước

**POST** `/school-year-rollover/preview`

```json
{ "schoolId": 445, "fromYear": "2025-2026", "toYear": "2026-2027" }
```

### Chạy thật

**POST** `/school-year-rollover`

```json
{ "schoolId": 445, "fromYear": "2025-2026", "toYear": "2026-2027", "dryRun": false }
```

> `dryRun` **mặc định `true`**. Quên gửi `dryRun: false` thì không có gì được tạo — và response trông y hệt lúc thành công. Đây là cái bẫy dễ mắc nhất; luôn kiểm `res.dryRun` trước khi báo thành công.

### Response (cả hai endpoint cùng shape)

```ts
interface RolloverResult {
  dryRun: boolean;
  schoolId: number;
  schoolName: string;
  fromYear: string;
  toYear: string;
  subjectsCopied: number;    // số môn được tạo (hoặc sẽ tạo)
  subjectsSkipped: number;   // số môn bỏ qua vì năm đích đã có
  policiesCopied: number;    // tổng chính sách sao chép
  items: RolloverItem[];
}

interface RolloverItem {
  fromSubjectId: number;
  name: string;
  catalogId: number | null;
  /** Số chính sách ĐÃ DUYỆT của năm cũ sẽ đi theo môn này. */
  approvedPolicies: number;
  /** id môn mới; null khi xem trước hoặc khi bị bỏ qua. */
  toSubjectId: number | null;
  status: "COPIED" | "SKIPPED";
  reason?: string;
}
```

Ví dụ thật:

```json
{
  "dryRun": false, "schoolName": "TH ABC",
  "fromYear": "2025-2026", "toYear": "2026-2027",
  "subjectsCopied": 4, "subjectsSkipped": 0, "policiesCopied": 4,
  "items": [
    { "fromSubjectId": 703, "name": "TH ABC", "approvedPolicies": 2, "toSubjectId": 804, "status": "COPIED" },
    { "fromSubjectId": 712, "name": "abc",    "approvedPolicies": 0, "toSubjectId": 805, "status": "COPIED" }
  ]
}
```

Môn không có chính sách duyệt nào **vẫn được tạo** (`approvedPolicies: 0`) — chỉ là không kèm chính sách.

## 2. Đặt nút ở đâu

File: `src/pages/Director/Sales/School/SubjectList.tsx`

Đặt cạnh nút **"Thêm môn"** trong thanh lọc năm học (khoảng dòng 141), dùng chung điều kiện `canManage`:

```tsx
{canManage && (
  <button
    onClick={() => setRolloverOpen(true)}
    className="flex items-center gap-1 px-3 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium active:scale-95 whitespace-nowrap"
  >
    <CopyPlus size={16} /> Áp năm trước
  </button>
)}
```

`CopyPlus` có sẵn trong `lucide-react` (file này đã dùng `Plus`, `Pencil`, `Trash2`).

Thêm service vào `src/service/subject.api.ts`:

```ts
rolloverPreview: async (body: { schoolId: number; fromYear: string; toYear: string }) => {
  const res = await api.post(`/school-year-rollover/preview`, body);
  return res.data;
},
rollover: async (body: { schoolId: number; fromYear: string; toYear: string }) => {
  const res = await api.post(`/school-year-rollover`, { ...body, dryRun: false });
  return res.data;
},
```

Để `dryRun: false` **cố định trong service** thay vì để nơi gọi truyền — quên một lần là người dùng bấm xong tưởng đã tạo mà thực ra không có gì.

## 3. Luồng hai bước, không bấm phát ăn ngay

Đây là thao tác tạo hàng loạt môn học và chính sách. **Bắt buộc xem trước rồi mới xác nhận.**

```
bấm "Áp năm trước"
  → modal: chọn năm nguồn + năm đích
  → gọi /preview
  → hiện bảng: môn nào tạo, kèm mấy chính sách, môn nào bỏ qua vì sao
  → [ Xác nhận tạo ]  → gọi /school-year-rollover
  → load() để làm mới danh sách
```

Bảng xem trước nên hiện đủ:

```
TH ABC:  2025-2026  →  2026-2027

  + TH ABC     2 chính sách đã duyệt
  + abc        không có chính sách
  + 2          không có chính sách
  + 222        2 chính sách đã duyệt

  Sẽ tạo 4 môn và 4 chính sách (ở trạng thái Nháp)
```

## 4. Cạm bẫy: năm đích có thể không chọn được

`schoolYearOptions()` trong file này chỉ sinh các năm **từ năm học hiện tại lùi về 2021**:

```ts
const last = Number(currentSchoolYear().split("-")[0]);
for (let y = last; y >= 2021; y--) years.push(`${y}-${y + 1}`);
```

Hôm nay năm học hiện tại là `2026-2027`, nên danh sách **không có `2027-2028`**. Nếu modal dùng lại `yearOptions` cho ô "năm đích" thì không áp được sang năm chưa tới — đúng cái mà chức năng này sinh ra để làm.

Hai cách xử lý, chọn một:

**Cách A — dùng danh sách riêng cho năm đích (khuyến nghị).** Cho phép thêm 1–2 năm tương lai:

```ts
const targetYearOptions = useMemo(() => {
  const last = Number(currentSchoolYear().split("-")[0]);
  const years: string[] = [];
  for (let y = last + 1; y >= 2021; y--) years.push(`${y}-${y + 1}`);
  return years;
}, []);
```

**Cách B — sửa `schoolYearOptions()` dùng chung.** Gọn hơn nhưng làm ô lọc hiện cả năm chưa có dữ liệu.

Mặc định gợi ý: năm nguồn = năm đang lọc (hoặc năm học hiện tại nếu đang chọn "Tất cả"), năm đích = năm kế tiếp.

## 5. Chính sách sao chép ở trạng thái Nháp

Bản sao về `DRAFT` — số liệu giữ nguyên để khỏi nhập lại, nhưng **vẫn phải đi qua quy trình duyệt của năm mới**. Giá học phí năm ngoái không tự động thành giá năm nay.

Nói rõ điều này ngay trong màn kết quả, đừng để người dùng tưởng đã xong:

> *Đã tạo 4 môn và 4 chính sách ở trạng thái **Nháp**. Vào từng chính sách để gửi duyệt.*

Nếu chỉ báo "Áp dụng thành công" thì vài tuần sau sẽ có người hỏi vì sao chính sách năm mới không dùng được.

## 6. Chạy lại không nhân đôi

Thao tác có tính idempotent. Môn đã có ở năm đích thì bỏ qua:

```
lần 1:  tạo 4 · bỏ qua 0
lần 2:  tạo 0 · bỏ qua 4  ← đúng, không phải lỗi
        reason: "Năm 2026-2027 đã có môn này"
```

**Đừng hiển thị `subjectsCopied: 0` là thất bại.** Hiện `reason` của từng dòng để người dùng hiểu vì sao.

Nhận diện "cùng một môn" ưu tiên `catalogId`; môn cũ chưa gắn danh mục thì so theo tên đã chuẩn hoá.

## 7. Lỗi

Tất cả trả `{ statusCode, message }`, hiện nguyên văn bằng `getApiErrorMessage`.

| Tình huống | HTTP | Message |
|---|---|---|
| Năm nguồn = năm đích | 400 | `Năm học nguồn và năm học đích phải khác nhau` |
| Trường không tồn tại | 400 | `Trường không tồn tại` |
| Năm nguồn không có môn nào | 400 | `Trường chưa có môn học nào trong năm 2030-2031` |
| Thiếu năm học | 400 | `Thiếu năm học nguồn hoặc năm học đích` |
| Role không đủ | 403 | — |

Màn này đã có thói quen nuốt lỗi 403 (`if (err?.response?.status !== 403)`) khi tải danh sách. **Với hành động áp chính sách thì đừng nuốt** — người dùng vừa chủ động bấm nút, im lặng là tệ nhất.

## 8. Nghiệm thu

- [ ] Role `director` / `saleadmin` thấy nút; role chỉ-xem không thấy.
- [ ] Bấm nút → modal mở, năm nguồn mặc định là năm đang lọc, năm đích là năm kế tiếp.
- [ ] **Chọn được năm đích chưa tới** (VD `2027-2028`) — nếu không chọn được, bạn đang dính mục 4.
- [ ] Xem trước hiện đúng số môn và số chính sách của từng môn.
- [ ] Xác nhận → danh sách môn tự làm mới, đổi bộ lọc sang năm đích thấy môn mới.
- [ ] Mở một môn mới → thấy chính sách ở trạng thái **Nháp**, số liệu giống năm cũ.
- [ ] Bấm áp lần hai cùng tham số → báo "bỏ qua N môn", không nhân đôi, không hiện như lỗi.
- [ ] Chọn năm nguồn = năm đích → nhận 400, FE hiện thông báo.
- [ ] Chọn năm nguồn chưa có môn → nhận 400 với tên năm trong thông báo.
- [ ] Build không lỗi TypeScript.

## 9. Kiểm chứng phía backend

Đã chạy thật trên trường **TH ABC** (`schoolId 445`), `2025-2026` → `2026-2027`:

```
môn tạo: 4 · chính sách: 4
  #703 → #804  TH ABC  (2 CS duyệt)
  #712 → #805  abc     (0)
  #713 → #806  2       (0)
  #714 → #807  222     (2 CS duyệt)
```

Đối chiếu database: `start_date` dời đúng 1 năm (`2026-05-28` → `2027-05-28`), `code`/`contractNumber` sinh mới mang năm 2026, sĩ số và số tiết giữ nguyên, chính sách về `DRAFT` với `currentHistoryId` rỗng, `fee` giữ nguyên 490.000 và 80.000.

Môn #703 có 6 chính sách nhưng chỉ 2 cái `DIRECTOR_APPROVED` — đúng 2 cái đó được chép, 4 cái `REJECTED` bị bỏ.

Dữ liệu test đã xoá sau khi kiểm. Toàn bộ 529 test của backend đang pass.
