import { createHash } from 'crypto';

/**
 * Cấu hình an toàn AI (P3-7.3 / G8) — đọc từ env, kiểm lúc khởi động (sai → không boot).
 *
 * Pilot: `RECRUITMENT_PILOT_MODE=true` + `RECRUITMENT_PILOT_SENDER_FINGERPRINTS` (danh sách
 * fingerprint `pilotFingerprint(oaId, zaloUserId)`, phân cách bằng dấu phẩy). Bật pilot →
 * worker CHỈ xử lý tin của các người gửi này; tin AI tới người khác bị chặn ở cổng gửi.
 * Không lưu id Zalo thô trong cấu hình.
 *
 * Trần (mặc định an toàn): lượt AI / người gửi / giờ & / 24 giờ; lượt AI toàn hệ thống / ngày;
 * token / ngày, token / tháng (ngày tháng theo giờ Việt Nam). Vượt trần người gửi → HR trả lời;
 * vượt trần toàn hệ thống → tự dừng AI (dừng khẩn) + cảnh báo HR.
 *
 * Chính sách câu trả lời: miền URL được phép và liên hệ (số điện thoại / email) được phép —
 * ngoài danh sách thì câu trả lời không được gửi.
 */
export interface AiLimits {
  maxTurnsPerSenderHour: number;
  maxTurnsPerSenderDay: number;
  maxTurnsPerDay: number;
  dailyTokenBudget: number;
  monthlyTokenBudget: number;
  /** Dung lượng tối đa dành trước cho một lượt provider, tính vào ngân sách tới hết kỳ. */
  tokenReservationPerTurn: number;
}

export interface AiReplyPolicyConfig {
  allowedDomains: string[];
  allowedContacts: string[];
}

export interface AiSafetyConfig {
  /** `null` = không ở chế độ pilot. */
  pilotSenders: string[] | null;
  limits: AiLimits;
  replyPolicy: AiReplyPolicyConfig;
}

export const AI_SAFETY_CONFIG_ERROR = 'RECRUITMENT_AI_SAFETY_CONFIG_INVALID';

export const DEFAULT_AI_LIMITS: AiLimits = Object.freeze({
  maxTurnsPerSenderHour: 10,
  maxTurnsPerSenderDay: 40,
  maxTurnsPerDay: 300,
  // ~90k token / lượt (phần lớn là cache ngữ cảnh) × 300 lượt.
  dailyTokenBudget: 30_000_000,
  monthlyTokenBudget: 500_000_000,
  tokenReservationPerTurn: 200_000,
});

const FINGERPRINT = /^[0-9a-f]{16}$/;
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** Fingerprint pilot của một người gửi: 16 ký tự đầu sha256 của `oaId:zaloUserId`. */
export function pilotFingerprint(oaId: string, userId: string): string {
  return createHash('sha256')
    .update(`${oaId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
}

export function readAiSafetyConfig(
  get: (key: string) => string | undefined,
): { config: AiSafetyConfig } | { invalid: string[] } {
  const invalid: string[] = [];
  const list = (key: string) =>
    (get(key) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  let pilotSenders: string[] | null = null;
  if (get('RECRUITMENT_PILOT_MODE')?.trim() === 'true') {
    pilotSenders = list('RECRUITMENT_PILOT_SENDER_FINGERPRINTS').map((v) =>
      v.toLowerCase(),
    );
    if (
      !pilotSenders.length ||
      !pilotSenders.every((v) => FINGERPRINT.test(v))
    ) {
      invalid.push('RECRUITMENT_PILOT_SENDER_FINGERPRINTS');
    }
  }

  const int = (key: string, fallback: number, min: number, max: number) => {
    const raw = get(key)?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      invalid.push(key);
      return fallback;
    }
    return value;
  };
  const limits: AiLimits = {
    maxTurnsPerSenderHour: int(
      'RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR',
      DEFAULT_AI_LIMITS.maxTurnsPerSenderHour,
      1,
      1_000,
    ),
    maxTurnsPerSenderDay: int(
      'RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY',
      DEFAULT_AI_LIMITS.maxTurnsPerSenderDay,
      1,
      10_000,
    ),
    maxTurnsPerDay: int(
      'RECRUITMENT_AI_MAX_TURNS_PER_DAY',
      DEFAULT_AI_LIMITS.maxTurnsPerDay,
      1,
      1_000_000,
    ),
    dailyTokenBudget: int(
      'RECRUITMENT_AI_DAILY_TOKEN_BUDGET',
      DEFAULT_AI_LIMITS.dailyTokenBudget,
      1,
      2_000_000_000,
    ),
    monthlyTokenBudget: int(
      'RECRUITMENT_AI_MONTHLY_TOKEN_BUDGET',
      DEFAULT_AI_LIMITS.monthlyTokenBudget,
      1,
      2_000_000_000,
    ),
    tokenReservationPerTurn: int(
      'RECRUITMENT_AI_TOKEN_RESERVATION_PER_TURN',
      DEFAULT_AI_LIMITS.tokenReservationPerTurn,
      1,
      1_000_000,
    ),
  };
  if (limits.maxTurnsPerSenderDay < limits.maxTurnsPerSenderHour) {
    invalid.push('RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY');
  }
  if (limits.monthlyTokenBudget < limits.dailyTokenBudget) {
    invalid.push('RECRUITMENT_AI_MONTHLY_TOKEN_BUDGET');
  }
  if (limits.dailyTokenBudget < limits.tokenReservationPerTurn) {
    invalid.push('RECRUITMENT_AI_DAILY_TOKEN_BUDGET');
  }

  const allowedDomains = list('RECRUITMENT_AI_REPLY_ALLOWED_DOMAINS').map((v) =>
    v.toLowerCase(),
  );
  if (!allowedDomains.every((v) => DOMAIN.test(v))) {
    invalid.push('RECRUITMENT_AI_REPLY_ALLOWED_DOMAINS');
  }
  const allowedContacts = list('RECRUITMENT_AI_REPLY_ALLOWED_CONTACTS');

  return invalid.length
    ? { invalid: [...new Set(invalid)] }
    : {
        config: {
          pilotSenders,
          limits,
          replyPolicy: { allowedDomains, allowedContacts },
        },
      };
}

export function assertAiSafetyConfig(
  get: (key: string) => string | undefined,
): void {
  const result = readAiSafetyConfig(get);
  if ('invalid' in result) {
    throw new Error(
      `${AI_SAFETY_CONFIG_ERROR}: thiếu/sai ${result.invalid.join(', ')}`,
    );
  }
}
