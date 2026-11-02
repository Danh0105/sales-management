# API Tuyển dụng & hợp đồng tích hợp OpenClaw AI Recruiter

Module backend: `src/recruitment/`. Có hai lớp API tách biệt:

| Lớp          | Prefix               | Xác thực                                         | Dùng cho                  |
| ------------ | -------------------- | ------------------------------------------------ | ------------------------- |
| AI           | `/recruitment/ai/*`  | `Authorization: Bearer <RECRUITMENT_AI_API_KEY>` | OpenClaw AI Recruiter     |
| HR / quản lý | `/recruitment/*`     | Bearer JWT nhân viên (như mọi module khác)       | Frontend dashboard sau này |

Không có global prefix: production là `https://sales.kidoedu.vn/recruitment/ai/...`.
(`/api` của server là Swagger UI, không phải prefix API.)

OpenAPI cho lớp AI: [`openapi/recruitment-ai.yaml`](openapi/recruitment-ai.yaml).

---

## 1. Nguyên tắc với AI

- AI **chỉ** được: thu thập dữ liệu, lưu tin nhắn, sàng lọc, đề xuất/xác nhận
  lịch phỏng vấn **trong slot HR đã mở**, chuyển HR.
- AI **không** được: OFFER, HIRED, REJECTED, WITHDRAWN, tự đặt giờ ngoài slot,
  hay ra quyết định sau khi đã chuyển HR. Không có endpoint nào cho các việc đó.
- Điểm sàng lọc do backend tính **tất định**. Tóm tắt của AI chỉ để HR đọc.
- Không gửi thuộc tính nhạy cảm (giới tính, tuổi/ngày sinh, tôn giáo, dân tộc,
  hôn nhân, sức khoẻ, ngoại hình, chính trị). Khoá lạ trong body → `400`;
  `metadata` chứa khoá nhạy cảm → `400`.
- Mọi lỗi nghiệp vụ trả `{ "code": "...", "message": "..." }` — rẽ nhánh theo `code`.
- Mọi `POST` của AI trả `200` và đều an toàn khi retry (xem §5).

## 2. Cấu hình

```env
RECRUITMENT_AI_ENABLED=true
RECRUITMENT_AI_API_KEY=<openssl rand -hex 32>
RECRUITMENT_AI_RATE_LIMIT_PER_MINUTE=300   # tuỳ chọn
```

| Tình huống                                    | Kết quả                         |
| --------------------------------------------- | ------------------------------- |
| `RECRUITMENT_AI_ENABLED` ≠ `true` / key < 32 ký tự | `503 RECRUITMENT_AI_DISABLED` |
| Thiếu / sai Bearer token                      | `401 INVALID_API_KEY`           |
| Vượt hạn mức/phút                             | `429 RATE_LIMITED` + `Retry-After` |

JWT của nhân viên **không** dùng được cho `/recruitment/ai/*`.

## 3. Tool ↔ endpoint

| Tool OpenClaw               | Method & URL                                         | Ghi chú |
| --------------------------- | ---------------------------------------------------- | ------- |
| `getActiveJobs()`           | `GET /recruitment/ai/jobs/active`                    | Vị trí ACTIVE |
| `getJobDetail(jobId)`       | `GET /recruitment/ai/jobs/:id`                       | DRAFT → 404 |
| `findOrCreateCandidate()`   | `POST /recruitment/ai/candidates/find-or-create`     | Idempotent theo `zaloUserId` |
| `getCandidate()`            | `GET /recruitment/ai/candidates/:id`                 | |
| `updateCandidate()`         | `PATCH /recruitment/ai/candidates/:id`               | |
| `requestDataDeletion()`     | `POST /recruitment/ai/candidates/:id/deletion-request` | Khi chưa có hồ sơ |
| `findOrCreateApplication()` | `POST /recruitment/ai/applications/find-or-create`   | Idempotent theo (ứng viên, vị trí) |
| `getApplicationContext()`   | `GET /recruitment/ai/applications/:id/context`       | Context có cấu trúc |
| `screenCandidate()`         | `POST /recruitment/ai/applications/:id/screen`       | |
| `handoffToHR()`             | `POST /recruitment/ai/applications/:id/handoff`      | Idempotent theo (hồ sơ, lý do) |
| `saveCandidateMessage()`    | `POST /recruitment/ai/conversations/message`         | Idempotent theo `externalMessageId` |
| `getConversationContext()`  | `GET /recruitment/ai/conversations/:id/context`      | |
| `getInterviewSlots()`       | `GET /recruitment/ai/interview-slots?jobId=`         | |
| `proposeInterview()`        | `POST /recruitment/ai/interviews/propose`            | **Bắt buộc `Idempotency-Key`** |
| `confirmInterview()`        | `POST /recruitment/ai/interviews/:id/confirm`        | Idempotent |

