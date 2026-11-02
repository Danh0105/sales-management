import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Mã hoá token OA tuyển dụng trong DB: AES-256-GCM, IV ngẫu nhiên 12 byte,
 * dạng lưu `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` = OA id — bản mã của
 * OA này không giải được khi chép sang dòng của OA khác.
 */
const VERSION = 'v1';

export function encryptToken(key: Buffer, oaId: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(oaId, 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((part) =>
      typeof part === 'string' ? part : part.toString('base64url'),
    )
    .join('.');
}

/** Sai khoá / sai OA / dữ liệu bị sửa → ném lỗi (không trả token rác). */
export function decryptToken(
  key: Buffer,
  oaId: string,
  stored: string,
): string {
  const [version, iv, tag, data] = stored.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new Error('TOKEN_FORMAT_INVALID');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(oaId, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
