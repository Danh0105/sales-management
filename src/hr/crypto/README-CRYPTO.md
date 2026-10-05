# HR crypto — mã hoá dữ liệu nhạy cảm (Task 0.4A + 0.4B)

## Dữ liệu được mã hoá

| Bảng (`hr.`)                  | Trường nhạy cảm            | Cột lưu                                           | Reveal            |
| ----------------------------- | -------------------------- | ------------------------------------------------- | ----------------- |
| `employee_identity_documents` | số CCCD/CMND/hộ chiếu/GPLĐ | `number_encrypted`, `number_last4`, `number_hash` | `IDENTITY_REVEAL` |
| `employee_bank_accounts`      | số tài khoản               | `account_number_encrypted/_last4/_hash`           | `BANK_REVEAL`     |
| `employee_tax_profiles`       | MST                        | `tax_number_encrypted/_last4/_hash`               | chưa có (chỉ che) |
| `employee_insurance_profiles` | mã số BHXH                 | `social_insurance_number_encrypted/_last4/_hash`  | chưa có (chỉ che) |

Không mã hoá: họ tên, mã NV, tên ngân hàng, chủ tài khoản, ngày cấp/nơi cấp. **Lương chưa mã hoá** (chờ duyệt riêng).
Không có cột plaintext; CHECK trong DB chặn ghi chuỗi không phải `hrenc:` / `hbi:` vào cột mã hoá / hash.

- `*_encrypted`: `hrenc:1:<keyVersion>:<iv>:<tag>:<ciphertext>` — AES-256-GCM, IV 12 byte ngẫu nhiên, tag 16 byte.
- `*_last4`: để API trả `********1234` mà **không giải mã**. Mọi loại số tối thiểu 6 ký tự → `last4` không bao giờ là toàn bộ.
- `*_hash`: blind index `hbi:1:<keyVersion>:<HMAC-SHA256>` — chống trùng / tra cứu chính xác, không bao giờ trả ra API/audit.

## Context chuẩn (hợp đồng dữ liệu — không đổi tuỳ tiện)

```
Mã hoá (AAD):  hr:v1:employee:<hr.employees.id>:<field>
               field ∈ identity_number | bank_account_number | tax_number | social_insurance_number
Blind index:   hr:v1:bi:<domain>
               domain ∈ national_id (CCCD + CMND) | passport | work_permit | tax_number | social_insurance_number | bank_account
```

- Chép ciphertext của nhân viên A sang B, hoặc từ cột CCCD sang cột số TK → giải mã thất bại (`HR_DECRYPTION_FAILED`).
- Không dùng id dòng (chưa có trước INSERT). Không có `companyId`: hệ thống một công ty, `hr.employees.id` duy nhất toàn cục.
- Đổi format → context `hr:v2:...` và giữ đọc được `v1`. Nguồn: `hr-crypto-context.ts`.
- Blind index không gắn nhân viên (mục đích là phát hiện trùng giữa các nhân viên). Trùng = 409 `HR_IDENTIFIER_DUPLICATE`
  (không nêu hồ sơ nào đang giữ số). Số TK: trùng theo (`bank_code`, hash). Kiểm tra trùng thử hash của mọi version HMAC.

## Biến môi trường

```
HR_ENCRYPTION_ACTIVE_KEY_VERSION=v1
HR_ENCRYPTION_KEY_V1=<Base64 của 32 byte ngẫu nhiên — 44 ký tự, kết thúc bằng "=">
HR_HMAC_ACTIVE_KEY_VERSION=v1
HR_HMAC_KEY_V1=<Base64 của 32 byte ngẫu nhiên, sinh RIÊNG>
```

Mỗi môi trường một bộ khoá riêng. Mất khoá = mất dữ liệu đã mã hoá bằng khoá đó — backup khoá tách khỏi backup DB.

### Sinh khoá

Cách mặc định — chỉ in ra khi người vận hành chủ động chạy, rồi tự dán vào `.env` (không dán vào chat/Git/ticket):

