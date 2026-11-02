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

describe('RecruitmentAiAuthGuard — kênh tin cậy & subject', () => {
  const CHANNEL = 'c'.repeat(40);

  function request(authorization: string | undefined, subject?: unknown) {
    const headers: Record<string, unknown> = {};
    if (authorization !== undefined) headers.authorization = authorization;
    if (subject !== undefined) headers['x-recruitment-subject'] = subject;
    const req: any = {
      headers,
      method: 'POST',
      url: '/recruitment/ai/x',
      ip: '127.0.0.1',
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    } as any;
    return { req, ctx };
  }

  function guard(extra: Record<string, string> = {}) {
    return new RecruitmentAiAuthGuard(
      config({
        RECRUITMENT_AI_ENABLED: 'true',
        RECRUITMENT_AI_API_KEY: KEY,
        RECRUITMENT_CHANNEL_API_KEY: CHANNEL,
        ...extra,
      }),
    );
  }

  function code(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (error) {
      return ((error as HttpException).getResponse() as { code?: string }).code;
    }
    return undefined;
  }

  it('key kênh + subject hợp lệ → cho qua, gắn subject vào request', () => {
    const { req, ctx } = request(`Bearer ${CHANNEL}`, 'zalo:111:222');
    expect(guard().canActivate(ctx)).toBe(true);
    expect(req.recruitmentAi).toEqual({
      credential: 'channel',
      subject: { channel: 'zalo', oaId: '111', userId: '222' },
    });
  });

  it('key AI chung, không subject → cho qua (chế độ Phase 2), subject = null', () => {
    const { req, ctx } = request(`Bearer ${KEY}`);
    expect(guard().canActivate(ctx)).toBe(true);
    expect(req.recruitmentAi).toEqual({ credential: 'ai', subject: null });
  });

  it('key AI chung mà tự gửi subject → 403 SUBJECT_NOT_TRUSTED (không giả danh được)', () => {
    const { ctx } = request(`Bearer ${KEY}`, 'zalo:111:victim');
    expect(code(() => guard().canActivate(ctx))).toBe('SUBJECT_NOT_TRUSTED');
  });

  it('REQUIRE_SUBJECT=true → key AI chung bị từ chối: SUBJECT_REQUIRED', () => {
    const { ctx } = request(`Bearer ${KEY}`);
    expect(
      code(() =>
        guard({ RECRUITMENT_AI_REQUIRE_SUBJECT: 'true' }).canActivate(ctx),
      ),
    ).toBe('SUBJECT_REQUIRED');
  });

  it('REQUIRE_SUBJECT=true + key kênh + subject → cho qua', () => {
    const { ctx } = request(`Bearer ${CHANNEL}`, 'zalo:111:222');
    expect(
      guard({ RECRUITMENT_AI_REQUIRE_SUBJECT: 'true' }).canActivate(ctx),
    ).toBe(true);
  });

  it('key kênh nhưng thiếu subject → 403 SUBJECT_REQUIRED', () => {
    const { ctx } = request(`Bearer ${CHANNEL}`);
    expect(code(() => guard().canActivate(ctx))).toBe('SUBJECT_REQUIRED');
  });

  it.each([
    ['sai định dạng', 'zalo:111'],
    ['OA legacy', 'zalo:legacy:222'],
    ['header lặp', ['zalo:1:2', 'zalo:1:3']],
  ])('key kênh + subject %s → 403 SUBJECT_INVALID', (_label, subject) => {
    const { ctx } = request(`Bearer ${CHANNEL}`, subject);
    expect(code(() => guard().canActivate(ctx))).toBe('SUBJECT_INVALID');
  });

  it('key kênh trùng key AI → 503 RECRUITMENT_AI_MISCONFIGURED', () => {
    const { ctx } = request(`Bearer ${KEY}`);
    expect(
      code(() => guard({ RECRUITMENT_CHANNEL_API_KEY: KEY }).canActivate(ctx)),
    ).toBe('RECRUITMENT_AI_MISCONFIGURED');
  });

  it('chỉ cấu hình key kênh (production) → key kênh dùng được, key khác 401', () => {
    const only = new RecruitmentAiAuthGuard(
      config({
        RECRUITMENT_AI_ENABLED: 'true',
        RECRUITMENT_CHANNEL_API_KEY: CHANNEL,
      }),
    );
    expect(only.canActivate(request(`Bearer ${CHANNEL}`, 'zalo:1:2').ctx)).toBe(
      true,
    );
    expect(code(() => only.canActivate(request(`Bearer ${KEY}`).ctx))).toBe(
      'INVALID_API_KEY',
    );
  });
});
