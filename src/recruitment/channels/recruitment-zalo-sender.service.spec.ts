import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';

import type { ClaimedOutbox } from './recruitment-channel-outbox.queue';
import {
  parseTokens,
  RecruitmentZaloCredentialStore,
  ZaloCredentialError,
} from './recruitment-zalo-credential.store';
import { RecruitmentZaloSender } from './recruitment-zalo-sender.service';
import type { ZaloOutboundConfig } from './zalo-outbound.config';
import { decryptToken, encryptToken } from './zalo-token.crypto';

const RECIPIENT = '8812345678901234567';
const TEXT = 'Chào Lan, lịch phỏng vấn của bạn là 9h sáng thứ Hai.';
const TOKEN = 'access-token-ABCDEF0123456789';
const KEY = randomBytes(32);

/** Zalo giả trên localhost: trả lời theo hàng đợi `replies`, ghi lại request. */
async function fakeZalo(
  replies: Array<(res: http.ServerResponse, req: http.IncomingMessage) => void>,
) {
  const requests: Array<{
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      const reply =
        replies.shift() ??
        ((r) => r.end('{"error":0,"data":{"message_id":"z-default"}}'));
      reply(res, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const json =
  (body: unknown, status = 200) =>
  (res: http.ServerResponse) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };

function config(
  url: string,
  patch: Partial<ZaloOutboundConfig> = {},
): ZaloOutboundConfig {
  return {
    oaId: 'oa-recruit',
    appId: 'app123',
    appSecret: 'app-secret-0123456789abcdef',
    tokenKey: KEY,
    apiUrl: url,
    oauthUrl: url,
    concurrency: 1,
    pollMs: 100,
    leaseMs: 60_000,
    retryBaseMs: 1000,
    retryMaxMs: 8000,
    connectTimeoutMs: 1000,
    responseTimeoutMs: 300,
    maxTextLength: 2000,
    permanentErrors: new Set([-213]),
    tokenErrors: new Set([-216]),
    maxRejectAttempts: 3,
    ...patch,
  };
}

function row(patch: Partial<ClaimedOutbox> = {}): ClaimedOutbox {
  return {
    id: 21,
    channelAccountId: 'oa-recruit',
    externalRecipientId: RECIPIENT,
    messageText: TEXT,
    recruitmentMessageId: 301,
    attemptCount: 1,
    ...patch,
  };
}

function setup(
  opts: { enabled?: boolean; canonical?: Record<string, unknown> | null } = {},
) {
  const queue = {
    markDispatched: jest.fn().mockResolvedValue(true),
    heartbeat: jest.fn().mockResolvedValue(true),
    markSent: jest.fn().mockResolvedValue(true),
    markRetry: jest.fn().mockResolvedValue(true),
    markUnknown: jest.fn().mockResolvedValue(true),
    markDeadLetter: jest.fn().mockResolvedValue(true),
  };
  const credentials = {
    accessToken: jest
      .fn()
      .mockResolvedValue({
        accessToken: TOKEN,
        version: 4,
        expiresAt: new Date(),
      }),
    refresh: jest
      .fn()
      .mockResolvedValue({
        accessToken: `${TOKEN}-new`,
        version: 5,
        expiresAt: new Date(),
      }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const canonical =
    opts.canonical === null
      ? []
      : [
          {
            content: TEXT,
            direction: 'OUTBOUND',
            sender_type: 'AI',
            channel: 'ZALO',
            external_conversation_id: `oa-recruit:${RECIPIENT}`,
            zalo_oa_id: 'oa-recruit',
            zalo_user_id: RECIPIENT,
            ...(opts.canonical ?? {}),
          },
        ];
  const dataSource = { query: jest.fn().mockResolvedValue(canonical) };
  const sender = new RecruitmentZaloSender(
    {
      get: (key: string) =>
        key === 'RECRUITMENT_ZALO_OUTBOUND_ENABLED'
          ? String(opts.enabled ?? true)
          : undefined,
    } as any,
    queue as any,
    credentials as any,
    audit as any,
    dataSource as any,
  );
  return { sender, queue, credentials, audit };
}

describe('RecruitmentZaloSender.process', () => {
  let logs: string[];
  let zalo: Awaited<ReturnType<typeof fakeZalo>> | null = null;

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => {
        logs.push(String(m));
      });
    }
  });

  afterEach(async () => {
    await zalo?.close();
    zalo = null;
    // Log không bao giờ chứa token, id người nhận hay nội dung tin.
    const all = logs.join('\n');
    for (const secret of [TOKEN, RECIPIENT, TEXT])
      expect(all).not.toContain(secret);
    jest.restoreAllMocks();
  });

  it('gửi đúng Send API (recipient + text + access_token) → SENT với id tin Zalo; dispatch ghi trước khi gửi', async () => {
    zalo = await fakeZalo([
      json({ error: 0, message: 'Success', data: { message_id: 'z-1' } }),
    ]);
    const { sender, queue } = setup();
    await sender.process(row(), 'o1', config(zalo.url));

    expect(zalo.requests).toHaveLength(1);
    expect(zalo.requests[0].url).toBe('/v3.0/oa/message/cs');
    expect(zalo.requests[0].headers.access_token).toBe(TOKEN);
    expect(JSON.parse(zalo.requests[0].body)).toEqual({
      recipient: { user_id: RECIPIENT },
      message: { text: TEXT },
    });
    expect(queue.markDispatched).toHaveBeenCalledWith(21, 'o1');
    expect(queue.markSent).toHaveBeenCalledWith(21, 'o1', 'z-1');
  });

  it.each([
    [
      'OA khác OA tuyển dụng',
      { channelAccountId: 'oa-teacher' },
      null,
      'OA_MISMATCH',
    ],
    [
      'id người nhận lạ',
      { externalRecipientId: 'a:b' },
      null,
      'RECIPIENT_INVALID',
    ],
    ['nội dung rỗng', { messageText: '  ' }, null, 'EMPTY_MESSAGE'],
    [
      'nội dung quá dài',
      { messageText: 'a'.repeat(2001) },
      null,
      'MESSAGE_TOO_LONG',
    ],
    [
      'không có tin canonical',
      { recruitmentMessageId: null },
      null,
      'CANONICAL_MISSING',
    ],
    [
      'tin canonical là của ứng viên khác',
      {},
      { zalo_user_id: '999' },
      'RECIPIENT_MISMATCH',
    ],
    [
      'tin canonical ở hội thoại khác',
      {},
      { external_conversation_id: 'oa-recruit:999' },
      'RECIPIENT_MISMATCH',
    ],
    [
      'tin canonical không phải tin đi của AI',
      {},
      { direction: 'INBOUND' },
      'CANONICAL_INVALID',
    ],
    [
      'nội dung lệch bản canonical',
      {},
      { content: 'câu khác' },
      'CANONICAL_MISMATCH',
    ],
  ])(
    '%s → DEAD_LETTER, KHÔNG gọi Zalo',
    async (_name, patch, canonical, code) => {
      zalo = await fakeZalo([]);
      const { sender, queue, audit } = setup({ canonical });
      await sender.process(row(patch), 'o1', config(zalo.url));
      expect(zalo.requests).toHaveLength(0);
      expect(queue.markDispatched).not.toHaveBeenCalled();
      expect(queue.markDeadLetter).toHaveBeenCalledWith(21, 'o1', code);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CHANNEL_OUTBOX_DEAD_LETTER',
          entityId: 21,
          context: { code, status: 'DEAD_LETTER' },
        }),
      );
    },
  );

  it('kill switch tắt → không mở kết nối nào', async () => {
    zalo = await fakeZalo([]);
    const { sender, queue } = setup({ enabled: false });
    await sender.process(row(), 'o1', config(zalo.url));
    expect(zalo.requests).toHaveLength(0);
    expect(queue.markRetry).toHaveBeenCalledWith(
      21,
      'o1',
      'OUTBOUND_DISABLED',
      1000,
    );
  });

  it('token hết hạn → refresh đúng một lần (theo version đang cầm) → gửi lại → SENT', async () => {
    zalo = await fakeZalo([
      json({ error: -216, message: 'Access token is invalid' }),
      json({ error: 0, data: { message_id: 'z-2' } }),
    ]);
    const { sender, queue, credentials } = setup();
    await sender.process(row(), 'o1', config(zalo.url));
    expect(credentials.refresh).toHaveBeenCalledTimes(1);
    expect(credentials.refresh.mock.calls[0][1]).toBe(4);
    expect(zalo.requests.map((r) => r.headers.access_token)).toEqual([
      TOKEN,
      `${TOKEN}-new`,
    ]);
    expect(queue.markSent).toHaveBeenCalledWith(21, 'o1', 'z-2');
  });

  it('refresh thất bại → RETRY (tin chưa đi), không gửi lần hai', async () => {
    zalo = await fakeZalo([json({ error: -216, message: 'x' })]);
    const { sender, queue, credentials } = setup();
    credentials.refresh.mockRejectedValue(
      new ZaloCredentialError('REFRESH_REJECTED'),
    );
    await sender.process(row(), 'o1', config(zalo.url));
    expect(zalo.requests).toHaveLength(1);
    expect(queue.markRetry).toHaveBeenCalledWith(
      21,
      'o1',
      'REFRESH_REJECTED',
      1000,
    );
  });

  it('chưa có credential → RETRY, chưa dispatch, không gọi Zalo', async () => {
    zalo = await fakeZalo([]);
    const { sender, queue, credentials } = setup();
    credentials.accessToken.mockRejectedValue(
      new ZaloCredentialError('CREDENTIAL_MISSING'),
    );
    await sender.process(row(), 'o1', config(zalo.url));
    expect(zalo.requests).toHaveLength(0);
    expect(queue.markDispatched).not.toHaveBeenCalled();
    expect(queue.markRetry).toHaveBeenCalledWith(
      21,
      'o1',
      'CREDENTIAL_MISSING',
      1000,
    );
  });

  it('mất lease trước khi dispatch → không gửi, không ghi kết quả', async () => {
    zalo = await fakeZalo([]);
    const { sender, queue } = setup();
    queue.markDispatched.mockResolvedValue(false);
    await sender.process(row(), 'o1', config(zalo.url));
    expect(zalo.requests).toHaveLength(0);
    expect(queue.markSent).not.toHaveBeenCalled();
    expect(queue.markRetry).not.toHaveBeenCalled();
  });

  it.each([
    ['429', json({}, 429), 'markRetry', 'PROVIDER_RATE_LIMIT'],
    ['503', json({}, 503), 'markRetry', 'PROVIDER_5XX'],
    ['504', json({}, 504), 'markUnknown', 'PROVIDER_GATEWAY_TIMEOUT'],
    [
      'không trả lời (sau khi gửi)',
      () => undefined,
      'markUnknown',
      'RESPONSE_TIMEOUT',
    ],
    [
      'cắt kết nối sau khi nhận',
      (_res: http.ServerResponse, req: http.IncomingMessage) =>
        req.socket.destroy(),
      'markUnknown',
      'CONNECTION_LOST',
    ],
    [
      'từ chối vĩnh viễn (-213)',
      json({ error: -213, message: 'x' }),
      'markDeadLetter',
      'ZALO_-213',
    ],
    [
      'từ chối chưa phân loại, lần 1',
      json({ error: -230, message: 'x' }),
      'markRetry',
      'ZALO_-230',
    ],
  ])('Zalo %s → %s(%s)', async (_name, reply, method, code) => {
    zalo = await fakeZalo([reply as (res: http.ServerResponse) => void]);
    const { sender, queue } = setup();
    await sender.process(row(), 'o1', config(zalo.url));
    expect(zalo.requests).toHaveLength(1);
    const call = (queue as Record<string, jest.Mock>)[method].mock.calls[0];
    expect(call.slice(0, 3)).toEqual([21, 'o1', code]);
    expect(queue.markSent).not.toHaveBeenCalled();
  });

  it('UNKNOWN có audit cho vận hành đối soát', async () => {
    zalo = await fakeZalo([json({}, 504)]);
    const { sender, audit } = setup();
    await sender.process(row(), 'o1', config(zalo.url));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CHANNEL_OUTBOX_UNKNOWN',
        entityId: 21,
        success: false,
      }),
    );
  });

  it('từ chối chưa phân loại tới lần thứ maxRejectAttempts → DEAD_LETTER', async () => {
    zalo = await fakeZalo([json({ error: -230, message: 'x' })]);
    const { sender, queue } = setup();
    await sender.process(row({ attemptCount: 3 }), 'o1', config(zalo.url));
    expect(queue.markDeadLetter).toHaveBeenCalledWith(21, 'o1', 'ZALO_-230');
  });

  it('cổng Zalo đóng (chưa kết nối được) → RETRY: chắc chắn chưa gửi', async () => {
    zalo = await fakeZalo([]);
    const closedUrl = zalo.url;
    await zalo.close();
    zalo = null;
    const { sender, queue } = setup();
    await sender.process(row(), 'o1', config(closedUrl));
    expect(queue.markRetry).toHaveBeenCalledWith(
      21,
      'o1',
      'NETWORK_BEFORE_SEND',
      1000,
    );
  });
});

