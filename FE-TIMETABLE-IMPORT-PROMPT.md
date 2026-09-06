# PROMPT: FRONTEND — NHẬP THỜI KHOÁ BIỂU BẰNG ẢNH CHỤP

Bạn là Senior Frontend Developer. Backend vừa có module mới: Nhân sự **chụp ảnh tờ thời khoá biểu gửi lên**, hệ thống đọc ảnh, hỏi lại phần còn thiếu qua chat, rồi tạo lớp và xếp lịch hàng loạt.

Hãy dựng màn hình này theo tài liệu dưới đây.

> ⚠️ **Không phải breaking change.** Toàn bộ màn hình Giảng dạy hiện tại giữ nguyên. Đây là màn mới, thêm vào menu Nhân sự.

## 0. Bối cảnh — vì sao luồng lại có 3 bước

Một tờ thời khoá biểu môn phụ ở trường tiểu học có khoảng 28 lớp, mỗi lớp 1 tiết/tuần. Gõ tay là 28 lần mở form. Ảnh chụp thì đọc được trong một lần.

Nhưng ảnh chụp **không bao giờ đủ thông tin**. Tờ mẫu thật cho thấy ba chỗ hổng, và cả ba đều lặp lại ở hầu hết các tờ khác:

- Bảng giờ buổi chiều bị cắt mất khi chụp.
- Tờ chỉ ghi chức danh *"GV DẠY GDKNCDS"*, không ghi tên giáo viên.
- Không có ngày kết thúc áp dụng.

Nên luồng là **đọc ảnh → hỏi cho đủ → xác nhận rồi mới ghi**:

```
1. POST /timetable-import              gửi ảnh   → bản nháp + bảng preview
2. POST /timetable-import/:id/messages chat      → điền phần ảnh không có
3. POST /timetable-import/:id/commit   xác nhận  → mới thật sự tạo lớp + lịch
```

**Mô hình AI chỉ tham gia bước 1 và 2, và chỉ đề xuất.** Bước 3 chạy bằng code thường, đi qua đúng các service tạo lớp/xếp lịch sẵn có. Hệ quả cho FE: **bảng preview là chốt chặn duy nhất giữa một ô đọc sai và 28 bản ghi sai trong database.** Thiết kế màn hình phải lấy việc "Nhân sự soi lại được" làm mục tiêu số một, chứ không phải "bấm cho nhanh".

---

## 1. Nền tảng

- **Base URL**: `VITE_API_URL` — **KHÔNG có prefix `/api`**. Dùng instance sẵn có `@/service/api`.
- **Auth**: JWT Bearer (interceptor đã tự gắn).
- **Role**: chỉ `nhansu`. Các role chỉ-xem (`director`, `troly_gd`, `ketoan_truong`…) gọi vào sẽ bị **403** — đừng hiện menu cho họ.
- Đặt code API mới trong `@/service/teaching.ts` (thêm `timetableImportApi`), type trong `@/types/teaching.ts`.

> ⏱ **Bước 1 chậm.** Đọc một ảnh mất khoảng **20–60 giây**. `api` hiện không set `timeout` nên mặc định là không giới hạn — **giữ nguyên như vậy**, đừng thêm timeout cho riêng lời gọi này. Bắt buộc có UI chờ và chặn double-submit.

---

## 2. API

### 2.1 Gửi ảnh

**POST** `/timetable-import` — `multipart/form-data`, field tên **`image`**, tối đa **15 MB**, nhận JPEG/PNG/WebP/GIF.

```ts
const form = new FormData();
form.append("image", file);
const res = await api.post("/timetable-import", form);
```

Trả về `DraftView` (mục 3).

### 2.2 Chat bổ sung

**POST** `/timetable-import/:id/messages`

```json
{ "message": "Cô Lê Thị Hồng Diễm, chiều bắt đầu 13:30, áp dụng đến 31/05/2026" }
```

Tin nhắn có thể vừa bổ sung thông tin thiếu, vừa chỉnh trực tiếp bảng preview. Ví dụ:

- `Đổi lớp 2A sáng thứ Hai tiết 1 thành lớp 2B.`
- `Chuyển lớp 3C từ chiều thứ Tư tiết 2 sang tiết 3.`
- `Xoá lớp 4A sáng thứ Sáu tiết 1.`
- `Thêm lớp 5B vào sáng thứ Ba tiết 2.`

