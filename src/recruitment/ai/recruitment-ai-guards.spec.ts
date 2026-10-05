import {
  HttpException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  apiKeyMatches,
  RecruitmentAiAuthGuard,
} from './recruitment-ai-auth.guard';
import { RecruitmentAiRateLimitGuard } from './recruitment-ai-rate-limit.guard';

const KEY = 'k'.repeat(40);

function config(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] } as any;
}

function context(authorization?: string) {
  const res = { setHeader: jest.fn() };
  const req = {
    headers: authorization === undefined ? {} : { authorization },
    method: 'GET',
    url: '/recruitment/ai/jobs/active',
    ip: '127.0.0.1',
  };
  return {
    res,
    ctx: {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as any,
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('RecruitmentAiAuthGuard', () => {
  const enabled = config({
    RECRUITMENT_AI_ENABLED: 'true',
    RECRUITMENT_AI_API_KEY: KEY,
  });

  it('đúng API key → cho qua', () => {
    expect(
      new RecruitmentAiAuthGuard(enabled).canActivate(
        context(`Bearer ${KEY}`).ctx,
      ),
    ).toBe(true);
  });

  it.each([
    ['thiếu header', undefined],
    ['sai key', `Bearer ${'x'.repeat(40)}`],
    ['key đúng nhưng thiếu "Bearer"', KEY],
    ['key là tiền tố của key thật', `Bearer ${KEY.slice(0, 39)}`],
  ])('%s → 401 INVALID_API_KEY', (_label, header) => {
    const guard = new RecruitmentAiAuthGuard(enabled);
    expect(() => guard.canActivate(context(header).ctx)).toThrow(
      UnauthorizedException,
    );
  });

  it('tắt bằng RECRUITMENT_AI_ENABLED → 503 kể cả key đúng', () => {
    const guard = new RecruitmentAiAuthGuard(
      config({ RECRUITMENT_AI_ENABLED: 'false', RECRUITMENT_AI_API_KEY: KEY }),
    );
    expect(() => guard.canActivate(context(`Bearer ${KEY}`).ctx)).toThrow(
      ServiceUnavailableException,
    );
  });

  it('key cấu hình quá ngắn coi như chưa cấu hình → 503', () => {
    const guard = new RecruitmentAiAuthGuard(
      config({
        RECRUITMENT_AI_ENABLED: 'true',
        RECRUITMENT_AI_API_KEY: 'short',
      }),
    );
    expect(() => guard.canActivate(context('Bearer short').ctx)).toThrow(
      ServiceUnavailableException,
    );
  });

  it('không log key, kể cả key sai', () => {
    const guard = new RecruitmentAiAuthGuard(enabled);
    const warn = jest
      .spyOn((guard as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const wrong = 'w'.repeat(40);

    expect(() => guard.canActivate(context(`Bearer ${wrong}`).ctx)).toThrow();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(wrong);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });

  it('so sánh an toàn với chuỗi khác độ dài (không ném lỗi)', () => {
    expect(apiKeyMatches('a', KEY)).toBe(false);
    expect(apiKeyMatches(KEY, KEY)).toBe(true);
  });
});

describe('RecruitmentAiRateLimitGuard', () => {
  it('vượt hạn mức/phút → 429 kèm Retry-After', () => {
    const guard = new RecruitmentAiRateLimitGuard(
      config({ RECRUITMENT_AI_RATE_LIMIT_PER_MINUTE: '2' }),
    );
    const { ctx, res } = context(`Bearer ${KEY}`);

    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    try {
      guard.canActivate(ctx);
      fail('phải chặn request thứ 3');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
      expect(res.setHeader).toHaveBeenCalledWith(
        'Retry-After',
        expect.any(String),
      );
    }
  });
});