## 4. Workflow chuẩn

```text
Ứng viên nhắn tin
  → findOrCreateCandidate({ zaloUserId, fullName, source: "ZALO" })
      outcome=POSSIBLE_DUPLICATE → hỏi lại / handoff SPECIAL_CASE (xem §6.2)
  → saveCandidateMessage(tin của ứng viên)
  → getActiveJobs() → ứng viên chọn vị trí
  → findOrCreateApplication({ candidateId, jobId })
  → getApplicationContext(applicationId)
      đọc missingFields + allowedActions + guidance
  → hỏi ứng viên phần còn thiếu → updateCandidate(...) → saveCandidateMessage(...)
  → đủ thông tin → screenCandidate(...)
      PROPOSE_INTERVIEW → getInterviewSlots → proposeInterview → ứng viên đồng ý → confirmInterview
      COLLECT_MORE_INFO → hỏi tiếp missingInformation → screenCandidate lại
      HR_REVIEW / HANDOFF_TO_HR → backend đã tự chuyển HR; chỉ báo ứng viên HR sẽ liên hệ
```

Chuyển HR ngay (`handoffToHR`) khi: AI không chắc, ứng viên khiếu nại, muốn gặp
người thật, lương ngoài khung, tình huống đặc biệt, xin xoá dữ liệu.

**Luôn đọc `allowedActions` trong context** trước khi gọi tool ghi — backend tính
từ trạng thái thật; gọi tool không có trong danh sách sẽ bị `409`.

## 5. Idempotency

| Endpoint                      | Cơ chế |
| ----------------------------- | ------ |
| `candidates/find-or-create`   | Unique `zaloUserId`; race song song → trả ứng viên đã tạo |
| `applications/find-or-create` | Unique (ứng viên, vị trí) khi hồ sơ chưa REJECTED/WITHDRAWN |
| `conversations/message`       | Unique (hội thoại, `externalMessageId`) → `duplicate: true` |
| `applications/:id/handoff`    | Đã có yêu cầu OPEN cùng lý do → `alreadyOpen: true` |
| `interviews/:id/confirm`      | Đã CONFIRMED → `alreadyConfirmed: true` |
| `applications/:id/screen`     | Tất định — chấm lại ra cùng kết quả |
| `interviews/propose`          | **Header `Idempotency-Key` bắt buộc** |

`Idempotency-Key` (8–255 ký tự `A-Z a-z 0-9 . _ : -`, nên dùng id tin nhắn/lượt
hội thoại của OpenClaw) nhận ở mọi `POST/PATCH` của AI:

- Retry cùng key + cùng body → response cũ, header `Idempotent-Replayed: true`.
- Cùng key, khác body → `422 IDEMPOTENCY_KEY_REUSED`.
- Request trước còn chạy → `409 IDEMPOTENCY_IN_PROGRESS` (đợi rồi thử lại).
- Request lỗi → key bị xoá, retry chạy lại bình thường. Key hết hạn sau 24 giờ.

## 6. Chi tiết endpoint AI

### 6.1 Vị trí

```http
GET /recruitment/ai/jobs/active
```