describe('RecruitmentZaloCredentialStore.refresh', () => {
  const stored = (version: number, refresh = 'refresh-1') => ({
    access_token_enc: encryptToken(KEY, 'oa-recruit', 'access-old'),
    refresh_token_enc: encryptToken(KEY, 'oa-recruit', refresh),
    access_expires_at: new Date(Date.now() + 3_600_000),
    version,
  });

  function store(row: unknown) {
    const em = {
      query: jest.fn().mockResolvedValueOnce([row]).mockResolvedValue([]),
    };
    const dataSource = {
      transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
      query: jest.fn(),
    };
    return {
      credentialStore: new RecruitmentZaloCredentialStore(dataSource as any),
      em,
    };
  }

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('version đã đổi (sender khác vừa refresh) → dùng token mới, KHÔNG gọi Zalo', async () => {
    const zalo = await fakeZalo([]);
    try {
      const { credentialStore } = store(stored(5));
      const token = await credentialStore.refresh(config(zalo.url), 4);
      expect(token).toMatchObject({ accessToken: 'access-old', version: 5 });
      expect(zalo.requests).toHaveLength(0);
    } finally {
      await zalo.close();
    }
  });

  it('đúng version → gọi OAuth (form + secret_key), lưu token mới đã mã hoá, version+1', async () => {
    const zalo = await fakeZalo([
      json({
        access_token: 'access-new',
        refresh_token: 'refresh-2',
        expires_in: 90000,
      }),
    ]);
    try {
      const { credentialStore, em } = store(stored(4));
      const token = await credentialStore.refresh(config(zalo.url), 4);
      expect(token).toMatchObject({ accessToken: 'access-new', version: 5 });

      const req = zalo.requests[0];
      expect(req.url).toBe('/v4/oa/access_token');
      expect(req.headers.secret_key).toBe('app-secret-0123456789abcdef');
      expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
        app_id: 'app123',
        grant_type: 'refresh_token',
        refresh_token: 'refresh-1',
      });
      expect(em.query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
      const [, params] = em.query.mock.calls[1];
      expect(decryptToken(KEY, 'oa-recruit', params[1])).toBe('access-new');
      expect(decryptToken(KEY, 'oa-recruit', params[2])).toBe('refresh-2');
      expect(params.slice(3)).toEqual([90000, 5]);
    } finally {
      await zalo.close();
    }
  });

  it('Zalo từ chối refresh token → REFRESH_REJECTED, không ghi đè', async () => {
    const zalo = await fakeZalo([
      json({ error: -14014, error_name: 'Invalid refresh token' }),
    ]);
    try {
      const { credentialStore, em } = store(stored(4));
      await expect(
        credentialStore.refresh(config(zalo.url), 4),
      ).rejects.toMatchObject({
        code: 'REFRESH_REJECTED',
      });
      expect(em.query).toHaveBeenCalledTimes(1);
    } finally {
      await zalo.close();
    }
  });

  it('parseTokens chỉ nhận đủ access/refresh/expires_in', () => {
    expect(
      parseTokens(
        200,
        '{"access_token":"a","refresh_token":"r","expires_in":60}',
      ),
    ).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 60,
    });
    expect(parseTokens(200, '{"access_token":"a","expires_in":60}')).toBeNull();
    expect(
      parseTokens(
        400,
        '{"access_token":"a","refresh_token":"r","expires_in":60}',
      ),
    ).toBeNull();
    expect(parseTokens(200, 'nope')).toBeNull();
  });
});
