# PROMPT: CẬP NHẬT ZALO MINI APP — GIỜ TIẾT HỌC KHAI RIÊNG THEO TỪNG TRƯỜNG

Bạn là Senior Frontend Developer phụ trách Zalo Mini App dành cho giáo viên. Backend đã cho **mỗi trường khai bảng giờ tiết của riêng mình** (Tiết 1 trường A là 07:00, trường B là 07:15, trường C là 07:30). Mini App hiện vẫn đang hiểu "tiết" theo một bảng giờ cố định nên hiển thị sai tiết / sai buổi. Hãy cập nhật, tái sử dụng layout, API client, auth, cache, toast và design system hiện có.

Đây là thay đổi **hiển thị**. Không đổi luồng check-in/check-out, không đổi payload gửi lên, không thêm màn hình quản trị (bảng tiết do web quản trị khai).

---

## 0. Vì sao

Mỗi trường có khung giờ riêng — có trường vào học 07:00, có trường 07:15, có trường 07:30; giờ ra chơi và số tiết mỗi buổi cũng khác nhau. Trước đây Mini App (và cả BE) coi như mọi trường dùng chung một bảng giờ, nên:

- Buổi dạy 08:00–08:45 bị gắn nhãn "Tiết 1" trong khi ở trường đó đấy là **tiết 2**.
- Giáo viên dạy 2 trường trong ngày thấy hai buổi cùng nhãn "Tiết 2" nhưng thực tế lệch giờ 15–30 phút.
- Nhãn buổi Sáng/Chiều suy từ mốc 12:00 nên sai ở trường có tiết chiều bắt đầu sớm.

Từ nay bảng tiết là **dữ liệu của trường**, đọc qua API. Mini App không được đoán.

---

## 1. Nền tảng

- **Base URL**: `<API_HOST>` — **KHÔNG có prefix `/api`**.
- **Auth**: JWT Bearer cho mọi request. Token giáo viên (`giaovien_congty` / `giaovien_ctv`) gọi được API bảng tiết — đã kiểm chứng thật, không cần quyền Nhân sự.
- Các endpoint lịch dạy **giữ nguyên đường dẫn và payload**: `GET /teaching-sessions/me`, `GET /teaching-sessions/:id`, `POST /teaching-sessions/:id/checkin`, `/checkout`, `/lesson`.

---

## 2. API cần dùng: bảng tiết của một trường

### `GET /schools/:schoolId/periods`

**Headers:** `Authorization: Bearer <token>`
**Response 200:** mảng, đã sắp sẵn theo `periodNo` tăng dần.

```ts
type SchoolPeriod = {
  id: number;
  schoolId: number;
  /** Số thứ tự DÒNG trong bảng tiết của trường (1..30), tính chung cả sáng lẫn chiều
   *  và tính cả dòng ra chơi. KHÔNG PHẢI số tiết để hiển thị. */
  periodNo: number;
  /** "HH:mm" */
  startTime: string;
  /** "HH:mm" */
  endTime: string;
  /** Nhãn hiển thị: "1", "2", "RA CHƠI"… Có thể null. */
  label: string | null;
  /** Buổi trong ngày theo khai báo của trường. */
  session: 'SANG' | 'CHIEU';
  /** false = dòng giờ ra chơi, không có tiết dạy nào rơi vào đây. */
  isPeriod: boolean;
};
```

**Các mã trả về khác:**

| Status | Khi nào | Mini App xử lý |
|---|---|---|
| `200` với mảng rỗng `[]` | Trường chưa khai bảng tiết | Không hiện nhãn tiết, chỉ hiện giờ — **giống hệt giao diện hiện tại** |
| `401` | Thiếu/hết hạn token | Theo luồng refresh/đăng nhập lại hiện có |
| `404` `{"message":"Trường không tồn tại"}` | schoolId sai | Coi như không có bảng tiết, **không** hiện toast lỗi |

⚠️ Hiện chỉ **34/266 trường** đã khai bảng tiết. Nhánh "không có bảng tiết" là nhánh phổ biến nhất, phải bảo đảm nó hiển thị y như trước khi có thay đổi này.

