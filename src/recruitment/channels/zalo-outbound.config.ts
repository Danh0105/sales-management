import { LEGACY_ZALO_OA_ID } from '../ai/recruitment-ai-subject';

/**
 * Cấu hình gửi tin ra Zalo OA **tuyển dụng** (P3-5). Hoàn toàn tách khỏi OA giáo
 * viên: credential riêng (`RECRUITMENT_ZALO_*`), kho token riêng.
 *
 * `RECRUITMENT_ZALO_OUTBOUND_ENABLED` là kill switch, mặc định tắt: khác `true` thì
 * sender không chạy và transport từ chối gửi — không một kết nối nào ra Zalo, kể
 * cả khi webhook (`RECRUITMENT_ZALO_ENABLED`) và worker đang bật.
 */
export interface ZaloOutboundConfig {
  oaId: string;
  appId: string;
  /** App Secret — header `secret_key` khi refresh token (khác OA Secret Key của webhook). */
  appSecret: string;
  /** Khoá AES-256-GCM (32 byte) mã hoá token trong DB. */
  tokenKey: Buffer;
  /** Gốc Send API, mặc định `https://openapi.zalo.me` (staging trỏ vào Zalo giả). */
  apiUrl: string;
  /** Gốc OAuth, mặc định `https://oauth.zaloapp.com`. */
  oauthUrl: string;
  concurrency: number;
  pollMs: number;
  leaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  maxTextLength: number;
  /** Mã lỗi Zalo coi là từ chối vĩnh viễn → DEAD_LETTER ngay. */
  permanentErrors: ReadonlySet<number>;
  /** Mã lỗi Zalo coi là access token hỏng → refresh rồi gửi lại một lần. */
  tokenErrors: ReadonlySet<number>;
  /** Zalo từ chối với mã chưa phân loại: thử lại tối đa chừng này lần rồi DEAD_LETTER. */
  maxRejectAttempts: number;
}

export const ZALO_OUTBOUND_CONFIG_ERROR =
  'RECRUITMENT_ZALO_OUTBOUND_CONFIG_INVALID';

/** Bản sao nội dung trong outbox chờ đối soát/dead-letter giữ tối đa 7 ngày. */
export const OUTBOX_TEXT_RETENTION_DAYS = 7;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isZaloOutboundEnabled(
  get: (key: string) => string | undefined,
): boolean {
  return get('RECRUITMENT_ZALO_OUTBOUND_ENABLED') === 'true';
}

export function readZaloOutboundConfig(
  get: (key: string) => string | undefined,
): { config: ZaloOutboundConfig } | { invalid: string[] } {
  const invalid: string[] = [];
  const text = (key: string, fallback = '') => get(key)?.trim() || fallback;
  const int = (key: string, fallback: number, min: number, max: number) => {
    const raw = text(key);
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      invalid.push(key);
      return fallback;
    }
    return value;
  };
  const codes = (key: string, fallback: string) => {
    const raw = text(key, fallback);
    const parts = raw ? raw.split(',').map((x) => x.trim()) : [];
    if (parts.some((x) => !/^-?\d{1,6}$/.test(x))) invalid.push(key);
    return new Set(parts.filter((x) => /^-?\d{1,6}$/.test(x)).map(Number));
  };

  const oaId = text('RECRUITMENT_ZALO_OA_ID');
  if (!ID.test(oaId) || oaId === LEGACY_ZALO_OA_ID) {
    invalid.push('RECRUITMENT_ZALO_OA_ID');
  }
  const appId = text('RECRUITMENT_ZALO_APP_ID');
  if (!ID.test(appId)) invalid.push('RECRUITMENT_ZALO_APP_ID');
  const appSecret = text('RECRUITMENT_ZALO_APP_SECRET');
  if (appSecret.length < 16) invalid.push('RECRUITMENT_ZALO_APP_SECRET');
  const tokenKey = decodeKey(text('RECRUITMENT_ZALO_TOKEN_KEY'));
  if (!tokenKey) invalid.push('RECRUITMENT_ZALO_TOKEN_KEY');
  const apiUrl = text('RECRUITMENT_ZALO_API_URL', 'https://openapi.zalo.me');
  if (!isHttpUrl(apiUrl)) invalid.push('RECRUITMENT_ZALO_API_URL');
  const oauthUrl = text(
    'RECRUITMENT_ZALO_OAUTH_URL',
    'https://oauth.zaloapp.com',
  );
  if (!isHttpUrl(oauthUrl)) invalid.push('RECRUITMENT_ZALO_OAUTH_URL');

  const config = {
    oaId,
    appId,
    appSecret,
    tokenKey: tokenKey ?? Buffer.alloc(0),
    apiUrl,
    oauthUrl,
    concurrency: int('RECRUITMENT_ZALO_SENDER_CONCURRENCY', 2, 1, 16),
    pollMs: int('RECRUITMENT_ZALO_SENDER_POLL_MS', 1_000, 100, 60_000),
    leaseMs: int('RECRUITMENT_ZALO_SENDER_LEASE_MS', 60_000, 3_000, 3_600_000),
    retryBaseMs: int(
      'RECRUITMENT_ZALO_SENDER_RETRY_BASE_MS',
      5_000,
      500,
      3_600_000,
    ),
    retryMaxMs: int(
      'RECRUITMENT_ZALO_SENDER_RETRY_MAX_MS',
      300_000,
      500,
      86_400_000,
    ),
    connectTimeoutMs: int(
      'RECRUITMENT_ZALO_CONNECT_TIMEOUT_MS',
      5_000,
      200,
      60_000,
    ),
    responseTimeoutMs: int(
      'RECRUITMENT_ZALO_RESPONSE_TIMEOUT_MS',
      15_000,
      200,
      120_000,
    ),
    maxTextLength: int('RECRUITMENT_ZALO_MAX_TEXT_LENGTH', 2_000, 1, 10_000),
    // Chỉ nạp mã đã kiểm với tài liệu Zalo; mặc định rỗng = mọi từ chối thử lại có giới hạn.
    permanentErrors: codes('RECRUITMENT_ZALO_PERMANENT_ERRORS', ''),
    tokenErrors: codes('RECRUITMENT_ZALO_TOKEN_ERRORS', '-216'),
    maxRejectAttempts: int('RECRUITMENT_ZALO_MAX_REJECT_ATTEMPTS', 3, 1, 20),
  };
  if (config.retryMaxMs < config.retryBaseMs) {
    invalid.push('RECRUITMENT_ZALO_SENDER_RETRY_MAX_MS');
  }
  return invalid.length ? { invalid: [...new Set(invalid)] } : { config };
}

export function assertZaloOutboundConfig(
  get: (key: string) => string | undefined,
): void {
  if (!isZaloOutboundEnabled(get)) return;
  const result = readZaloOutboundConfig(get);
  if ('invalid' in result) {
    throw new Error(
      `${ZALO_OUTBOUND_CONFIG_ERROR}: RECRUITMENT_ZALO_OUTBOUND_ENABLED=true nhưng thiếu/sai ${result.invalid.join(', ')}`,
    );
  }
}

/** Khoá 32 byte, dạng base64 (`openssl rand -base64 32`) hoặc hex 64 ký tự. */
function decodeKey(raw: string): Buffer | null {
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
