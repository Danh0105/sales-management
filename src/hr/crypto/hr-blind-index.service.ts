import { createHmac } from 'crypto';
import { HrCryptoError } from './hr-crypto.errors';
import { HrKeyring } from './hr-keyring';

/**
 * Blind index cho exact lookup / kiểm tra trùng (CCCD, MST, BHXH, số tài khoản)
 * — không bao giờ tìm trên ciphertext, không dùng SHA-256 thuần (CCCD chỉ có
 * ~10^12 giá trị, brute-force được).
 *
 *   hbi:1:<keyVersion>:<base64url(HMAC-SHA256(key, "hbi:1|" + context + "|" + normalized))>
 *
 * Key HMAC (`HR_HMAC_KEY_V*`) tách riêng key mã hoá. `context` tách miền: cùng
 * một dãy số ở CCCD và MST cho hai hash khác nhau.
 *
 * Rotation: `hash()` ghi bằng active version; tra cứu dùng `candidates()` (mọi
 * version còn trong keyring) → `WHERE col_hash IN (...)`. Unique index trên cột
 * hash chỉ chặn trùng trong CÙNG version — kiểm tra trùng ở tầng ứng dụng phải
 * dùng `candidates()`.
 */

export const HR_BLIND_INDEX_PREFIX = 'hbi';
export const HR_BLIND_INDEX_FORMAT = 1;

/** `schema.table.column` hoặc context chuẩn `hr:v1:employee:12:identity_number` (hr-crypto-context.ts). */
const CONTEXT_PATTERN = /^[a-z][a-z0-9_]*([.:][a-z0-9_]+){2,}$/;
const MAX_INPUT_LENGTH = 256;

/**
 * Chuẩn hoá chung cho mã định danh: NFKC, bỏ khoảng trắng / `-` / `.`, chữ hoa.
 * `"0123 4567-89"` ≡ `"0123456789"`. Kiểm tra định dạng riêng từng loại (CCCD
 * 12 số…) là việc của DTO, không phải của hàm này.
 */
export function normalizeIdentifier(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\-.]/g, '')
    .toUpperCase();
}

export class HrBlindIndexService {
  constructor(private readonly keyring: HrKeyring) {}

  get activeKeyVersion(): string {
    return this.keyring.activeVersion;
  }

  /** Hash để GHI (active version). */
  hash(value: string, context: string): string {
    return this.compute(this.keyring.activeVersion, value, context);
  }

  /** Mọi hash có thể đã được ghi cho giá trị này — dùng để TRA CỨU. */
  candidates(value: string, context: string): string[] {
    return this.keyring
      .versions()
      .map((version) => this.compute(version, value, context));
  }

  hashNullable(value: string | null | undefined, context: string) {
    return value === null || value === undefined
      ? null
      : this.hash(value, context);
  }

  private compute(version: string, value: string, context: string): string {
    if (typeof context !== 'string' || !CONTEXT_PATTERN.test(context)) {
      throw new HrCryptoError(
        'INVALID_CONTEXT',
        'Context sai định dạng (vd. hr:v1:employee:<id>:<field>).',
      );
    }
    if (typeof value !== 'string') {
      throw new HrCryptoError('EMPTY_PLAINTEXT', 'Giá trị phải là chuỗi.');
    }
    const normalized = normalizeIdentifier(value);
    if (!normalized) {
      throw new HrCryptoError(
        'EMPTY_PLAINTEXT',
        'Không tạo blind index cho giá trị rỗng.',
      );
    }
    if (normalized.length > MAX_INPUT_LENGTH) {
      throw new HrCryptoError(
        'PLAINTEXT_TOO_LONG',
        `Giá trị vượt ${MAX_INPUT_LENGTH} ký tự.`,
      );
    }
    const digest = createHmac('sha256', this.keyring.keyFor(version)!)
      .update(
        `${HR_BLIND_INDEX_PREFIX}:${HR_BLIND_INDEX_FORMAT}|${context}|${normalized}`,
        'utf8',
      )
      .digest('base64url');
    return `${HR_BLIND_INDEX_PREFIX}:${HR_BLIND_INDEX_FORMAT}:${version}:${digest}`;
  }
}