---

## 3. ⚠️ Buổi dạy KHÔNG trả về số tiết — Mini App phải tự đối chiếu

Response của `GET /teaching-sessions/me` và `GET /teaching-sessions/:id` **không có** `periodNo`, `periodLabel` hay `session`. Nó chỉ có giờ thật:

```json
{
  "id": 10096,
  "schoolId": 448,
  "schoolName": "THCS Lạc Hồng",
  "date": "2026-09-01",
  "startTime": "08:00",
  "endTime": "08:45",
  "periods": 1
}
```

`periods` là **số lượng tiết** của buổi dạy (1, 2, 3…), **không phải số thứ tự tiết**. Đừng render `periods` thành "Tiết 1".

Muốn hiện "Tiết mấy" thì phải lấy bảng tiết của `schoolId` rồi đối chiếu theo giờ (mục 4).

---

## 4. Quy tắc đối chiếu giờ → tiết

**Chỉ khớp bằng so sánh CHÍNH XÁC chuỗi `HH:mm`. Cấm khớp theo kiểu "giờ buổi dạy nằm trong khoảng của tiết".** Dữ liệu thật có dòng chồng giờ (trường 448: dòng "RA CHƠI" 14:50–15:20 chồng lên tiết 2 chiều 15:00–15:45), khớp theo khoảng sẽ ra "RA CHƠI".

```ts
type PeriodMatch = {
  label: string;        // "2" hoặc "2–3"
  session: 'SANG' | 'CHIEU';
  text: string;         // "Sáng · Tiết 2"
} | null;

function matchPeriod(session: TeachingSession, periods: SchoolPeriod[]): PeriodMatch {
  if (!periods?.length) return null;

  // Dòng ra chơi không bao giờ là tiết dạy — loại trước khi khớp.
  const rows = periods.filter((p) => p.isPeriod);

  const hhmm = (t: string) => t.slice(0, 5);       // chịu cả "08:00:00"
  const start = hhmm(session.startTime);
  const end = hhmm(session.endTime);

  // Nếu có nhiều dòng cùng giờ bắt đầu, ưu tiên dòng cùng buổi với giờ đó.
  const buoiTheoGio = Number(start.slice(0, 2)) < 12 ? 'SANG' : 'CHIEU';
  const pick = (list: SchoolPeriod[]) =>
    list.find((p) => p.session === buoiTheoGio) ?? list[0] ?? null;

  const startRow = pick(rows.filter((p) => hhmm(p.startTime) === start));
  if (!startRow?.label) return null;               // không khớp → chỉ hiện giờ

  const endRow = pick(rows.filter((p) => hhmm(p.endTime) === end));

  const label =
    endRow?.label && endRow.id !== startRow.id && endRow.periodNo > startRow.periodNo
      ? `${startRow.label}–${endRow.label}`        // buổi dạy gộp nhiều tiết
      : startRow.label;

  const buoi = startRow.session === 'CHIEU' ? 'Chiều' : 'Sáng';
  return { label, session: startRow.session, text: `${buoi} · Tiết ${label}` };
}
```

Ba điều bắt buộc:

1. **Hiển thị `label`, tuyệt đối không hiển thị `periodNo`.** `periodNo` là số dòng nội bộ tính cả giờ ra chơi và cả buổi chiều — ở trường 448, "tiết 2 chiều" có `periodNo = 9`. Hiện "Tiết 9" là sai với thứ giáo viên nhìn thấy trên thời khoá biểu.
2. **Buổi (Sáng/Chiều) lấy từ `session` của dòng khớp được**, chỉ khi không khớp mới suy từ mốc 12:00.
3. **Không khớp được → hiện giờ như hiện tại, không hiện "Tiết ?" hay "—".** Không toast, không log lỗi cho người dùng.

**Luôn hiện giờ kèm nhãn tiết**, đừng thay giờ bằng nhãn tiết: cùng "Tiết 2" nhưng trường 376 là 07:30–08:10 còn trường 448 là 08:00–08:45, giáo viên dạy 2 trường trong ngày cần thấy giờ thật để không đi trễ.

