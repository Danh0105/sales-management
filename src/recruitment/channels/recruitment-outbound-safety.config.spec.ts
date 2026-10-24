import {
  OUTBOUND_SAFETY_CONFIG_ERROR,
  assertOutboundSafetyConfig,
  readOutboundSafetyConfig,
} from './recruitment-outbound-safety.config';

const production = {
  RECRUITMENT_PRODUCTION_MODE: 'true',
  RECRUITMENT_PILOT_MODE: 'false',
  RECRUITMENT_ZALO_OUTBOUND_ENABLED: 'true',
  RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED: 'false',
  RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS: '168',
  RECRUITMENT_ZALO_FREE_WINDOW_HOURS: '48',
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW: '5',
  RECRUITMENT_ZALO_RECIPIENT_WINDOW_HOURS: '5',
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY: '8',
  RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY: '200',
  RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND: '100000',
  RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND: '2000000',
  RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND: '500',
};

const read = (env: Record<string, string>) => (key: string) => env[key];

describe('recruitment outbound production safety config', () => {
  it('đòi hạn mức tường minh và hai mode loại trừ nhau', () => {
    expect(readOutboundSafetyConfig(read(production))).toEqual({
      config: {
        productionMode: true,
        interactionWindowHours: 168,
        freeWindowHours: 48,
        maxRequestsPerRecipientWindow: 5,
        recipientWindowHours: 5,
        maxRequestsPerRecipientDay: 8,
        maxRequestsPerDay: 200,
        dailyCostBudgetVnd: 100000,
        monthlyCostBudgetVnd: 2000000,
        estimatedPaidMessageCostVnd: 500,
      },
    });

    expect(() =>
      assertOutboundSafetyConfig(
        read({ ...production, RECRUITMENT_PILOT_MODE: 'true' }),
      ),
    ).toThrow(OUTBOUND_SAFETY_CONFIG_ERROR);
    expect(() =>
      assertOutboundSafetyConfig(
        read({
          ...production,
          RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED: 'true',
        }),
      ),
    ).toThrow(/RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED/);
  });

  it('outbound bật mà không pilot/production → fail closed', () => {
    expect(() =>
      assertOutboundSafetyConfig(
        read({ RECRUITMENT_ZALO_OUTBOUND_ENABLED: 'true' }),
      ),
    ).toThrow(/RECRUITMENT_PRODUCTION_MODE/);
  });

  it('production thiếu một giới hạn → không khởi động', () => {
    const env = { ...production };
    delete (env as Partial<typeof production>)
      .RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY;
    expect(() => assertOutboundSafetyConfig(read(env))).toThrow(
      /RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY/,
    );
  });

  it('quota cửa sổ trượt không được lớn hơn quota ngày', () => {
    expect(() =>
      assertOutboundSafetyConfig(
        read({
          ...production,
          RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW: '9',
        }),
      ),
    ).toThrow(/RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW/);
  });

  it('budget 0 là chế độ chặn tin tính phí, nhưng đơn giá ước lượng phải dương', () => {
    expect(() =>
      assertOutboundSafetyConfig(
        read({
          ...production,
          RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND: '0',
          RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND: '0',
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertOutboundSafetyConfig(
        read({
          ...production,
          RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND: '0',
        }),
      ),
    ).toThrow(/RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND/);
  });

  it('pilot hiện tại vẫn dùng mặc định hạn chế và grant', () => {
    expect(
      readOutboundSafetyConfig(
        read({
          RECRUITMENT_PILOT_MODE: 'true',
          RECRUITMENT_ZALO_OUTBOUND_ENABLED: 'true',
          RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED: 'true',
        }),
      ),
    ).toMatchObject({ config: { productionMode: false } });
  });
});