Sau mỗi tin nhắn, render lại cả `messages` và `preview` từ response. Backend chỉ áp UPDATE/DELETE khi câu lệnh xác định duy nhất một ô; nếu mơ hồ, AI sẽ yêu cầu Nhân sự nói rõ hơn.

Trả về `DraftView` đã cập nhật — **bao gồm cả `preview` mới**. Không cần gọi lại GET.

### 2.3 Xác nhận tạo dữ liệu

**POST** `/timetable-import/:id/commit` — body rỗng. Trả về `DraftView` với `status: "COMMITTED"` và `commitResult`.

**400** kèm `code: "TIMETABLE_DRAFT_INCOMPLETE"` nếu còn thiếu thông tin hoặc còn lỗi — body có `blockers` và `needs` để hiện lại.

### 2.4 Xem lại / Huỷ

**GET** `/timetable-import/:id` → `DraftView`
**POST** `/timetable-import/:id/cancel` → `{ "ok": true }`. Đã commit thì **409**.

---

## 3. Kiểu dữ liệu

```ts
export interface DraftView {
  draftId: number;
  status: "DRAFT" | "COMMITTED" | "CANCELLED";
  preview: TimetablePreview;
  messages: { role: "user" | "assistant"; text: string; at: string }[];
  commitResult?: CommitResult;
}

export interface TimetablePreview {
  rows: PreviewRow[];
  resolution: DraftResolution;
  /** Số lớp đã tồn tại được dùng lại. */
  existingClassCount: number;
  /** Tên các lớp SẼ ĐƯỢC TẠO MỚI khi bấm xác nhận. Phải hiện rõ cho Nhân sự. */
  newClassNames: string[];
  /** Tổng số mẫu lịch sẽ tạo. */
  scheduleCount: number;
  stats: {
    totalEntries: number;
    distinctClasses: number;
    lowConfidenceEntries: number;
    /** true = mỗi lớp đúng 1 tiết/tuần. */
    oneLessonPerClass: boolean;
  };
  /** ERROR — chặn xác nhận. */
  blockers: TimetableIssue[];
  /** WARN — cảnh báo, vẫn xác nhận được. */
  warnings: TimetableIssue[];
  /** INFO — thông tin thêm. */
  notes: TimetableIssue[];
  /** Thông tin còn thiếu, kèm sẵn lựa chọn. */
  needs: PreviewNeed[];
  /** Nguồn sự thật duy nhất cho việc bật/tắt nút Xác nhận. */
  canCommit: boolean;
}

export interface PreviewRow {
  className: string;
  /** null = lớp chưa tồn tại, sẽ được tạo khi xác nhận. */
  classId: number | null;
  dayOfWeek: number;            // 2 = Thứ Hai … 7 = Thứ Bảy, 8 = Chủ Nhật
  dayOfWeekLabel: string;       // "Thứ Hai"
  session: "SANG" | "CHIEU";
  period: number;               // số tiết trong buổi
  startTime: string | null;     // "07:30" — null khi chưa có khung giờ
  endTime: string | null;
  /** "low" = model tự nhận đọc chưa chắc. Phải làm nổi bật trong lưới. */
  confidence: "high" | "low";
}

export interface DraftResolution {
  schoolId: number | null;
  schoolName: string | null;
  subjectId: number | null;
  subjectName: string | null;
  teacherId: number | null;
  teacherName: string | null;
  schoolYear: string | null;
  effectiveFrom: string | null;      // "2025-11-10"
  effectiveTo: string | null;
  /** true = Nhân sự đã chốt "chạy vô thời hạn" (khác hẳn effectiveTo = null nghĩa "chưa hỏi"). */
  effectiveToUnbounded: boolean;
  periodTimes: {
    session: "SANG" | "CHIEU";
    period: number;
    startTime: string;
    endTime: string;
  }[];
}

export interface PreviewNeed {
  field:
    | "schoolId" | "schoolYear" | "subjectId" | "teacherId"
    | "effectiveFrom" | "effectiveTo" | "periodTimes";
  question: string;
  /** Có thì render thành nút bấm nhanh. */
  options?: { id: number; name: string; hint?: string }[];
}

export interface TimetableIssue {
  level: "ERROR" | "WARN" | "INFO";
  code: string;
  message: string;
}

export interface CommitResult {
  committedById: number;
  createdClasses: { name: string; id: number }[];
  scheduleResults: {
    created: number;
    skipped: number;
    sessionsCreated: number;
    results: {
      classId: number;
      className: string | null;
      schoolId: number | null;
      schoolName: string | null;
      status: "CREATED" | "SKIPPED";
      reason?: string;
      subjectId?: number;
      subjectName?: string;
    }[];
  }[];
}
```