```
Sáng · Tiết 2   08:00 – 08:45
```

---

## 5. ⚠️ Xoá mọi bảng giờ tiết cứng trong Mini App

Đây mới là nguyên nhân gốc. Hãy tìm và loại bỏ toàn bộ:

- Hằng số kiểu `PERIOD_TIMES`, `TIET_MAP`, `LESSON_SLOTS`, mảng `['07:30','08:15',…]`, hoặc bất kỳ chỗ nào suy tiết từ giờ bằng công thức (`Math.floor((phút - 450) / 45) + 1`).
- Hàm đặt tên kiểu `getPeriodByTime()`, `periodOf()` tự chế — thay bằng `matchPeriod()` ở mục 4.
- Nhãn buổi suy từ 12:00 ở nơi đã có bảng tiết (giữ lại làm fallback, xem mục 4).
- Mọi chỗ giả định "tiết kế tiếp cách tiết trước 45 phút" khi dựng nhắc lịch/đếm ngược.

**Không** tự tính lại giờ bắt đầu buổi dạy từ bảng tiết. `startTime`/`endTime` của buổi dạy là nguồn sự thật cho mọi tính toán (đếm ngược, cửa sổ cho phép check-in, sắp xếp). Bảng tiết chỉ dùng để **đặt tên** cho khung giờ đó.

---

## 6. Nơi cần cập nhật trong Mini App

1. **Danh sách lịch dạy của tôi** — mỗi dòng: thêm nhãn `Sáng · Tiết 2` cạnh/trên dòng giờ.
2. **Chi tiết buổi dạy** — thêm dòng thông tin "Tiết", đặt cạnh dòng giờ. Ẩn hoàn toàn khi không khớp được.
3. **Màn check-in / check-out** — phụ đề nêu rõ đang chấm công cho tiết nào, kèm giờ.
4. **Nhắc lịch / thông báo đẩy dựng ở FE** (nếu có) — thay nhãn tiết cứng bằng nhãn khớp từ bảng tiết; không khớp thì chỉ đọc giờ.
5. **Màn xin dạy tiết đang mở** (nếu có) — hiện nhãn tiết của trường đó để giáo viên biết đúng khung giờ.

Nếu Mini App đang nhóm lịch theo "buổi sáng / buổi chiều", hãy nhóm theo `session` của dòng khớp được, fallback về mốc 12:00 cho trường chưa khai bảng tiết.

---

## 7. Cache & hiệu năng

- **Gọi theo trường, không gọi theo buổi.** Từ danh sách lịch, gom `schoolId` **duy nhất** rồi `Promise.all` một lượt. Một tuần lịch 20 buổi thường chỉ có 2–4 trường.
- Cache trong bộ nhớ theo `schoolId` cho suốt phiên; nếu đã có lớp storage sẵn thì lưu kèm TTL ~24 giờ. Bảng tiết gần như không đổi trong năm học.
- Cache cả kết quả rỗng `[]` và cả `404` (dưới dạng "trường này không có bảng tiết") để khỏi gọi lại mỗi lần cuộn danh sách.
- Bảng tiết tải **không đồng bộ với lịch dạy**: render danh sách ngay bằng giờ, nhãn tiết hiện thêm khi có dữ liệu. Không được chặn màn hình chờ API bảng tiết, và không được để lỗi API này làm hỏng màn lịch dạy.

---

## 8. Trường hợp biên (đều có trong dữ liệu thật)

| Tình huống | Xử lý đúng |
|---|---|
| Trường chưa khai bảng tiết (`[]`) | Giao diện y hệt hiện tại, chỉ có giờ |
| Giờ buổi dạy không trùng dòng nào | Chỉ hiện giờ, không đoán tiết gần nhất |
| Bảng tiết có dòng chồng giờ | Vẫn khớp chính xác theo `startTime`; không "sửa" dữ liệu ở FE |
| `label` là `null` | Coi như không khớp |
| `label` là chữ ("RA CHƠI") | Đã bị loại bởi `isPeriod === false`; nếu vẫn lọt thì hiện nguyên văn `label`, không thêm chữ "Tiết" |
| Buổi dạy gộp nhiều tiết (`periods > 1`) | Nhãn dạng "Tiết 2–3" khi khớp được cả hai đầu, ngược lại chỉ hiện tiết đầu |
| Giờ trả về dạng `"08:00:00"` | Cắt còn `HH:mm` trước khi so sánh |