```json
{
  "data": [
    {
      "id": 3,
      "code": "SALES-CM-01",
      "title": "Nhân viên kinh doanh",
      "description": "...",
      "department": { "id": 2, "name": "Phòng Kinh doanh" },
      "location": "Cà Mau",
      "employmentType": "FULL_TIME",
      "numberOfPositions": 2,
      "salaryMin": 8000000,
      "salaryMax": 15000000,
      "currency": "VND",
      "requirements": "...",
      "responsibilities": "...",
      "screeningCriteria": {
        "minimumExperienceMonths": 12,
        "requiredSkills": ["sales"],
        "preferredSkills": ["CRM"],
        "locations": ["Cà Mau"],
        "availableImmediatelyPreferred": true
      },
      "status": "ACTIVE",
      "publishedAt": "2026-10-05T02:00:00.000Z"
    }
  ]
}
```

`screeningCriteria.requiredSkills/preferredSkills` là **từ vựng chuẩn**: khi gửi
`extractedSkills`, AI phải map kỹ năng của ứng viên về đúng các từ này (so khớp
không phân biệt hoa thường/dấu, nhưng phải cùng từ).

### 6.2 Ứng viên

```http
POST /recruitment/ai/candidates/find-or-create
{ "zaloUserId": "123456", "fullName": "Nguyễn Văn A", "source": "ZALO" }
```

Phải có ít nhất một trong `zaloUserId`, `phone`, `email` (`400 IDENTITY_REQUIRED`).
Các trường khác: `fullName`, `source`, `location`, `confirmNewCandidate`.

| `outcome`            | Ý nghĩa |
| -------------------- | ------- |
| `EXISTING`           | Khớp `zaloUserId` — ứng viên cũ |
| `CREATED`            | Tạo mới |
| `POSSIBLE_DUPLICATE` | SĐT/email trùng hồ sơ khác. **Không** tạo, **không** trả hồ sơ cũ |

```json
{
  "outcome": "POSSIBLE_DUPLICATE",
  "created": false,
  "candidate": null,
  "matchedOn": ["phone"],
  "possibleDuplicateCount": 1,
  "message": "..."
}
```

Backend không bao giờ nhận hộ hồ sơ cũ theo SĐT/email: người nhắn có thể khai
SĐT của người khác. Khi gặp `POSSIBLE_DUPLICATE`, AI chọn một trong hai:

- gửi lại với `"confirmNewCandidate": true` → tạo hồ sơ mới, gắn cờ nghi trùng
  cho HR đối chiếu (`suspectedDuplicate: true`);
- hoặc tạo rồi `handoffToHR` lý do `SPECIAL_CASE`.

```http
PATCH /recruitment/ai/candidates/7
{
  "phone": "0901234567",
  "location": "TP. Cà Mau",
  "totalExperienceMonths": 24,
  "expectedSalary": 12000000,
  "availableFrom": "2026-10-10",
  "skills": ["sales", "CRM"],
  "cvUrl": "https://drive.example.com/cv/abc.pdf",
  "metadata": { "zaloDisplayName": "A Nguyen" }
}
```

Trả `{ candidate, possibleDuplicate, matchedOn }`. SĐT/email mới trùng hồ sơ
khác vẫn được lưu (không chặn hội thoại) nhưng gắn cờ cho HR. Không sửa được
`zaloUserId`, `source`, ghi chú HR. `null` để xoá một trường.
CV chỉ lưu đường dẫn (`cvUrl`) — backend không nhận file.

### 6.3 Hồ sơ ứng tuyển & context

```http
POST /recruitment/ai/applications/find-or-create
{ "candidateId": 7, "jobId": 3 }
```

→ `{ "created": true, "application": { "id": 12, "status": "NEW", ... } }`.
Vị trí không ACTIVE → `409 JOB_NOT_ACTIVE`.

```http
GET /recruitment/ai/applications/12/context
```

