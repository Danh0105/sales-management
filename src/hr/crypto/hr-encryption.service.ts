import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { HrCryptoError } from './hr-crypto.errors';
import { HrKeyring, KEY_VERSION_PATTERN } from './hr-keyring';

/**
 * AES-256-GCM cho dữ liệu HR cần đọc lại (CCCD, số tài khoản, MST, BHXH…).
 *
 * Payload là MỘT chuỗi tự mô tả, lưu trong một cột `text`:
 *
 *   hrenc:1:<keyVersion>:<iv>:<tag>:<ciphertext>
 *          │  └ key đã dùng để ghi (vd. v1)
 *          └ format version — đổi thuật toán/bố cục thì tăng số này
 *
 * `iv` (12 byte, ngẫu nhiên mỗi lần), `tag` (16 byte) và `ciphertext` mã hoá
 * base64url không padding. `context` (vd. `hr.employee_identity.identity_number`)
 * cùng header `hrenc:1:<keyVersion>` là AAD: chép ciphertext sang cột khác,
 * hay sửa key version trong payload → giải mã thất bại. `context` là một phần
 * của hợp đồng dữ liệu — đổi tên cột không được đổi context đã dùng để ghi.
 *
 * Không log, không đưa plaintext/key vào message lỗi.
 */

export const HR_ENCRYPTION_PREFIX = 'hrenc';
export const HR_ENCRYPTION_FORMAT = 1;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Dữ liệu định danh rất ngắn; chặn việc dùng nhầm để mã hoá blob lớn. */
export const MAX_PLAINTEXT_BYTES = 4096;

