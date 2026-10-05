/**
 * Lỗi của tầng mã hoá HR.
 *
 * Message CHỈ được chứa mã lỗi, tên biến môi trường, key version và mô tả —
 * không bao giờ chứa plaintext, key, ciphertext hay giá trị biến môi trường.
 * Lỗi này có thể đi vào log của Nest, activity log hoặc audit.
 */

export type HrCryptoErrorCode =
  | 'EMPTY_PLAINTEXT'
  | 'PLAINTEXT_TOO_LONG'
  | 'INVALID_CONTEXT'
  | 'MALFORMED_PAYLOAD'
  | 'UNSUPPORTED_FORMAT'
  | 'MISSING_KEY_VERSION'
  | 'UNKNOWN_KEY_VERSION'
  | 'DECRYPTION_FAILED';

export class HrCryptoError extends Error {
  constructor(
    readonly code: HrCryptoErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'HrCryptoError';
  }
}

/** Cấu hình khoá sai — ném lúc khởi động để dừng sớm (fail fast). */
export class HrCryptoConfigError extends Error {
  constructor(message: string) {
    super(`[HR_CRYPTO_CONFIG] ${message}`);
    this.name = 'HrCryptoConfigError';
  }
}