```json
{
  "candidate": { "id": 7, "fullName": "Nguyễn Văn A", "skills": [], "...": "..." },
  "job": { "id": 3, "title": "Nhân viên kinh doanh", "screeningCriteria": { } },
  "application": { "id": 12, "status": "COLLECTING_INFO", "aiPaused": false, "aiMatchLevel": null },
  "conversationId": 4,
  "missingFields": ["phone", "totalExperienceMonths", "skills", "expectedSalary"],
  "openHandoffs": [],
  "activeInterview": null,
  "recentMessages": [
    { "id": 900, "senderType": "CANDIDATE", "direction": "INBOUND", "content": "...", "contentType": "TEXT", "createdAt": "..." }
  ],
  "aiStopped": false,
  "aiPaused": false,
  "allowedActions": ["SAVE_MESSAGE", "UPDATE_CANDIDATE", "REQUEST_DATA_DELETION", "HANDOFF_TO_HR", "SCREEN_CANDIDATE"],
  "guidance": "Cần hỏi thêm: phone, totalExperienceMonths, skills, expectedSalary."
}
```

`allowedActions` có thể gồm: `SAVE_MESSAGE`, `UPDATE_CANDIDATE`,
`FIND_OR_CREATE_APPLICATION`, `SCREEN_CANDIDATE`, `GET_INTERVIEW_SLOTS`,
`PROPOSE_INTERVIEW`, `CONFIRM_INTERVIEW`, `HANDOFF_TO_HR`, `REQUEST_DATA_DELETION`.
Khi `aiPaused` (đã chuyển HR) chỉ còn `SAVE_MESSAGE`, `UPDATE_CANDIDATE`,
`REQUEST_DATA_DELETION` — không còn bước quyết định nào. Khi `aiStopped` (ứng
viên xin xoá dữ liệu) chỉ còn `SAVE_MESSAGE`. Làm theo `guidance`.

`recentMessages` là 20 tin gần nhất, cũ → mới.

### 6.4 Tin nhắn

```http
POST /recruitment/ai/conversations/message
{
  "candidateId": 7,
  "applicationId": 12,
  "channel": "ZALO",
  "externalConversationId": "zalo-conv-abc",
  "externalMessageId": "zalo-msg-001",
  "senderType": "CANDIDATE",
  "direction": "INBOUND",
  "content": "Em có 2 năm kinh nghiệm sales B2B",
  "contentType": "TEXT"
}
```

→ `{ "conversationId": 4, "messageId": 900, "applicationId": 12, "duplicate": false }`

- `CANDIDATE` phải là `INBOUND`; `AI`/`HR` phải là `OUTBOUND` (`400 SENDER_DIRECTION_MISMATCH`).
- Lưu tin **luôn được phép**, kể cả khi hồ sơ đã chuyển HR hay ứng viên xin xoá dữ liệu.
- Kênh không có id hội thoại: bỏ `externalConversationId`, backend dùng hội
  thoại đang mở gần nhất của ứng viên trên kênh đó.

### 6.5 Sàng lọc

```http
POST /recruitment/ai/applications/12/screen
{
  "extractedSkills": ["sales", "CRM"],
  "experienceSummary": "2 năm sales B2B",
  "totalExperienceMonths": 24,
  "availableFrom": "2026-10-10",
  "expectedSalary": 12000000,
  "location": "Cà Mau",
  "aiSummary": "Ứng viên có kinh nghiệm bán hàng B2B, dùng CRM thành thạo."
}
```

Dữ liệu được ghi vào hồ sơ ứng viên rồi mới chấm.

```json
{
  "applicationId": 12,
  "score": 100,
  "matchLevel": "HIGH_MATCH",
  "strengths": ["Đủ kinh nghiệm: 24/12 tháng kinh nghiệm", "Có đủ kỹ năng bắt buộc: sales"],
  "concerns": [],
  "missingInformation": [],
  "recommendedAction": "PROPOSE_INTERVIEW",
  "status": "QUALIFIED",
  "aiPaused": false,
  "handoffId": null,
  "breakdown": {
    "engineVersion": "v1",
    "evaluatedOn": "2026-10-05",
    "applicableWeight": 100,
    "earnedWeight": 100,
    "missingWeight": 0,
    "criteria": [
      { "criterion": "experience", "weight": 30, "fraction": 1, "earned": 30, "missingField": null, "detail": "24/12 tháng kinh nghiệm" }
    ],
    "adjustments": []
  }
}
```

**Cách tính điểm (engine `v1`)** — chỉ tính tiêu chí vị trí có khai, quy về 100:

| Tiêu chí           | Trọng số | Điểm |
| ------------------ | -------: | ---- |
| Kinh nghiệm        | 30 | `min(1, tháng / tháng tối thiểu)` |
| Kỹ năng bắt buộc   | 30 | tỉ lệ khớp |
| Địa điểm           | 15 | khớp khu vực = 1, không = 0 |
| Lương mong muốn    | 15 | trong khung = 1; vượt trần ≤ 10% = 0.5; vượt > 10% = 0 + chuyển HR |
| Kỹ năng ưu tiên    |  5 | tỉ lệ khớp |
| Ngày bắt đầu       |  5 | ≤ hạn = 1; trễ ≤ 30 ngày = 0.5; trễ hơn = 0 |

| Mức                 | Điều kiện | `recommendedAction` | Trạng thái hồ sơ |
| ------------------- | --------- | ------------------- | ---------------- |
| `HIGH_MATCH`        | ≥ 75 (thiếu kỹ năng bắt buộc thì tối đa MEDIUM) | `PROPOSE_INTERVIEW` | `QUALIFIED` |
| `MEDIUM_MATCH`      | 50–74 | `HR_REVIEW` (hoặc `COLLECT_MORE_INFO` nếu còn thiếu dữ liệu) | `NEEDS_HR_REVIEW` / `COLLECTING_INFO` |
| `LOW_MATCH`         | < 50 | như trên — **không tự loại** | như trên |
| `INSUFFICIENT_DATA` | thiếu dữ liệu ≥ 40% trọng số | `COLLECT_MORE_INFO` | `COLLECTING_INFO` |
| (bất kỳ)            | lương vượt trần > 10% | `HANDOFF_TO_HR` | `NEEDS_HR_REVIEW` |

Khi sang `NEEDS_HR_REVIEW`, backend tự mở yêu cầu HR (`FINAL_DECISION_REQUIRED`
hoặc `SALARY_OUT_OF_RANGE`) và khoá AI — AI không cần gọi `handoffToHR` nữa.

Lỗi: `409 SCREENING_NOT_ALLOWED` (hồ sơ đã qua giai đoạn sàng lọc),
`409 INTERVIEW_IN_PROGRESS` (đã có lịch), `409 AI_PAUSED_FOR_HR`.

### 6.6 Phỏng vấn

```http
GET /recruitment/ai/interview-slots?jobId=3&from=2026-10-06T00:00:00+07:00&limit=10
```

Slot đang mở, còn chỗ, bắt đầu sau ít nhất 60 phút, của vị trí này hoặc dùng
chung; mặc định 14 ngày tới.

```json
{ "data": [ { "id": 3, "jobId": 3, "startAt": "...", "endAt": "...", "timezone": "Asia/Ho_Chi_Minh", "location": "Văn phòng Cà Mau", "meetingUrl": null, "remaining": 1 } ] }
```

```http
POST /recruitment/ai/interviews/propose
Idempotency-Key: openclaw-turn-8f2c
{ "applicationId": 12, "slotId": 3, "note": "Ứng viên chọn sáng thứ Hai" }
```

→ `{ "interview": { "id": 70, "status": "PROPOSED", "scheduledStart": "...", ... } }`.
Chỉ khi hồ sơ `QUALIFIED` và chưa có lịch đang chờ. Lỗi: `409 SLOT_UNAVAILABLE`,
`409 ACTIVE_INTERVIEW_EXISTS`, `409 INTERVIEW_NOT_ALLOWED`.

```http
POST /recruitment/ai/interviews/70/confirm
```

→ lịch `CONFIRMED`, hồ sơ `QUALIFIED → INTERVIEW`. Đây là bước duy nhất AI được
đưa hồ sơ sang `INTERVIEW`.

### 6.7 Chuyển HR

```http
POST /recruitment/ai/applications/12/handoff
{ "reason": "SALARY_OUT_OF_RANGE", "summary": "Ứng viên yêu cầu mức lương vượt range.", "priority": "NORMAL" }
```