/** `schema.table.column` hoặc context chuẩn `hr:v1:employee:12:identity_number` (hr-crypto-context.ts). */
const CONTEXT_PATTERN = /^[a-z][a-z0-9_]*([.:][a-z0-9_]+){2,}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface HrEncryptedEnvelope {
  format: number;
  keyVersion: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export class HrEncryptionService {
  constructor(private readonly keyring: HrKeyring) {}

  get activeKeyVersion(): string {
    return this.keyring.activeVersion;
  }

  /** Luôn ghi bằng active key, IV ngẫu nhiên mới. */
  encrypt(plaintext: string, context: string): string {
    assertContext(context);
    if (typeof plaintext !== 'string') {
      throw new HrCryptoError('EMPTY_PLAINTEXT', 'Plaintext phải là chuỗi.');
    }
    if (plaintext.length === 0) {
      throw new HrCryptoError(
        'EMPTY_PLAINTEXT',
        'Không mã hoá chuỗi rỗng — trường không có giá trị phải là null.',
      );
    }
    const data = Buffer.from(plaintext, 'utf8');
    if (data.length > MAX_PLAINTEXT_BYTES) {
      throw new HrCryptoError(
        'PLAINTEXT_TOO_LONG',
        `Plaintext vượt ${MAX_PLAINTEXT_BYTES} byte.`,
      );
    }

    const keyVersion = this.keyring.activeVersion;
    const key = this.keyring.keyFor(keyVersion)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad(HR_ENCRYPTION_FORMAT, keyVersion, context));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    data.fill(0);
    const tag = cipher.getAuthTag();

    return [
      HR_ENCRYPTION_PREFIX,
      String(HR_ENCRYPTION_FORMAT),
      keyVersion,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  /** `null`/`undefined` = không có giá trị → lưu NULL. Chuỗi rỗng vẫn bị từ chối. */
  encryptNullable(
    plaintext: string | null | undefined,
    context: string,
  ): string | null {
    return plaintext === null || plaintext === undefined
      ? null
      : this.encrypt(plaintext, context);
  }

  /** Đọc bằng key version ghi trong payload (không phải active version). */
  decrypt(payload: string, context: string): string {
    assertContext(context);
    const envelope = parseHrEncryptedPayload(payload);
    const key = this.keyring.keyFor(envelope.keyVersion);
    if (!key) {
      throw new HrCryptoError(
        'UNKNOWN_KEY_VERSION',
        `Không có key cho version ${envelope.keyVersion} — không được gỡ key còn dữ liệu.`,
      );
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, envelope.iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(envelope.format, envelope.keyVersion, context));
      decipher.setAuthTag(envelope.tag);
      return Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Không phân biệt "sai key" / "bị sửa" / "sai context" — cố ý.
      throw new HrCryptoError(
        'DECRYPTION_FAILED',
        'Giải mã thất bại: dữ liệu bị sửa, sai key hoặc sai context.',
      );
    }
  }

  decryptNullable(
    payload: string | null | undefined,
    context: string,
  ): string | null {
    return payload === null || payload === undefined
      ? null
      : this.decrypt(payload, context);
  }

  keyVersionOf(payload: string): string {
    return parseHrEncryptedPayload(payload).keyVersion;
  }

  /** Payload ghi bằng key cũ hoặc format cũ → nên mã hoá lại. */
  needsReEncryption(payload: string): boolean {
    const envelope = parseHrEncryptedPayload(payload);
    return (
      envelope.keyVersion !== this.keyring.activeVersion ||
      envelope.format !== HR_ENCRYPTION_FORMAT
    );
  }

  /**
   * Giải mã bằng key cũ → mã hoá lại bằng active key. Payload đã ở active key
   * thì trả nguyên, không sinh ghi thừa. Chỉ là primitive: KHÔNG tự quét bảng —
   * việc re-encrypt hàng loạt là thao tác vận hành riêng, cần duyệt.
   */
  reEncrypt(payload: string, context: string): string {
    if (!this.needsReEncryption(payload)) {
      // Vẫn xác thực — không để payload hỏng lọt qua như "đã xong".
      this.decrypt(payload, context);
      return payload;
    }
    return this.encrypt(this.decrypt(payload, context), context);
  }
}

function aad(format: number, keyVersion: string, context: string): Buffer {
  return Buffer.from(
    `${HR_ENCRYPTION_PREFIX}:${format}:${keyVersion}|${context}`,
    'utf8',
  );
}

function assertContext(context: string) {
  if (typeof context !== 'string' || !CONTEXT_PATTERN.test(context)) {
    throw new HrCryptoError(
      'INVALID_CONTEXT',
      'Context sai định dạng (vd. hr:v1:employee:<id>:<field>).',
    );
  }
}

/** Kiểm tra cấu trúc payload; không cần key. */
export function parseHrEncryptedPayload(payload: unknown): HrEncryptedEnvelope {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new HrCryptoError('MALFORMED_PAYLOAD', 'Payload phải là chuỗi.');
  }
  const parts = payload.split(':');
  if (parts[0] !== HR_ENCRYPTION_PREFIX) {
    throw new HrCryptoError(
      'MALFORMED_PAYLOAD',
      `Payload không bắt đầu bằng "${HR_ENCRYPTION_PREFIX}:".`,
    );
  }
  if (parts[1] !== String(HR_ENCRYPTION_FORMAT)) {
    throw new HrCryptoError(
      'UNSUPPORTED_FORMAT',
      'Format version của payload không được hỗ trợ.',
    );
  }
  if (parts.length !== 6) {
    throw new HrCryptoError(
      'MALFORMED_PAYLOAD',
      'Payload phải có đúng 6 phần.',
    );
  }
  const [, , keyVersion, iv, tag, ciphertext] = parts;
  if (!keyVersion) {
    throw new HrCryptoError(
      'MISSING_KEY_VERSION',
      'Payload thiếu key version.',
    );
  }
  if (!KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new HrCryptoError(
      'MALFORMED_PAYLOAD',
      'Key version trong payload sai định dạng.',
    );
  }
  return {
    format: HR_ENCRYPTION_FORMAT,
    keyVersion,
    iv: decodePart(iv, 'iv', IV_BYTES),
    tag: decodePart(tag, 'tag', TAG_BYTES),
    ciphertext: decodePart(ciphertext, 'ciphertext'),
  };
}

function decodePart(text: string, name: string, exactBytes?: number): Buffer {
  if (!BASE64URL.test(text)) {
    throw new HrCryptoError('MALFORMED_PAYLOAD', `Phần ${name} không hợp lệ.`);
  }
  const bytes = Buffer.from(text, 'base64url');
  // Round-trip: chặn ký tự thừa / bit padding khác chuẩn.
  if (
    bytes.toString('base64url') !== text ||
    (exactBytes !== undefined && bytes.length !== exactBytes)
  ) {
    throw new HrCryptoError('MALFORMED_PAYLOAD', `Phần ${name} không hợp lệ.`);
  }
  return bytes;
}
