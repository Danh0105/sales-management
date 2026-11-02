# HR private files (Task 0.4C)

Tài liệu HR **không bao giờ** nằm trong `uploads/`, `public/`, `static/`, `dist/` hay thư mục nào được serve tĩnh.
Mọi truy cập nội dung đi qua backend: quyền theo loại tài liệu + phạm vi nhân viên sở hữu → URL/token có hạn 5 phút.

## Kiến trúc

```
HrFileService (nghiệp vụ) ──► HrPrivateStorage (interface)
                                 ├─ LocalHrPrivateStorage   (dev / server một máy)
                                 ├─ UnavailableHrPrivateStorage (thiếu cấu hình → 503)
                                 └─ (sau này) S3 / MinIO adapter — chỉ thay provider HR_PRIVATE_STORAGE
```

Interface: `put` (tạo mới, không ghi đè) · `openRead` · `getSignedReadUrl` · `delete` · `exists` · `stat`.
Adapter có presigned URL (`supportsSignedUrls = true`) → trả URL của kho. Local (`false`) → token + `GET .../content`.

## Cấu hình

`HR_PRIVATE_STORAGE_DIR=<đường dẫn tuyệt đối>` (không phải secret). Thiếu / tương đối / trùng hoặc lồng với thư mục
static → app vẫn chạy, API file trả `503 HR_FILE_STORAGE_UNAVAILABLE`, log chỉ nêu tên biến.

Đề xuất trên server Linux (người vận hành tự làm, không chạy `chmod 777`):

| | |
|---|---|
| Thư mục | `/var/lib/sales-management/hr-private` (ngoài thư mục code, ngoài root Nginx) |
| Owner | user chạy PM2 của backend, group riêng của user đó |
| Mode | thư mục `0700` (adapter tạo thư mục con `0700`, file `0600`) |
| Nginx | không có `location`/`alias` nào trỏ tới thư mục này |
| Backup | cùng lịch backup DB; khôi phục phải đồng bộ với `hr.files` |

Windows (dev): mode POSIX bị bỏ qua — dùng thư mục trong profile người dùng (ACL riêng), ngoài project.

## Metadata — `hr.files`

`storage_key` (`ab/<uuid>` ngẫu nhiên), `original_name` (chỉ hiển thị, đã làm sạch), `mime_type`, `size_bytes`, `sha256`,
`classification`, `document_type`, `owner_employee_id`, `identity_document_id`, `status`, `scan_status`, `uploaded_by`,
`created_at`, `archived_*`, `deleted_at`, `version`. Không có URL, không có đường dẫn tuyệt đối.
`hr.file_access_tokens`: chỉ SHA-256 của token (256 bit ngẫu nhiên), `file_id`, `account_id`, `expires_at`.

## Phân loại & quyền (`hr-file-policy.ts` — nơi duy nhất)

| document_type | classification | Xem nội dung cần | Lý do |
|---|---|---|---|
| IDENTITY_FRONT / IDENTITY_BACK (gắn giấy tờ tuỳ thân) | RESTRICTED | `IDENTITY_REVEAL` + scope | bắt buộc |
| BANK_PROOF | RESTRICTED | `BANK_REVEAL` + scope | bắt buộc |
| CONTRACT / TAX / INSURANCE | RESTRICTED | **chưa có quyền tương đương → fail closed** (không upload, không xem) | — |
| GENERAL | INTERNAL | `FILE_VIEW` + scope | không |

- Upload / lưu trữ: `EMPLOYEE_EDIT` + scope. Danh sách metadata: `EMPLOYEE_VIEW` + scope; `original_name` chỉ hiện cho
  người xem được nội dung loại đó (tên file có thể chứa số định danh).
- Client không gửi được `classification` (DTO whitelist → 400). `EMPLOYEE_VIEW` (kể cả COMPANY) không mở được file RESTRICTED.
- Ngoài phạm vi / không có quyền → 404 (như các API HR khác).

## Upload

xác thực → `EMPLOYEE_EDIT` → phạm vi nhân viên → loại tài liệu được bật → kho sẵn sàng → file có & ≤ 10 MB
(`HR_PRIVATE_FILE_MAX_BYTES`, multer cũng chặn) → chữ ký nội dung (PDF/JPEG/PNG) khớp MIME khai báo và đuôi file →
làm sạch tên → SHA-256 → key ngẫu nhiên → **ghi object** → **transaction**: (thay ảnh cùng mặt → lưu trữ bản cũ +
audit FILE_ARCHIVE) + insert metadata + audit FILE_UPLOAD. `scan_status = NOT_SCANNED` (không giả vờ CLEAN).

Giới hạn MIME: chỉ kiểm tra chữ ký đầu file; PDF vẫn có thể chứa nội dung độc — cần antivirus (sẽ đặt `scan_status`).

## Nhất quán kho ↔ DB (orphan)

