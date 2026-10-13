import { ServiceUnavailableException } from '@nestjs/common';

import { RecruitmentAiRuntimeGuard } from '../ai/recruitment-ai-runtime.guard';
import {
  RecruitmentActorType,
  RuntimeControlScope,
} from '../recruitment.enums';
import { checkAiReply } from './ai-reply-policy';
import { RecruitmentAiLimitsService } from './recruitment-ai-limits.service';
import {
  AI_SAFETY_CONFIG_ERROR,
  assertAiSafetyConfig,
  DEFAULT_AI_LIMITS,
  pilotFingerprint,
  readAiSafetyConfig,
} from './recruitment-ai-safety.config';
import { RecruitmentRuntimeControlService } from './recruitment-runtime-control.service';

const env = (values: Record<string, string>) => (key: string) => values[key];

describe('readAiSafetyConfig', () => {
  it('mặc định: không pilot, trần mặc định, danh sách cho phép rỗng', () => {
    expect(readAiSafetyConfig(env({}))).toEqual({
      config: {
        pilotSenders: null,
        limits: DEFAULT_AI_LIMITS,
        replyPolicy: { allowedDomains: [], allowedContacts: [] },
      },
    });
  });

  it('pilot bật + fingerprint hợp lệ → chỉ các fingerprint đó (không giữ id thô)', () => {
    const fp = pilotFingerprint('oa-1', 'user-1');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    const read = readAiSafetyConfig(
      env({
        RECRUITMENT_PILOT_MODE: 'true',
        RECRUITMENT_PILOT_SENDER_FINGERPRINTS: ` ${fp.toUpperCase()} , `,
      }),
    );
    expect(read).toMatchObject({ config: { pilotSenders: [fp] } });
  });

  it.each([
    [
      'pilot bật nhưng danh sách rỗng',
      { RECRUITMENT_PILOT_MODE: 'true' },
      'RECRUITMENT_PILOT_SENDER_FINGERPRINTS',
    ],
    [
      'pilot với id thô thay vì fingerprint',
      {
        RECRUITMENT_PILOT_MODE: 'true',
        RECRUITMENT_PILOT_SENDER_FINGERPRINTS: '8812345678901234567',
      },
      'RECRUITMENT_PILOT_SENDER_FINGERPRINTS',
    ],
    [
      'trần không phải số nguyên dương',
      { RECRUITMENT_AI_MAX_TURNS_PER_DAY: '0' },
      'RECRUITMENT_AI_MAX_TURNS_PER_DAY',
    ],
    [
      'trần ngày người gửi < trần giờ',
      {
        RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR: '20',
        RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY: '5',
      },
      'RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY',
    ],
    [
      'ngân sách tháng < ngày',
      {
        RECRUITMENT_AI_DAILY_TOKEN_BUDGET: '1000',
        RECRUITMENT_AI_MONTHLY_TOKEN_BUDGET: '10',
      },
      'RECRUITMENT_AI_MONTHLY_TOKEN_BUDGET',
    ],
    [
      'miền sai định dạng',
      { RECRUITMENT_AI_REPLY_ALLOWED_DOMAINS: 'https://kidoedu.vn' },
      'RECRUITMENT_AI_REPLY_ALLOWED_DOMAINS',
    ],
  ])('%s → cấu hình sai (không boot), chỉ nêu tên biến', (_n, values, name) => {
    expect(readAiSafetyConfig(env(values))).toEqual({ invalid: [name] });
    expect(() => assertAiSafetyConfig(env(values))).toThrow(
      new RegExp(`${AI_SAFETY_CONFIG_ERROR}.*${name}`),
    );
  });
});

