/**
 * Cửa an toàn outbound production. Pilot và production là hai chế độ loại trừ nhau:
 * - pilot: allowlist + grant một lần của Owner;
 * - production: không allowlist/grant, nhưng bắt buộc interaction window + quota/cost.
 *
 * Production không có giá trị mặc định cho hạn mức: Owner phải chốt rõ trước khi bật.
 */
export interface RecruitmentOutboundSafetyConfig {
  productionMode: boolean;
  interactionWindowHours: number;
  freeWindowHours: number;
  maxRequestsPerRecipientWindow: number;
  recipientWindowHours: number;
  maxRequestsPerRecipientDay: number;
  maxRequestsPerDay: number;
  dailyCostBudgetVnd: number;
  monthlyCostBudgetVnd: number;
  estimatedPaidMessageCostVnd: number;
}

export const OUTBOUND_SAFETY_CONFIG_ERROR =
  'RECRUITMENT_OUTBOUND_SAFETY_CONFIG_INVALID';

const REQUIRED_LIMITS = {
  RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS: [1, 168],
  RECRUITMENT_ZALO_FREE_WINDOW_HOURS: [1, 168],
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW: [1, 1_000],
  RECRUITMENT_ZALO_RECIPIENT_WINDOW_HOURS: [1, 24],
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY: [1, 1_000],
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY: [1, 1_000_000],
  RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND: [0, 2_000_000_000],
  RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND: [0, 2_000_000_000],
  // Luôn phải > 0 trong production. Owner có thể đặt budget = 0 để chặn hoàn
  // toàn tin tính phí; không được biến chi phí ước lượng thành 0 để lách budget.
  RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND: [1, 10_000_000],
} as const;

export function readOutboundSafetyConfig(
  get: (key: string) => string | undefined,
): { config: RecruitmentOutboundSafetyConfig } | { invalid: string[] } {
  const invalid: string[] = [];
  const flag = (key: string) => {
    const raw = get(key)?.trim() ?? '';
    if (raw && raw !== 'true' && raw !== 'false') invalid.push(key);
    return raw === 'true';
  };
  const productionMode = flag('RECRUITMENT_PRODUCTION_MODE');
  const pilotMode = flag('RECRUITMENT_PILOT_MODE');
  const outboundEnabled = flag('RECRUITMENT_ZALO_OUTBOUND_ENABLED');
  const grantRequired = flag('RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED');

  if (productionMode && pilotMode) {
    invalid.push('RECRUITMENT_PRODUCTION_MODE/RECRUITMENT_PILOT_MODE');
  }
  if (productionMode && grantRequired) {
    invalid.push('RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED');
  }
  // Outbound thật không được chạy ngoài một trong hai mode đã kiểm soát.
  if (outboundEnabled && !productionMode && !pilotMode) {
    invalid.push('RECRUITMENT_PRODUCTION_MODE');
  }

  const readRequiredInt = (
    key: keyof typeof REQUIRED_LIMITS,
    fallback: number,
  ) => {
    const raw = get(key)?.trim() ?? '';
    if (!productionMode && !raw) return fallback;
    const [min, max] = REQUIRED_LIMITS[key];
    const value = Number(raw);
    if (!raw || !Number.isSafeInteger(value) || value < min || value > max) {
      invalid.push(key);
      return fallback;
    }
    return value;
  };

  const config: RecruitmentOutboundSafetyConfig = {
    productionMode,
    interactionWindowHours: readRequiredInt(
      'RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS',
      168,
    ),
    freeWindowHours: readRequiredInt('RECRUITMENT_ZALO_FREE_WINDOW_HOURS', 48),
    maxRequestsPerRecipientWindow: readRequiredInt(
      'RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW',
      5,
    ),
    recipientWindowHours: readRequiredInt(
      'RECRUITMENT_ZALO_RECIPIENT_WINDOW_HOURS',
      24,
    ),
    maxRequestsPerRecipientDay: readRequiredInt(
      'RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY',
      5,
    ),
    maxRequestsPerDay: readRequiredInt(
      'RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY',
      100,
    ),
    dailyCostBudgetVnd: readRequiredInt(
      'RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND',
      0,
    ),
    monthlyCostBudgetVnd: readRequiredInt(
      'RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND',
      0,
    ),
    estimatedPaidMessageCostVnd: readRequiredInt(
      'RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND',
      0,
    ),
  };

  if (config.freeWindowHours > config.interactionWindowHours) {
    invalid.push('RECRUITMENT_ZALO_FREE_WINDOW_HOURS');
  }
  if (config.maxRequestsPerRecipientDay > config.maxRequestsPerDay) {
    invalid.push('RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY');
  }
  if (
    config.maxRequestsPerRecipientWindow > config.maxRequestsPerRecipientDay
  ) {
    invalid.push('RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW');
  }
  if (config.monthlyCostBudgetVnd < config.dailyCostBudgetVnd) {
    invalid.push('RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND');
  }
  return invalid.length ? { invalid: [...new Set(invalid)] } : { config };
}

export function assertOutboundSafetyConfig(
  get: (key: string) => string | undefined,
): void {
  const result = readOutboundSafetyConfig(get);
  if ('invalid' in result) {
    throw new Error(
      `${OUTBOUND_SAFETY_CONFIG_ERROR}: thiếu/sai ${result.invalid.join(', ')}`,
    );
  }
}