```bash
openssl rand -base64 32
```

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b); $b.Clear()
```

Nếu muốn ghi thẳng vào `.env` không hiện ra màn hình — **kiểm tra biến đã tồn tại chưa trước** (chạy lặp lại sẽ tạo
định nghĩa trùng, và thay khoá đang dùng = mất dữ liệu):

```bash
grep -q '^HR_ENCRYPTION_KEY_V1=' .env && echo "ĐÃ CÓ — không ghi thêm" \
  || echo "HR_ENCRYPTION_KEY_V1=$(openssl rand -base64 32)" >> .env
```

## Khi thiếu / sai khoá (degraded mode)

Backend **vẫn khởi động**; log một dòng an toàn, ví dụ
`HR crypto unavailable — encryption: [HR_CRYPTO_CONFIG] Thiếu HR_ENCRYPTION_ACTIVE_KEY_VERSION.` (tên biến, không giá trị).

| Chức năng                                                | Thiếu khoá mã hoá | Thiếu khoá HMAC |
| -------------------------------------------------------- | ----------------- | --------------- |
| Module cũ, `GET/POST /api/hr/v1/employees`, xem dạng che | chạy              | chạy            |
| Tạo/sửa CCCD, TK ngân hàng, MST, BHXH                    | 503               | 503             |
| Reveal CCCD / số TK                                      | 503               | chạy            |

503 = `{ code: "HR_CRYPTO_UNAVAILABLE" }`. Fail closed: không fallback plaintext, không trả ciphertext, không bỏ qua blind
index; 503 xảy ra trước khi mở transaction nên không có gì được ghi. Trạng thái: `GET /api/hr/v1/crypto/status`
(`ACCESS_VIEW`) — chỉ `status`, `encryptionKeyringReady`, `hmacKeyringReady`, active version.

**Chính sách triển khai:** degraded mode chỉ là lưới an toàn lúc chạy. Trước khi bật tính năng HR nhạy cảm trên production,
checklist deploy BẮT BUỘC có đủ 4 biến và `crypto/status` = `AVAILABLE`.

## Reveal

`POST .../identity-documents/:id/reveal`, `POST .../bank-account/reveal` — body `{ reason }` (≥ 5 ký tự), không bao giờ
trên URL. Thứ tự: xác thực → quyền → phạm vi (ngoài phạm vi 404) → giải mã → audit (`IDENTITY_REVEAL` / `BANK_REVEAL`,
có lý do, requestId, IP, user agent, KHÔNG có giá trị) → trả giá trị với `Cache-Control: no-store`. Audit lỗi → không trả.

## Log / audit

- `public.activity_log`: request `/api/hr/v1/**` chỉ ghi metadata (người, method, path, status, thời gian) — không
  body/params/query/response/message lỗi (`METADATA_ONLY_ROUTE_PREFIXES` trong `audited-entities.ts`).
- `hr.audit_logs`: sự kiện nghiệp vụ, giá trị dạng che (`********1234`) + cờ `*Changed`; `maskSensitive` che mọi chuỗi
  `hrenc:` / `hbi:` bất kể tên field.

## Key rotation

- Khoá cũ: chỉ ĐỌC. Active: ĐỌC + GHI. Thêm `HR_ENCRYPTION_KEY_V2` → `ACTIVE=v2` → deploy. Không re-encrypt lúc khởi động.
- Re-encrypt dần (`reEncrypt`, giữ nguyên context) là thao tác vận hành riêng, cần duyệt; chưa có script.
- Chỉ gỡ `V1` sau khi mọi cột mã hoá đếm được 0 bản ghi v1, ví dụ
  `SELECT split_part(number_encrypted, ':', 3), count(*) FROM hr.employee_identity_documents GROUP BY 1;`
- HMAC: tra cứu dùng mọi version (`candidates()`); đổi khoá HMAC cần tính lại hash mọi bản ghi — hiếm khi làm.

## Rollback

- Khoá: deploy v2 lỗi → `ACTIVE=v1` nhưng **giữ `HR_ENCRYPTION_KEY_V2`**. Không bao giờ rollback bằng cách xoá khoá.
- Code: gỡ `HrEmployeesModule` / `HrCryptoModule` khỏi `HrModule` — bảng `hr.*` còn nguyên, module cũ không phụ thuộc.
- Schema: migration `1791700000400` `down()` từ chối khi có dữ liệu (rollback tay sau backup, cần cả khoá để đọc lại).
