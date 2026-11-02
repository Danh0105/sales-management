import { LEGACY_ZALO_OA_ID } from '../ai/recruitment-ai-subject';
import type { OpenClawClientConfig } from './openclaw-responses.client';

/**
 * Cấu hình worker xử lý event Zalo OA tuyển dụng → OpenClaw. Cờ
 * `RECRUITMENT_WORKER_ENABLED` mặc định tắt (3010/3011 không chạy worker).
 * Bật mà thiếu/sai → app không khởi động; lỗi chỉ nêu **tên** biến.
 */
export interface RecruitmentWorkerConfig {
  /** Worker chỉ xử lý event của đúng OA tuyển dụng (`RECRUITMENT_ZALO_OA_ID`). */
  oaId: string;
  openclaw: OpenClawClientConfig;
  /** Số lượt xử lý song song trong một process (mỗi lượt một người gửi khác nhau). */
  concurrency: number;
  pollMs: number;
  leaseMs: number;
  /** Chờ chừng này kể từ lúc nhận mới xử lý — để tin tới lệch thứ tự kịp xếp hàng. */
  settleMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  janitorMs: number;
}

export const RECRUITMENT_WORKER_CONFIG_ERROR =
  'RECRUITMENT_WORKER_CONFIG_INVALID';

/** Nội dung tin trong inbox giữ tối đa 7 ngày (chính sách đã chốt cho P3-4). */
export const EVENT_TEXT_RETENTION_DAYS = 7;

/** Lượt chạy xong mà kết quả không dùng được (model) thì chỉ thử tối đa chừng này lần. */
export const MAX_AGENT_ATTEMPTS = 3;

const OA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_ID = /^[a-z0-9_-]{1,64}$/;

export function isRecruitmentWorkerEnabled(
  get: (key: string) => string | undefined,
): boolean {
  return get('RECRUITMENT_WORKER_ENABLED') === 'true';
}

export function readRecruitmentWorkerConfig(
  get: (key: string) => string | undefined,
): { config: RecruitmentWorkerConfig } | { invalid: string[] } {
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

  const oaId = text('RECRUITMENT_ZALO_OA_ID');
  if (!OA_ID.test(oaId) || oaId === LEGACY_ZALO_OA_ID) {
    invalid.push('RECRUITMENT_ZALO_OA_ID');
  }
  const url = text('RECRUITMENT_OPENCLAW_URL');
  if (!isHttpUrl(url)) invalid.push('RECRUITMENT_OPENCLAW_URL');
  const token = text('RECRUITMENT_OPENCLAW_TOKEN');
  if (token.length < 32) invalid.push('RECRUITMENT_OPENCLAW_TOKEN');
  const agentId = text('RECRUITMENT_OPENCLAW_AGENT_ID', 'main');
  if (!AGENT_ID.test(agentId)) invalid.push('RECRUITMENT_OPENCLAW_AGENT_ID');

  const timeoutMs = int(
    'RECRUITMENT_OPENCLAW_TIMEOUT_MS',
    240_000,
    1_000,
    900_000,
  );
  const concurrency = int('RECRUITMENT_WORKER_CONCURRENCY', 2, 1, 16);
  const pollMs = int('RECRUITMENT_WORKER_POLL_MS', 2_000, 100, 60_000);
  const leaseMs = int('RECRUITMENT_WORKER_LEASE_MS', 300_000, 3_000, 3_600_000);
  const settleMs = int('RECRUITMENT_WORKER_SETTLE_MS', 2_000, 0, 60_000);
  const retryBaseMs = int(
    'RECRUITMENT_WORKER_RETRY_BASE_MS',
    30_000,
    500,
    3_600_000,
  );
  const retryMaxMs = int(
    'RECRUITMENT_WORKER_RETRY_MAX_MS',
    900_000,
    500,
    86_400_000,
  );
  const janitorMs = int(
    'RECRUITMENT_WORKER_JANITOR_MS',
    60_000,
    500,
    3_600_000,
  );
  if (retryMaxMs < retryBaseMs) invalid.push('RECRUITMENT_WORKER_RETRY_MAX_MS');

  if (invalid.length) return { invalid: [...new Set(invalid)] };
  return {
    config: {
      oaId,
      openclaw: { url, token, agentId, timeoutMs },
      concurrency,
      pollMs,
      leaseMs,
      settleMs,
      retryBaseMs,
      retryMaxMs,
      janitorMs,
    },
  };
}

export function assertRecruitmentWorkerConfig(
  get: (key: string) => string | undefined,
): void {
  if (!isRecruitmentWorkerEnabled(get)) return;
  const result = readRecruitmentWorkerConfig(get);
  if ('invalid' in result) {
    throw new Error(
      `${RECRUITMENT_WORKER_CONFIG_ERROR}: RECRUITMENT_WORKER_ENABLED=true nhưng thiếu/sai ${result.invalid.join(', ')}`,
    );
  }
}

/** Giãn cách thử lại: base · 2^(lần-1), trần `retryMaxMs`. */
export function retryDelayMs(
  config: Pick<RecruitmentWorkerConfig, 'retryBaseMs' | 'retryMaxMs'>,
  attempt: number,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 20);
  return Math.min(config.retryBaseMs * 2 ** exponent, config.retryMaxMs);
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
