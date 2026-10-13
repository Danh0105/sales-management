import {
  classifyOpenClawResponse,
  usageOf,
  invokeOpenClaw,
  OPENCLAW_EMPTY_REPLY_TEXT,
  type OpenClawClientConfig,
} from './openclaw-responses.client';

const CONFIG: OpenClawClientConfig = {
  url: 'http://openclaw-gateway:18789/',
  token: 'gateway-token-0123456789abcdef0123456789',
  agentId: 'main',
  timeoutMs: 1000,
};

function completed(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
    ...extra,
  };
}

const failed = (code: string) => ({
  status: 'failed',
  output: [],
  error: { code, message: 'x' },
});

describe('classifyOpenClawResponse', () => {
  it('200 completed có text → thành công', () => {
    expect(
      classifyOpenClawResponse(200, completed('Chào bạn, mình hỗ trợ nhé.')),
    ).toEqual({
      ok: true,
      text: 'Chào bạn, mình hỗ trợ nhé.',
      responseId: 'resp_1',
      usage: null,
    });
  });

  it('usage (định dạng OpenAI Responses của gateway) → token của lượt', () => {
    const body = {
      ...(completed('Chào bạn.') as Record<string, unknown>),
      usage: {
        input_tokens: 89_527,
        input_tokens_details: {
          cached_tokens: 76_063,
          cache_write_tokens: 13_440,
        },
        output_tokens: 926,
        output_tokens_details: { reasoning_tokens: 287 },
        total_tokens: 90_453,
      },
    };
    expect(classifyOpenClawResponse(200, body)).toMatchObject({
      ok: true,
      usage: { input: 89_527, cached: 76_063, output: 926, total: 90_453 },
    });
  });

  it.each([
    ['không có usage', undefined],
    ['usage sai kiểu', { input_tokens: 'nhiều', output_tokens: 5 }],
    ['token âm', { input_tokens: -1, output_tokens: 5 }],
  ])('%s → usage null, lượt vẫn thành công', (_n, usage) => {
    const body = { ...(completed('Chào.') as Record<string, unknown>), usage };
    expect(classifyOpenClawResponse(200, body)).toMatchObject({
      ok: true,
      usage: null,
    });
  });

  it('thiếu total_tokens → total = input + output', () => {
    expect(usageOf({ input_tokens: 10, output_tokens: 5 })).toEqual({
      input: 10,
      cached: 0,
      output: 5,
      total: 15,
    });
  });

  it.each([
    [
      '429 hết quota OpenAI (insufficient_quota)',
      429,
      failed('insufficient_quota'),
      'PROVIDER_QUOTA',
      'provider',
    ],
    ['402 billing', 402, failed('api_error'), 'PROVIDER_QUOTA', 'provider'],
    [
      '429 rate limit',
      429,
      failed('rate_limit_error'),
      'PROVIDER_RATE_LIMIT',
      'provider',
    ],
    [
      '500 lỗi nội bộ gateway',
      500,
      failed('api_error'),
      'AGENT_UNAVAILABLE',
      'infra',
    ],
    [
      '502 provider lỗi',
      502,
      failed('api_error'),
      'AGENT_UNAVAILABLE',
      'infra',
    ],
    ['503', 503, null, 'AGENT_UNAVAILABLE', 'infra'],
    [
      '504 provider timeout',
      504,
      failed('api_error'),
      'AGENT_TIMEOUT',
      'infra',
    ],
    ['401 sai gateway token', 401, null, 'AGENT_AUTH', 'infra'],
    [
      '400 request bị từ chối',
      400,
      failed('invalid_request_error'),
      'AGENT_REJECTED',
      'rejected',
    ],
    [
      '200 incomplete (hết token)',
      200,
      { ...completed('Một nửa'), status: 'incomplete' },
      'AGENT_INCOMPLETE',
      'agent',
    ],
    ['200 failed', 200, failed('api_error'), 'AGENT_FAILED', 'agent'],
    [
      '200 text dự phòng của gateway',
      200,
      completed(OPENCLAW_EMPTY_REPLY_TEXT),
      'AGENT_EMPTY_REPLY',
      'agent',
    ],
    ['200 text rỗng', 200, completed('   '), 'AGENT_EMPTY_REPLY', 'agent'],
    [
      '200 lỗi OpenClaw viết thành câu trả lời',
      200,
      completed(
        '⚠️ openai returned a billing error | credit_balance_exhausted',
      ),
      'AGENT_ERROR_TEXT',
      'agent',
    ],
    [
      '200 có function_call',
      200,
      { ...completed('x'), output: [{ type: 'function_call', name: 'exec' }] },
      'AGENT_UNEXPECTED_OUTPUT',
      'agent',
    ],
    ['200 body không phải JSON', 200, null, 'AGENT_UNEXPECTED_OUTPUT', 'agent'],
  ])('%s → không thành công (%s)', (_name, status, body, code, kind) => {
    expect(classifyOpenClawResponse(status as number, body)).toEqual({
      ok: false,
      code,
      kind,
      httpStatus: status,
    });
  });
});

describe('invokeOpenClaw', () => {
  it('gửi session key / agent / token qua header, input là chuỗi', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(completed('ok')), { status: 200 }),
      );
    const result = await invokeOpenClaw(
      CONFIG,
      {
        sessionKey: 'agent:main:zalo:oa1:u1',
        input: '[channel=ZALO sender=u1 msg=m1]\nchào',
      },
      { fetchImpl },
    );
    expect(result).toMatchObject({ ok: true, text: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://openclaw-gateway:18789/v1/responses');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${CONFIG.token}`,
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': 'main',
      'x-openclaw-session-key': 'agent:main:zalo:oa1:u1',
    });
    expect(JSON.parse(init.body)).toEqual({
      model: 'openclaw/main',
      input: '[channel=ZALO sender=u1 msg=m1]\nchào',
    });
  });

  it('lỗi mạng → AGENT_UNAVAILABLE', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      invokeOpenClaw(CONFIG, { sessionKey: 's', input: 'i' }, { fetchImpl }),
    ).resolves.toEqual({
      ok: false,
      code: 'AGENT_UNAVAILABLE',
      kind: 'infra',
      httpStatus: null,
    });
  });

  it('quá timeout → AGENT_TIMEOUT', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    await expect(
      invokeOpenClaw(
        { ...CONFIG, timeoutMs: 20 },
        { sessionKey: 's', input: 'i' },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_TIMEOUT' });
  });

  it('worker dừng giữa chừng → AGENT_ABORTED', async () => {
    const controller = new AbortController();
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          controller.abort();
        }),
    );
    await expect(
      invokeOpenClaw(
        CONFIG,
        { sessionKey: 's', input: 'i' },
        {
          signal: controller.signal,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'AGENT_ABORTED' });
  });
});