describe('checkAiReply', () => {
  const policy = {
    allowedDomains: ['kidoedu.vn'],
    allowedContacts: ['028 3812 3456', 'tuyendung@kidoedu.vn'],
  };
  const inbound = 'Em là Lan, sđt 0912 345 678, mail lan@example.com';

  it.each([
    ['Chào Lan, mình đã ghi nhận.', null],
    ['Mình ghi nhận SĐT 0912345678 và email lan@example.com của bạn.', null],
    ['Liên hệ 028.3812.3456 hoặc tuyendung@kidoedu.vn', null],
    ['Chi tiết: https://www.kidoedu.vn/tuyen-dung', null],
    ['Key của mình là sk-abcdefghijklmnop1234', 'SECRET_LIKE'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwx', 'SECRET_LIKE'],
    ['Header X-Recruitment-Subject: zalo:1:2', 'INTERNAL_MARKER'],
    ['Session agent:main:zalo:123:456', 'INTERNAL_MARKER'],
    ['Biến RECRUITMENT_CHANNEL_API_KEY', 'INTERNAL_MARKER'],
    ['Đây là system prompt của mình', 'INTERNAL_MARKER'],
    ['Gọi anh Nam +84 987 654 321', 'FOREIGN_CONTACT'],
    ['Mail cho hr.ca.nhan@gmail.com', 'FOREIGN_CONTACT'],
    ['Xem http://kidoedu.vn.evil.com/a', 'FOREIGN_URL'],
  ])('%j → %s', (reply, expected) => {
    expect(checkAiReply(reply, inbound, policy)).toBe(expected);
  });
});

describe('RecruitmentRuntimeControlService', () => {
  const HR = {
    type: RecruitmentActorType.HR,
    employeeId: 158,
    name: 'HR',
    roles: ['nhansu'],
  };
  const row = {
    ai_halted: false,
    worker_halted: true,
    outbound_halted: false,
    reason: 'bảo trì',
    updated_by: 158,
    updated_at: new Date('2026-10-13T01:00:00Z'),
  };

  function service(query: jest.Mock) {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    return {
      svc: new RecruitmentRuntimeControlService({ query } as any, audit as any),
      audit,
    };
  }

  it('đọc dòng điều khiển', async () => {
    const { svc } = service(jest.fn().mockResolvedValue([row]));
    await expect(svc.state()).resolves.toMatchObject({
      aiHalted: false,
      workerHalted: true,
      outboundHalted: false,
      failClosed: false,
    });
  });

  it.each([
    ['DB lỗi', jest.fn().mockRejectedValue(new Error('db down'))],
    ['không có dòng', jest.fn().mockResolvedValue([])],
  ])(
    '%s → FAIL-CLOSED: coi như dừng cả AI / worker / outbound',
    async (_n, query) => {
      const { svc } = service(query);
      await expect(svc.state()).resolves.toMatchObject({
        aiHalted: true,
        workerHalted: true,
        outboundHalted: true,
        failClosed: true,
      });
    },
  );

  it('maxAge > 0 dùng lại bản đọc gần đây; 0 luôn đọc mới', async () => {
    const query = jest.fn().mockResolvedValue([row]);
    const { svc } = service(query);
    await svc.state(1000);
    await svc.state(1000);
    expect(query).toHaveBeenCalledTimes(1);
    await svc.state();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('dừng: chỉ đổi đúng cột của phạm vi, ghi lý do + người làm, audit before/after', async () => {
    const after = { ...row, ai_halted: true, outbound_halted: true };
    const query = jest
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([[{ id: 1 }], 1])
      .mockResolvedValueOnce([after]);
    const { svc, audit } = service(query);
    await expect(
      svc.set(
        [
          RuntimeControlScope.AI,
          RuntimeControlScope.OUTBOUND,
          RuntimeControlScope.AI,
        ],
        true,
        'nghi lộ dữ liệu',
        HR,
      ),
    ).resolves.toMatchObject({ aiHalted: true, outboundHalted: true });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/SET "ai_halted" = \$1, "outbound_halted" = \$1,/);
    expect(sql).not.toMatch(/worker_halted/);
    expect(params).toEqual([true, 'nghi lộ dữ liệu', 158]);
    expect(audit.record).toHaveBeenCalledWith({
      actor: HR,
      action: 'RUNTIME_STOP',
      entity: 'runtime-controls',
      entityId: 1,
      context: {
        scopes: ['AI', 'OUTBOUND'],
        reason: 'nghi lộ dữ liệu',
        before: { ai: false, worker: true, outbound: false },
        after: { ai: true, worker: true, outbound: true },
      },
    });
  });

  it('thiếu dòng khi đổi → 503, không audit', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([[], 0]);
    const { svc, audit } = service(query);
    await expect(
      svc.set([RuntimeControlScope.WORKER], false, 'mở lại', HR),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('RecruitmentRuntimeControlService.haltAiIfRunning', () => {
  const SYSTEM = { type: RecruitmentActorType.SYSTEM, name: 'system' };
  const running = {
    ai_halted: true,
    worker_halted: false,
    outbound_halted: false,
    reason: 'AI_LIMIT DAILY_TOKENS 5100/5000',
    updated_by: null,
    updated_at: new Date('2026-10-13T01:48:00Z'),
  };
  const make = (query: jest.Mock) => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    return {
      svc: new RecruitmentRuntimeControlService({ query } as any, audit as any),
      audit,
    };
  };

  it('đổi được trạng thái (đang chạy → dừng) → audit RUNTIME_STOP hệ thống, trả state mới', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([[{ id: 1 }], 1])
      .mockResolvedValueOnce([running]);
    const { svc, audit } = make(query);
    await expect(
      svc.haltAiIfRunning('AI_LIMIT DAILY_TOKENS 5100/5000', SYSTEM as any),
    ).resolves.toMatchObject({ aiHalted: true });
    expect(query.mock.calls[0][0]).toMatch(/WHERE id = 1 AND NOT ai_halted/);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RUNTIME_STOP',
        context: expect.objectContaining({
          scopes: ['AI'],
          before: { ai: false, worker: false, outbound: false },
          after: { ai: true, worker: false, outbound: false },
        }),
      }),
    );
  });

  it('AI đã dừng sẵn → null, không audit (nhiều worker chạm trần cùng lúc → 1 audit)', async () => {
    const query = jest.fn().mockResolvedValueOnce([[], 0]);
    const { svc, audit } = make(query);
    await expect(
      svc.haltAiIfRunning('AI_LIMIT DAILY_TURNS 300/300', SYSTEM as any),
    ).resolves.toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('RecruitmentAiRuntimeGuard', () => {
  it('AI đang dừng (hoặc fail-closed) → 503 AI_HALTED', async () => {
    const guard = new RecruitmentAiRuntimeGuard({
      state: jest.fn().mockResolvedValue({ aiHalted: true }),
    } as any);
    const error = await guard.canActivate().catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toMatchObject({ code: 'AI_HALTED' });
  });

  it('AI chạy → cho qua (dùng bản đọc ≤ 1 giây)', async () => {
    const state = jest.fn().mockResolvedValue({ aiHalted: false });
    const guard = new RecruitmentAiRuntimeGuard({ state } as any);
    await expect(guard.canActivate()).resolves.toBe(true);
    expect(state).toHaveBeenCalledWith(1000);
  });
});

describe('RecruitmentAiLimitsService.evaluate', () => {
  const limits = { ...DEFAULT_AI_LIMITS };
  const usage = (patch: Record<string, number>) =>
    jest.fn().mockResolvedValue([
      {
        day_turns: 0,
        day_tokens: '0',
        month_tokens: '0',
        sender_hour: 0,
        sender_day: 0,
        ...patch,
      },
    ]);
  const evaluate = (query: jest.Mock) =>
    new RecruitmentAiLimitsService({ query } as any).evaluate(
      { channelAccountId: 'oa', externalSenderId: 'u1' },
      limits,
    );

  it('dưới mọi trần → ok', async () => {
    await expect(evaluate(usage({ sender_hour: 9 }))).resolves.toEqual({
      ok: true,
    });
  });

  it.each([
    [{ month_tokens: 500_000_000 }, 'GLOBAL', 'MONTHLY_TOKENS'],
    [{ day_tokens: 30_000_000 }, 'GLOBAL', 'DAILY_TOKENS'],
    [{ day_turns: 300 }, 'GLOBAL', 'DAILY_TURNS'],
    [{ sender_hour: 10 }, 'SENDER', 'SENDER_HOURLY_TURNS'],
    [{ sender_day: 40 }, 'SENDER', 'SENDER_DAILY_TURNS'],
  ])('%j → %s %s', async (patch, scope, limit) => {
    await expect(evaluate(usage(patch))).resolves.toMatchObject({
      ok: false,
      scope,
      limit,
    });
  });

  it('toàn hệ thống được kiểm TRƯỚC người gửi', async () => {
    await expect(
      evaluate(usage({ sender_hour: 99, day_turns: 300 })),
    ).resolves.toMatchObject({ scope: 'GLOBAL', limit: 'DAILY_TURNS' });
  });

  it('truy vấn theo đúng OA + người gửi, ngày tháng theo giờ Việt Nam', async () => {
    const query = usage({});
    await evaluate(query);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['oa', 'u1']);
    expect(sql).toMatch(/Asia\/Ho_Chi_Minh/);
    expect(sql).toMatch(/ai_control_version IS NOT NULL/);
  });
});