Thứ tự **object trước → metadata sau**:
- Kho lỗi → chưa có dòng DB nào (không có metadata giả).
- Transaction DB lỗi → **xoá bù** object ngay; xoá bù cũng lỗi → log `storage_key` (ngẫu nhiên, không nhạy cảm) để đối soát.
- Tiến trình chết giữa ghi object và commit → object mồ côi: không có metadata nên không API nào truy cập được. Phát hiện
  bằng đối soát (liệt kê key trong kho không có trong `hr.files`, cũ hơn 24h) — script đối soát là việc sau, dry-run trước.
- Không có trường hợp "DB có metadata mà không có object" trong luồng bình thường; lúc tải còn kiểm tra `stat` khớp
  `size_bytes`, lệch → 500 `HR_FILE_INTEGRITY`.

## Truy cập

`POST /api/hr/v1/files/:id/access` `{reason}` → kiểm tra file ACTIVE, quyền theo loại + scope, lý do (không phải
INTERNAL), `scan_status` ∈ {CLEAN, NOT_SCANNED} → token 5 phút (hoặc presigned URL) + audit FILE_ACCESS.
`GET /api/hr/v1/files/:id/content?token=` → token khớp file + chưa hết hạn + file còn ACTIVE + **kiểm tra lại quyền của
chủ token** → audit FILE_DOWNLOAD → stream với `Cache-Control: private, no-store`, `nosniff`,
`Content-Disposition: attachment` (tên đã làm sạch + `filename*`), `CSP: default-src 'none'; sandbox`, `no-referrer`.
Mọi lỗi token → một câu trả lời 403 `HR_FILE_TOKEN_INVALID`.

Không phụ thuộc `HrCryptoService`: thiếu khoá mã hoá trường vẫn upload/tải file bình thường.

## Lưu trữ / xoá

`POST /api/hr/v1/files/:id/archive` `{version, reason}` → `status = ARCHIVED`, object giữ nguyên trong kho, token cũ vô
hiệu. Upload ảnh mới cho cùng mặt giấy tờ = file id + key mới, bản cũ tự ARCHIVED. Không xoá vật lý trong 0.4C.

## Audit / log

`hr.audit_logs` (entity `hr_file`): FILE_UPLOAD, FILE_ACCESS, FILE_DOWNLOAD, FILE_ARCHIVE — lưu fileId, employeeId,
documentType, classification, identityDocumentId, tokenId, lý do, requestId, IP, user agent. KHÔNG lưu URL, token,
storage key, đường dẫn, tên file, nội dung. `public.activity_log`: `/api/hr/v1/**` chỉ metadata (không multipart).

## Mã hoá at rest

- Local adapter: **NO** — file nằm nguyên dạng trên đĩa, bảo vệ bằng quyền thư mục. Production nên đặt trên phân vùng
  mã hoá (LUKS / BitLocker) nếu vẫn dùng local.
- S3 / MinIO (khuyến nghị): bucket private + Block Public Access, SSE-KMS (hoặc SSE-S3 / MinIO KES), presigned GET TTL
  300s với `ResponseContentDisposition` + `ResponseContentType`, không bật public-read, versioning + lifecycle theo retention.

## Rủi ro đã biết

Token nằm trên query string → có thể xuất hiện trong access log của Nginx trong 5 phút hiệu lực (giống presigned URL S3).
Nên cấu hình log format bỏ query cho `/api/hr/v1/files/*/content` (việc hạ tầng, chưa làm).

## Phase 1.3 — dùng chung với Hồ sơ tài liệu

- Quyền xem nội dung theo loại là **danh sách "một trong các quyền"** (`accessPermissions`): `GENERAL` xem bằng
  `FILE_VIEW` (như 0.4C) **hoặc** `DOCUMENT_VIEW`; giấy khám sức khỏe chỉ `HEALTH_DOCUMENT_VIEW`.
- Loại `managedByDocuments` (RESUME, DEGREE, CERTIFICATE, HEALTH_CERTIFICATE) chỉ tạo qua module Documents;
  `POST employees/:id/files` với các loại này → 400 `HR_FILE_USE_DOCUMENTS`.
- `HrFileService` mở cho module Documents: `storeDocumentFile` (ghi file trong transaction của phiên bản tài
  liệu, lỗi → xoá bù object), `archiveWithin`, `canSeeContent`, `contentVisibility`. Luồng upload/tải/token
  của 0.4C không đổi.
- File ARCHIVED thường vẫn bị chặn như 0.4C. Ngoại lệ duy nhất: file là **phiên bản cũ** của tài liệu còn ACTIVE
  (`findViewable` / `isSupersededVersion`) — xin quyền + tải được, audit `FILE_ACCESS` ghi `superseded: true`.
  Tài liệu bị lưu trữ → mọi phiên bản bị chặn.