### Mã `code` của issue

| `code` | Mức | Ý nghĩa & cách hiện |
|---|---|---|
| `SLOT_COLLISION` | ERROR | Hai lớp cùng một khung giờ — gần như luôn do **đọc lệch hàng**. Tô đỏ đúng ô đó trong lưới. |
| `PERIOD_TIME_MISSING` | ERROR | Thiếu khung giờ cho một tiết. Sẽ có `need` tương ứng. |
| `NO_ENTRIES` | ERROR | Không đọc được tiết nào. Mời chụp lại ảnh rõ hơn. |
| `CLASS_REPEATED` | WARN | Một lớp xuất hiện nhiều lần. Đúng nếu môn dạy nhiều tiết/tuần, sai nếu đọc trùng. |
| `LOW_CONFIDENCE` | WARN | Có ô đọc chưa chắc. Tô vàng các ô `confidence === "low"`. |
| `ONE_LESSON_PER_CLASS` | INFO | Mỗi lớp đúng 1 tiết/tuần — dấu hiệu lưới khớp. |
| `EXTRACTION_NOTE` | INFO | Ghi chú của model về chỗ khó đọc. Hiện nguyên văn. |

> ⚠️ **`stats.oneLessonPerClass === true` KHÔNG có nghĩa là đọc đúng.** Nếu một ô bị đọc tụt xuống nhầm tiết, số lớp vẫn đủ và cờ này vẫn `true` — thứ bắt được lỗi đó là `SLOT_COLLISION`. Đừng dùng cờ này làm dấu tick "đã kiểm tra xong"; nó chỉ là một tín hiệu phụ.

---

## 4. Màn hình

Thêm vào `TEACHING_MENUS` (`Teaching/lib.ts`), path `/nhan-su/nhap-tkb`, đặt **sau "Lịch dạy"**.

### 4.1 Bố cục: ảnh bên trái, lưới bên phải

Đây là quyết định thiết kế quan trọng nhất của màn này.

```
┌──────────────────────┬──────────────────────────────────┐
│                      │  Trường · Môn · GV · Năm học     │
│   ẢNH GỐC            │  ──────────────────────────────  │
│   (zoom/pan được)    │  LƯỚI THỨ × TIẾT                 │
│                      │  (đúng hình dạng tờ giấy)        │
│                      │  ──────────────────────────────  │
│                      │  Cảnh báo · Sẽ tạo N lớp mới     │
├──────────────────────┤  [ Xác nhận tạo ]                │
│  KHUNG CHAT          │                                  │
└──────────────────────┴──────────────────────────────────┘
```

**Bảng preview phải là lưới thứ × tiết, không phải danh sách phẳng.** Một danh sách 28 dòng thì không ai đối chiếu nổi với tấm ảnh; một lưới cùng hình dạng với tờ giấy thì liếc mắt là thấy sai ở đâu. Nhóm `rows` theo `period` (hàng) × `dayOfWeek` + `session` (cột), ô ghi `className`.

Dự án đã có `react-zoom-pan-pinch` — dùng cho khung ảnh để Nhân sự phóng to soi từng ô.

Quy ước tô màu ô:
- **Đỏ** — ô nằm trong `SLOT_COLLISION`.
- **Vàng** — `confidence === "low"`.
- **Viền xanh + nhãn "mới"** — `classId === null` (lớp sẽ được tạo).
- Thường — còn lại.

### 4.2 Bước gửi ảnh

- Kéo thả hoặc chọn file; xem trước ảnh trước khi gửi.
- Chặn client-side: > 15 MB hoặc sai định dạng → báo ngay, đừng để BE trả lỗi.
- Trong lúc chờ: hiện skeleton + dòng chữ *"Đang đọc ảnh, mất khoảng 30 giây…"*. **Disable nút gửi**; gọi lại lần hai là mất tiền gấp đôi.
- Xong thì lưu `draftId` vào URL (`/nhan-su/nhap-tkb/:draftId`) để F5 không mất bản nháp.

### 4.3 Khung chat

Không phải trợ lý hỏi đáp tự do — đây là **điền vào chỗ trống**. UI phải phản ánh đúng điều đó:

- Render `preview.needs` thành danh sách việc còn thiếu, ngay phía trên ô nhập.
- `need.options` có thì render thành **nút bấm nhanh** (tên + `hint`). Bấm một nút = gửi tin nhắn chứa tên đó. Vẫn cho gõ tay tự do.
- Mỗi lần `POST .../messages` trả về là thay luôn cả `messages` và `preview` — lưới bên phải cập nhật theo thời gian thực.
- Hết `needs` thì đổi trạng thái khung chat sang *"Đã đủ thông tin — kiểm lại bảng bên phải rồi bấm Xác nhận"*.

Ví dụ Nhân sự gõ một câu điền nhiều chỗ cùng lúc, hệ thống xử lý được:

> *"Cô Diễm dạy, chiều tiết 1 từ 13:30, mỗi tiết 40 phút, áp dụng đến hết 31/5/2026"*

### 4.4 Trước khi xác nhận

Ngay trên nút, hiện rõ **sẽ ghi những gì**:

```
Trường Tiểu học Phước Hiệp · Công dân số · Lê Thị Hồng Diễm
Áp dụng 10/11/2025 → 31/05/2026

  Lớp dùng lại:   1   (2/4)
  Lớp tạo mới:   27   (1/1, 1/2, 1/3, … xem tất cả)
  Lịch tạo mới:  28

  ✓ 28 tiết cho 28 lớp — mỗi lớp đúng 1 tiết/tuần
```

- Nút **Xác nhận** chỉ bật khi `preview.canCommit === true`. **Đừng tự tính lại điều kiện ở FE** — `canCommit` là nguồn sự thật, FE tính lại là hai bên lệch nhau.
- `canCommit === false` → nút disabled kèm tooltip nêu lý do đầu tiên trong `blockers` hoặc `needs`.
- Có `warnings` mà vẫn commit được → dialog xác nhận lần hai, liệt kê cảnh báo.
- `newClassNames.length > 0` → nói thẳng "sẽ tạo mới N lớp", cho bung xem đủ danh sách. Không được giấu con số này.

### 4.5 Sau khi xác nhận

`status` thành `COMMITTED` → toàn màn chuyển **chỉ đọc**: ẩn ô chat, ẩn nút xác nhận.

Hiện `commitResult`:
- Số lớp đã tạo, số lịch đã tạo (cộng dồn `created` của các phần tử `scheduleResults`).
- Bảng các dòng `status === "SKIPPED"` kèm `reason` — **luôn hiện, không lọc bỏ**. Bị bỏ qua thường là do lịch đã tồn tại hoặc trùng giờ giáo viên; Nhân sự cần biết để đi xử lý.
- Nút sang màn "Lịch dạy" lọc sẵn theo trường + giáo viên vừa xếp.

---

## 5. Lỗi

Tất cả lỗi trả `{ statusCode, code, message }`. **Hiện `message` của BE**, đã viết sẵn tiếng Việt cho người dùng cuối. Dùng `getApiErrorMessage` sẵn có.

| `code` | HTTP | Xử lý riêng ở FE |
|---|---|---|
| `TIMETABLE_AI_NOT_CONFIGURED` | 503 | Chưa cấu hình API key. Hiện empty state cho cả màn, ẩn ô upload — không phải lỗi thao tác của Nhân sự. |
| `TIMETABLE_AI_RATE_LIMITED` | 503 | Cho nút "Thử lại". |
| `TIMETABLE_AI_TRUNCATED` | 503 | Gợi ý cắt ảnh thành nhiều phần nhỏ rồi gửi từng phần. |
| `TIMETABLE_AI_REFUSED` / `TIMETABLE_AI_EMPTY` / `TIMETABLE_AI_INVALID` / `TIMETABLE_AI_ERROR` | 503 | Mời chụp lại rõ hơn. |
| `TIMETABLE_AI_UNAUTHORIZED` | 503 | Key sai — lỗi vận hành, không phải lỗi Nhân sự. Hiện như `_NOT_CONFIGURED`. |
| `TIMETABLE_IMAGE_TOO_LARGE` | 413 | Quá 15 MB. Đáng lẽ đã chặn ở client. |
| `TIMETABLE_IMAGE_REQUIRED` / `TIMETABLE_IMAGE_TYPE_UNSUPPORTED` / `TIMETABLE_IMAGE_INVALID` | 400 | Thiếu file, sai định dạng, hoặc file hỏng. |
| `TIMETABLE_IMAGE_FIELD_INVALID` / `TIMETABLE_IMAGE_UPLOAD_INVALID` | 400 | Gửi sai tên field — phải là `image`. |
| `TIMETABLE_DRAFT_INCOMPLETE` | 400 | Đọc `blockers` + `needs` trong body lỗi, hiện lại rồi kéo về khung chat. |
| `TIMETABLE_DRAFT_CLOSED` / `_COMMITTED` | 409 | Bản nháp đã chốt — reload bằng `GET /timetable-import/:id`. |
| `TIMETABLE_DRAFT_NOT_FOUND` | 404 | Về màn upload. |