`reason`: `CANDIDATE_REQUESTED_HUMAN`, `SALARY_OUT_OF_RANGE`, `AI_UNCERTAIN`,
`COMPLAINT`, `DATA_DELETION_REQUEST`, `SPECIAL_CASE`, `FINAL_DECISION_REQUIRED`, `OTHER`.
`priority`: `LOW`, `NORMAL` (mặc định), `HIGH`, `URGENT`.

```json
{
  "handoffId": 61,
  "reason": "SALARY_OUT_OF_RANGE",
  "priority": "NORMAL",
  "status": "OPEN",
  "alreadyOpen": false,
  "application": { "id": 12, "status": "NEEDS_HR_REVIEW", "aiPaused": true }
}
```

Sau handoff: hồ sơ `NEEDS_HR_REVIEW` (từ `OFFER` thì giữ nguyên), `aiPaused=true`.
AI chỉ còn lưu tin nhắn và đọc context cho tới khi HR trả lại.

`DATA_DELETION_REQUEST`: đánh dấu yêu cầu xoá, **dừng AI với mọi hồ sơ của ứng
viên**, mở yêu cầu HR ưu tiên `HIGH`. Không xoá dữ liệu tự động. Ứng viên chưa
có hồ sơ: `POST /recruitment/ai/candidates/:id/deletion-request { "note": "..." }`.

### 6.8 Mã lỗi nghiệp vụ hay gặp

| HTTP | `code` | Xử lý ở OpenClaw |
| ---- | ------ | ---------------- |
| 409 | `AI_PAUSED_FOR_HR` | Báo ứng viên HR sẽ liên hệ |
| 409 | `AI_STOPPED_FOR_CANDIDATE` | Đã xin xoá dữ liệu — không hỏi thêm |
| 409 | `APPLICATION_CLOSED` | Hồ sơ đã kết thúc |
| 403 | `AI_TRANSITION_FORBIDDEN` | Bước này của HR |
| 409 | `INVALID_STATUS_TRANSITION` | Đọc lại context |
| 409 | `SLOT_UNAVAILABLE` | Lấy lại slot, mời chọn giờ khác |
| 409 | `JOB_NOT_ACTIVE` | Vị trí đã dừng nhận hồ sơ |
| 400 | `INVALID_PHONE` | Hỏi lại SĐT |
| 404 | `*_NOT_FOUND` | id sai |

---

## 7. API HR / quản lý (JWT)

| Role                                   | Đọc | Ghi |
| -------------------------------------- | --- | --- |
| `nhansu`                               | Có  | Có  |
| `director`, `director_la`, `troly_gd`  | Có  | Không |

Role khai một chỗ ở `src/recruitment/recruitment.roles.ts`
(`RECRUITMENT_MANAGE_ROLES` / `RECRUITMENT_VIEW_ONLY_ROLES`) — thêm role
`tuyendung` sau này chỉ cần thêm vào đó.