---

## 9. Nghiệm thu

- [ ] Buổi 08:00–08:45 tại trường 448 hiện **"Sáng · Tiết 2"**, không phải "Tiết 1".
- [ ] Cùng nhãn "Tiết 2" ở hai trường khác nhau vẫn hiện đúng hai khung giờ khác nhau (376: 07:30–08:10, 448: 08:00–08:45).
- [ ] Buổi dạy tại trường chưa khai bảng tiết: giao diện **giống hệt trước khi có thay đổi này**, không có dòng thừa, không toast lỗi.
- [ ] Không còn hằng số giờ tiết cứng nào trong source (grep các từ khoá ở mục 5 ra rỗng).
- [ ] Không có màn nào gọi `/schools/:id/periods` nhiều lần cho cùng một trường trong một lần mở app (kiểm tra tab Network).
- [ ] API bảng tiết lỗi/timeout → lịch dạy vẫn render đầy đủ bằng giờ.
- [ ] Nhãn tiết dài ("Tiết 2–3") không làm vỡ layout dòng lịch.

---

## 10. Kiểm chứng phía backend (đã chạy thật trên môi trường dev)

`GET /schools/448/periods` bằng token giáo viên → `200`:

```json
[
  {"id":2349,"schoolId":448,"periodNo":1,"startTime":"07:15","endTime":"08:00","label":"1","session":"SANG","isPeriod":true},
  {"id":2350,"schoolId":448,"periodNo":2,"startTime":"08:00","endTime":"08:45","label":"2","session":"SANG","isPeriod":true},
  {"id":2351,"schoolId":448,"periodNo":3,"startTime":"08:45","endTime":"09:15","label":"RA CHƠI","session":"SANG","isPeriod":false},
  {"id":2352,"schoolId":448,"periodNo":4,"startTime":"09:15","endTime":"10:00","label":"3","session":"SANG","isPeriod":true},
  {"id":2355,"schoolId":448,"periodNo":7,"startTime":"13:30","endTime":"14:05","label":"1","session":"CHIEU","isPeriod":true},
  {"id":2356,"schoolId":448,"periodNo":8,"startTime":"14:50","endTime":"15:20","label":"RA CHƠI","session":"CHIEU","isPeriod":false},
  {"id":2357,"schoolId":448,"periodNo":9,"startTime":"15:00","endTime":"15:45","label":"2","session":"CHIEU","isPeriod":true}
]
```

`GET /teaching-sessions/me?fromDate=2026-09-01&toDate=2026-09-01` cùng token → buổi dạy tương ứng:

```json
{
  "id": 10096,
  "schoolId": 448,
  "schoolName": "THCS Lạc Hồng",
  "className": "8/3 CS2",
  "date": "2026-09-01",
  "startTime": "08:00",
  "endTime": "08:45",
  "periods": 1
}
```

→ Kết quả đúng phải hiện: **Sáng · Tiết 2 · 08:00 – 08:45**.

Đối chiếu chéo, `GET /schools/376/periods` (một trường khác) bắt đầu từ 07:00 và "Tiết 2" của trường này là 07:30–08:10 — cùng một nhãn, khác giờ. Đây chính là lý do không được dùng bảng giờ cứng.

Ba dòng cần chú ý trong dữ liệu thật ở trên: dòng "RA CHƠI" (`isPeriod: false`) phải bị loại khi khớp; "RA CHƠI" chiều 14:50–15:20 **chồng giờ** với tiết 2 chiều 15:00–15:45; và tiết 2 chiều có `periodNo = 9` — hiện "Tiết 9" là sai.
