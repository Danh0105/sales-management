/**
 * Che dữ liệu nhạy cảm trước khi nó rời khỏi nơi được phép thấy — dùng cho
 * audit (old/new value) và, từ Task 0.4, cho mọi response mặc định.
 *
 * Nhận diện theo TÊN field (không phân biệt hoa thường, bỏ `_`/`-`), vì giá
 * trị CCCD/số tài khoản không có định dạng đủ riêng để nhận ra bằng nội dung.
 */

const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Giữ 4 ký tự cuối: `********1234`. */
const PARTIAL_MASK_KEYS = new Set(
  [
    'identityNumber',
    'identity_number',
    'idNumber',
    'citizenId',
    'cccd',
    'cmnd',
    'passport',
    'passportNumber',
    'bankAccount',
    'bankAccountNumber',
    'accountNumber',
    'taxNumber',
    'personalTaxCode',
    'insuranceNumber',
    'socialInsuranceNumber',
    'bhxh',
    'bhxhNumber',
  ].map(normalize),
);

/** Che toàn bộ — số tiền không có "4 số cuối" nào an toàn để lộ. */
const FULL_MASK_KEYS = new Set(
  ['salary', 'baseSalary', 'grossSalary', 'netSalary', 'salaryAmount'].map(
    normalize,
  ),
);

/** Bí mật hệ thống — không bao giờ được xuất hiện, kể cả dạng che. */
const REDACT_KEYS = new Set(
  [
    'password',
    'newPassword',
    'oldPassword',
    'token',
    'accessToken',
    'refreshToken',
    'secret',
  ].map(normalize),
);

export const MASKED = '***';
export const REDACTED = '[REDACTED]';

export function maskIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // Object không có "4 ký tự cuối" nào có nghĩa — che toàn bộ.
  if (typeof value === 'object' || typeof value === 'function') return MASKED;
  const text = String(value as string | number | bigint | boolean).trim();
  if (!text) return '';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${'*'.repeat(8)}${text.slice(-4)}`;
}

export function sensitiveKind(
  key: string,
): 'partial' | 'full' | 'redact' | null {
  const k = normalize(key);
  if (REDACT_KEYS.has(k)) return 'redact';
  if (PARTIAL_MASK_KEYS.has(k)) return 'partial';
  if (FULL_MASK_KEYS.has(k) || k.endsWith('salary')) return 'full';
  return null;
}

const MAX_DEPTH = 8;

/**
 * Ciphertext (`hrenc:`) và blind index (`hbi:`) không có lý do gì nằm trong
 * audit/log: blind index cho phép dò ngược theo từ điển nếu lộ key HMAC.
 * Che theo GIÁ TRỊ, bất kể tên field.
 */
const CRYPTO_ARTIFACT = /^(hrenc|hbi):\d+:/;

/** Trả về bản sao đã che; không sửa object gốc. */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[TOO_DEEP]';
  if (typeof value === 'string' && CRYPTO_ARTIFACT.test(value)) return REDACTED;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return value.map((v) => maskSensitive(v, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const kind = sensitiveKind(key);
    if (kind === 'redact') out[key] = REDACTED;
    else if (kind === 'full') out[key] = raw === null ? null : MASKED;
    else if (kind === 'partial') out[key] = maskIdentifier(raw);
    else out[key] = maskSensitive(raw, depth + 1);
  }
  return out;
}