| Method | URL | Mô tả |
| ------ | --- | ----- |
| `POST` | `/recruitment/jobs` | Tạo vị trí (DRAFT) |
| `GET` | `/recruitment/jobs` | `status`, `departmentId`, `keyword`, `page`, `limit` |
| `GET` | `/recruitment/jobs/:id` | |
| `PATCH` | `/recruitment/jobs/:id` | Không sửa vị trí CLOSED |
| `POST` | `/recruitment/jobs/:id/publish` | DRAFT/PAUSED → ACTIVE |
| `POST` | `/recruitment/jobs/:id/pause` | ACTIVE → PAUSED |
| `POST` | `/recruitment/jobs/:id/close` | → CLOSED |
| `POST` | `/recruitment/candidates` | Trùng SĐT/email → `409 POSSIBLE_DUPLICATE` kèm danh sách; `allowDuplicate: true` để vẫn tạo |
| `GET` | `/recruitment/candidates` | `keyword`, `source`, `deletionRequested`, `suspectedDuplicate` |
| `GET` | `/recruitment/candidates/:id` | Kèm danh sách hồ sơ |
| `PATCH` | `/recruitment/candidates/:id` | |
| `POST` | `/recruitment/candidates/:id/deletion-request` | HR ghi nhận yêu cầu xoá |
| `POST` | `/recruitment/applications` | |
| `GET` | `/recruitment/applications` | `jobId`, `candidateId`, `status` (nhiều, phẩy), `source`, `matchLevel`, `aiPaused`, `fromDate`, `toDate`, `keyword`, `sort` (`createdAt`/`updatedAt`/`aiMatchScore`), `order` |
| `GET` | `/recruitment/applications/pipeline` | Như trên + `countsByStatus` |
| `GET` | `/recruitment/applications/:id` | Kèm `allowedNextStatuses`, lịch PV, yêu cầu HR |
| `PATCH` | `/recruitment/applications/:id/status` | `{ status, rejectedReason?, note? }` |
| `POST` | `/recruitment/applications/:id/resume-ai` | Trả lại cho AI `{ status?, note? }` |
| `GET` | `/recruitment/handoffs` | `status`, `reason`, `priority`, `applicationId`, `candidateId` |
| `POST` | `/recruitment/handoffs/:id/resolve` | `{ note? }` — không mở lại AI |
| `POST` | `/recruitment/interview-slots` | `{ jobId?, startAt, endAt, capacity?, location?, meetingUrl?, interviewerId?, timezone?, notes? }` |
| `GET` | `/recruitment/interview-slots` | `jobId`, `from`, `to`, `activeOnly` |
| `PATCH` | `/recruitment/interview-slots/:id` | Đã có người đặt thì không đổi giờ/vị trí; `isActive=false` để đóng |
| `POST` | `/recruitment/interviews` | `slotId` hoặc `scheduledStart/End` |
| `GET` | `/recruitment/interviews` | `applicationId`, `candidateId`, `jobId`, `status`, `from`, `to` |
| `GET` | `/recruitment/interviews/:id` | |
| `PATCH` | `/recruitment/interviews/:id` | Đổi giờ/địa điểm/trạng thái; huỷ bắt buộc `cancellationReason` |
| `GET` | `/recruitment/dashboard/summary` | `jobId`, `fromDate`, `toDate` |

Danh sách luôn trả `{ data, total, page, limit }` (mặc định `limit=20`, tối đa 100).

### Luồng trạng thái hồ sơ

```text
NEW → COLLECTING_INFO → SCREENING → QUALIFIED → INTERVIEW → OFFER → HIRED
                           ├→ COLLECTING_INFO (thiếu dữ liệu)
                           └→ NEEDS_HR_REVIEW ──(chỉ HR)──→ COLLECTING_INFO / SCREENING / QUALIFIED / INTERVIEW
Mọi trạng thái chưa kết thúc → NEEDS_HR_REVIEW (AI/HR), REJECTED / WITHDRAWN (chỉ HR)
```

Chuyển sai luồng → `409 INVALID_STATUS_TRANSITION`. Hồ sơ kết thúc
(HIRED/REJECTED/WITHDRAWN) thì backend huỷ lịch phỏng vấn còn treo (trả chỗ
slot) và đóng yêu cầu HR đang mở.

### Dashboard

```json
{
  "newCandidates": 20,
  "screening": 11,
  "qualified": 8,
  "interviews": 5,
  "offers": 2,
  "hired": 1,
  "needsHrReview": 3,
  "rejected": 4,
  "withdrawn": 0,
  "totalApplications": 54,
  "openHandoffs": 3,
  "upcomingInterviews": 6,
  "activeJobs": 2,
  "byStatus": { "NEW": 12, "COLLECTING_INFO": 8, "...": 0 }
}
```

`newCandidates` = hồ sơ `NEW` + `COLLECTING_INFO`.

## 8. Audit

Mọi thao tác quan trọng (AI và HR) ghi vào `activity_log` có sẵn:
`method` = tên action (`APPLICATION_SCREEN`, `HANDOFF_CREATE`, `INTERVIEW_PROPOSE`...),
`resource` = `recruitment-<entity>`, `beforeData/afterData/changes`, `context.actorType`.
AI ghi với `actorId = -1` (`actorName = "OpenClaw AI"`), bước hệ thống tự sinh
`actorId = -2`. Lịch sử một hồ sơ: `GET /activity-logs/recruitment-applications/12`.