---

## 6. Lưu ý khi làm

- **Đừng dựng validate riêng ở FE.** Không tự kiểm trùng giờ, không tự đoán lớp nào cần tạo. BE đã trả `blockers` / `needs` / `canCommit`; FE chỉ hiển thị. Hai nơi cùng validate là hai nơi lệch nhau.
- **Đừng cho sửa trực tiếp ô trong lưới** ở phiên bản này. Muốn sửa thì nói trong chat. API chưa có endpoint sửa từng ô, thêm ô input tại chỗ sẽ tạo cảm giác sửa được nhưng không lưu.
- `dayOfWeek` là quy ước tiếng Việt (2 = Thứ Hai). Đã có sẵn `dayOfWeekLabel`, dùng luôn, đừng tự map.
- `effectiveTo === null` **và** `effectiveToUnbounded === true` nghĩa là "vô thời hạn" — hiện chữ, đừng hiện ô trống.
- `startTime === null` trong một `PreviewRow` là bình thường ở giai đoạn đang chat; hiện "—", đừng crash.

---

## 7. Kiểm thử tay

1. Gửi tấm TKB Phước Hiệp (28 lớp, bảng giờ chiều bị cắt) → lưới hiện 28 ô, có 3 blocker `PERIOD_TIME_MISSING`, nút Xác nhận **tắt**.
2. Chat *"chiều tiết 1 bắt đầu 13:30, mỗi tiết 40 phút, ra chơi 30 phút sau tiết 2"* → blocker biến mất, lưới hiện đủ giờ.
3. Chat *"cô Lê Thị Hồng Diễm"* → `need` giáo viên biến mất; thử gõ tên sai chính tả xem có khớp không.
4. Chat *"không giới hạn"* cho ngày kết thúc → `need` biến mất, phần tóm tắt hiện "vô thời hạn".
5. Đủ thông tin → nút bật, tóm tắt ghi đúng "1 lớp dùng lại, 27 lớp tạo mới, 28 lịch".
6. Bấm Xác nhận → sang chế độ chỉ đọc, hiện kết quả; đối chiếu ở màn "Lịch dạy" phải thấy đủ 28 mẫu lịch.
7. Bấm Xác nhận **lần hai** (hoặc mở 2 tab cùng commit) → phải nhận 409 và reload, không được tạo trùng.
8. F5 giữa chừng → `draftId` trên URL khôi phục đúng trạng thái.
9. Gửi ảnh không phải thời khoá biểu → `NO_ENTRIES`, có lối thoát rõ ràng.
10. Gửi file 20 MB → chặn ngay ở client, không gọi API.
11. Đăng nhập bằng role `director` → không thấy menu; gọi thẳng URL phải nhận 403 và hiện thông báo tử tế.

---

## 8. Một điểm cần biết trước khi tích hợp

Backend đã build sạch và có **17 test tự động** phủ phần logic tất định (so khớp tên trường, kiểm trùng ô giờ, dựng preview, tách lớp cũ/mới). Nhưng **hai lời gọi tới mô hình AI chưa từng chạy thật lần nào** vì máy dev chưa có `OPENAI_API_KEY`.

Nghĩa là hình dạng `DraftView` trong tài liệu này đúng theo type của backend, còn **chất lượng đọc ảnh thì chưa ai đo**. Khuyến nghị:

- Dựng UI trên **mock data trước** — lấy đúng shape ở mục 3.
- Buổi tích hợp thật đầu tiên nên làm chung FE + BE, dùng chính tấm ảnh Phước Hiệp vì đã có đáp án đúng đối chiếu tay (28 lớp, 28 tiết).
- Nếu model đọc lệch, chỗ cần sửa là prompt ở BE (`src/timetable-import/prompts/extract-timetable.prompt.ts`), không phải FE.
