# PROMPT: FRONTEND — PHÂN KHU VỰC CHO NHÂN VIÊN

Bạn là Senior Frontend Developer. Màn **phân khu vực cho nhân viên** đang có triệu chứng: bấm lưu thấy thành công nhưng bảng `employee_region` không có dòng nào.

> ⚠️ **Nguyên nhân gốc nằm ở backend, đã sửa xong.** Rất có thể FE không cần đổi gì. Tài liệu này để bạn **đối chiếu** FE với hợp đồng API đúng, và xử lý một cạm bẫy còn lại ở mục 3.

## 0. Chuyện gì đã xảy ra

Controller `employees` bật `ValidationPipe({ whitelist: true })`. Cơ chế `whitelist` **xoá mọi thuộc tính không có decorator validate**. Mà `AssignRegionDto` khi đó không có decorator nào:

```ts
export class AssignRegionDto {
    employeeId!: number;   // không decorator
    provinceIds!: number[]; // không decorator
    wardIds!: number[];     // không decorator
}
```

Kết quả: payload FE gửi lên bị xoá sạch trước khi tới service. `wardIds` thành `undefined`, service tra `In([])` không ra ward nào, trả về `[]` kèm **HTTP 201**.

FE nhận 201, hiện "Lưu thành công". Database không có gì. Không log lỗi, không có dấu vết.

Đã sửa bằng cách thêm decorator đầy đủ cho DTO. Kiểm chứng trên máy:

```
Trước sửa:  POST {employeeId:22, wardIds:[439,440]}  →  []          · 0 dòng trong DB
Sau sửa:    POST {employeeId:22, wardIds:[439,440]}  →  2 bản ghi   · 2 dòng trong DB
```

## 1. Hợp đồng API

**Base URL**: `VITE_API_URL`, không có prefix `/api`. Auth: JWT Bearer.

### Gán khu vực

**POST** `/employees/assign-region`

Chú ý **`employees`** số nhiều — nếu FE đang gọi `/employee/assign-region` thì nhận 404.

```json
{ "employeeId": 22, "wardIds": [439, 440] }
```

| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `employeeId` | ✅ | số nguyên ≥ 1 |
| `wardIds` | — | mảng số nguyên, tối đa 500 |
| `provinceIds` | — | **backend hiện KHÔNG dùng** — xem mục 3 |

Trả về **mảng các bản ghi vừa tạo**:

```json
[
  { "id": 518, "employeeId": 22, "provinceId": 6, "wardId": 439 },
  { "id": 519, "employeeId": 22, "provinceId": 6, "wardId": 440 }
]
```

`provinceId` do backend tự suy ra từ ward — FE không cần gửi.

### Đọc lại

| Method | Path |
|---|---|
| GET | `/regions/regions-by-employee/:employeeId` |
| GET | `/provinces/provinces-by-employee/:employeeId` |
| GET | `/provinces/available-provinces/:employeeId` |

### Các thao tác khác

| Method | Path | Việc |
|---|---|---|
| POST | `/provinces/add-many-to-province` | gán nhiều tỉnh |
| DELETE | `/provinces/remove-province` | bỏ một tỉnh |
| POST | `/provinces/handover` | bàn giao khu vực |
| DELETE | `/provinces` | thu hồi tỉnh |
| DELETE | `/wards` | thu hồi phường/xã |

## 2. Mảng rỗng KHÔNG phải là lỗi

Endpoint chỉ trả về **những dòng vừa được tạo mới**. Ward nào nhân viên đã có thì bỏ qua. Nên:

```
gọi lần 1 với [439,440]  →  2 bản ghi
gọi lần 2 với [439,440]  →  []          ← đúng, không phải lỗi
gọi thêm với [455]       →  1 bản ghi
```

**Đừng hiển thị `[]` là thất bại.** Thao tác có tính idempotent. Cách hiển thị đúng:

```ts
const created = await assignRegion({ employeeId, wardIds });
toast.success(
  created.length > 0
    ? `Đã thêm ${created.length} khu vực`
    : "Các khu vực đã chọn đều đã được gán trước đó",
);
// Sau đó gọi lại GET để lấy trạng thái thật, đừng suy từ response
await refetchRegions(employeeId);
```

Vì response chỉ chứa phần **mới thêm**, không phải toàn bộ khu vực của nhân viên — muốn hiện danh sách đầy đủ thì phải gọi lại endpoint đọc.

## 3. Cạm bẫy còn lại: chọn theo tỉnh không lưu gì

`assignRegion` ở backend **chỉ đọc `wardIds`**, hoàn toàn bỏ qua `provinceIds`.

Nghĩa là nếu giao diện cho phép tick **cả một tỉnh** rồi gửi `{ employeeId, provinceIds: [6] }`, backend trả `[]` và không lưu gì — đúng triệu chứng cũ, và lần này **không phải lỗi backend**.

Hai cách xử lý, chọn một:

**Cách A — FE tự bung tỉnh ra ward (khuyến nghị).** Tick một tỉnh thì lấy toàn bộ ward của tỉnh đó rồi gửi trong `wardIds`. Giữ nguyên backend, và dữ liệu lưu ở mức ward nên sau này thu hồi từng phường vẫn được.

```ts
const wardIds = selectedProvinces.flatMap((p) => wardsByProvince[p.id].map((w) => w.id));
await assignRegion({ employeeId, wardIds: [...new Set([...wardIds, ...selectedWardIds])] });
```

**Cách B — dùng endpoint riêng cho tỉnh.** `POST /provinces/add-many-to-province` xử lý mức tỉnh. Nếu chọn cách này, đừng gửi `provinceIds` vào `/employees/assign-region` nữa để khỏi tưởng nó có tác dụng.

Nếu FE đang gửi `provinceIds` vào `assign-region` và trông chờ nó lưu — **đó chính là chỗ cần sửa**.

## 4. Lỗi validate mới

Sau khi thêm decorator, payload sai giờ nhận **400** kèm thông báo, thay vì âm thầm trả `[]`:

| Payload | Kết quả |
|---|---|
| thiếu `employeeId` | 400 `employeeId must not be less than 1` |
| `wardIds: ["abc"]` | 400 `each value in wardIds must not be less than 1` |
| `wardIds: ["439"]` | OK — chuỗi số được tự ép về số |
| không gửi `wardIds` | OK, trả `[]` |

Đây là cải thiện: trước kia mọi payload sai đều ra 201 + `[]`. Giờ FE gửi sai sẽ biết ngay. Dùng `getApiErrorMessage` để hiện nguyên văn.

## 5. Nghiệm thu

- [ ] Gán 2 phường cho một nhân viên → toast báo đã thêm 2, danh sách sau khi refetch hiện đủ 2.
- [ ] Gán lại đúng 2 phường đó → không báo lỗi, thông báo "đã được gán trước đó", danh sách không nhân đôi.
- [ ] Gán thêm 1 phường mới → danh sách thành 3.
- [ ] **Tick cả một tỉnh rồi lưu → kiểm tra trong DB có dòng mới không.** Nếu không có, FE đang rơi vào mục 3.
- [ ] Gửi payload thiếu `employeeId` (qua DevTools) → nhận 400, FE hiện thông báo chứ không im lặng.
- [ ] Đối chiếu đường dẫn: `/employees/assign-region` (số nhiều), không phải `/employee/...`.
- [ ] Build không lỗi TypeScript.

## 6. Cách tự kiểm chứng bằng database

Triệu chứng của lỗi này là "báo thành công nhưng không lưu", nên **đừng tin giao diện** — soi thẳng bảng:

```sql
SELECT id, employee_id, province_id, ward_id
FROM employee_region
WHERE employee_id = <id nhân viên>
ORDER BY id;
```

Bấm lưu trên giao diện rồi chạy lại câu này. Số dòng không tăng nghĩa là chưa tới được database, dù toast nói gì.
