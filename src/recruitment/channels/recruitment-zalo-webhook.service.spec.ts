import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { ChannelEventStatus } from '../recruitment.enums';
import { RecruitmentZaloWebhookService } from './recruitment-zalo-webhook.service';
import { zaloEventMac } from './zalo-recruitment-event';

const ENV = {
  RECRUITMENT_ZALO_ENABLED: 'true',
  RECRUITMENT_ZALO_APP_ID: 'app123',
  RECRUITMENT_ZALO_OA_ID: 'oa-recruit',
  RECRUITMENT_ZALO_OA_SECRET_KEY: 'test-secret-key-0123456789',
};
const SENDER = '8812345678901234567';
const TEXT = 'Số điện thoại của mình là 0912345678';

function signedRequest(overrides: Record<string, unknown> = {}) {
  const payload = {
    app_id: ENV.RECRUITMENT_ZALO_APP_ID,
    event_name: 'user_send_text',
    timestamp: String(Date.now()),
    sender: { id: SENDER },
    recipient: { id: ENV.RECRUITMENT_ZALO_OA_ID },
    message: { text: TEXT, msg_id: 'msg-1' },
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload));
  const mac = zaloEventMac(
    ENV.RECRUITMENT_ZALO_APP_ID,
    body,
    payload.timestamp,
    ENV.RECRUITMENT_ZALO_OA_SECRET_KEY,
  );
  return { body, signature: `mac=${mac}` };
}

function setup(env: Record<string, string | undefined> = ENV) {
  const repo = {
    query: jest.fn().mockResolvedValue([{ id: 41 }]),
    findOne: jest.fn().mockResolvedValue({ id: 41, payloadHash: 'other' }),
  };
  const service = new RecruitmentZaloWebhookService(
    repo as any,
    { get: (key: string) => env[key] } as any,
  );
  return { service, repo };
}

describe('RecruitmentZaloWebhookService', () => {
  let logs: string[];
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logs.push(String(message));
        });
    }
    // Bất kỳ lời gọi mạng nào (OpenClaw, API Zalo) đều là lỗi ở P3-3.
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('outbound call in P3-3'));
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('cờ tắt → 404, không chạm DB', async () => {
    const { service, repo } = setup({});
    const { body, signature } = signedRequest();
    await expect(service.receive(body, signature)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('bật mà thiếu cấu hình → 503, không chạm DB', async () => {
    const { service, repo } = setup({ RECRUITMENT_ZALO_ENABLED: 'true' });
    const { body, signature } = signedRequest();
    await expect(service.receive(body, signature)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('event mới → một câu INSERT ... ON CONFLICT DO NOTHING rồi ACK', async () => {
    const { service, repo } = setup();
    const { body, signature } = signedRequest();

    await expect(service.receive(body, signature)).resolves.toEqual({
      ok: true,
      duplicate: false,
      status: ChannelEventStatus.RECEIVED,
    });

    expect(repo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = repo.query.mock.calls[0];
    expect(sql).toMatch(
      /ON CONFLICT ON CONSTRAINT "UQ_recruitment_channel_events_dedupe" DO NOTHING/,
    );
    expect(sql).toMatch(/RETURNING "id"/);
    expect(params).toEqual([
      'ZALO',
      'oa-recruit',
      null,
      'user_send_text:msg:msg-1',
      SENDER,
      'user_send_text',
      'msg-1',
      expect.any(Date),
      'RECEIVED',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      TEXT,
    ]);
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('event trùng (DB không trả dòng) → ACK duplicate=true, không ghi thêm', async () => {
    const { service, repo } = setup();
    repo.query.mockResolvedValueOnce([]);
    const { body, signature } = signedRequest();

    await expect(service.receive(body, signature)).resolves.toEqual({
      ok: true,
      duplicate: true,
      status: ChannelEventStatus.RECEIVED,
    });
    expect(repo.query).toHaveBeenCalledTimes(1);
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          channel: 'ZALO',
          channelAccountId: 'oa-recruit',
          dedupeKey: 'user_send_text:msg:msg-1',
        },
      }),
    );
    expect(logs.join('\n')).toMatch(/duplicate=true samePayload=false/);
  });

  it('event chưa hỗ trợ → lưu IGNORED và ACK', async () => {
    const { service, repo } = setup();
    const { body, signature } = signedRequest({
      event_name: 'user_send_sticker',
      message: { msg_id: 'st-1' },
    });
    await expect(service.receive(body, signature)).resolves.toMatchObject({
      ok: true,
      status: ChannelEventStatus.IGNORED,
    });
    expect(repo.query.mock.calls[0][1][8]).toBe('IGNORED');
    // Event không xử lý thì không giữ nội dung.
    expect(repo.query.mock.calls[0][1][10]).toBeNull();
  });

  it('DB lỗi → 503, không ACK giả', async () => {
    const { service, repo } = setup();
    repo.query.mockRejectedValueOnce(
      Object.assign(new Error(`relation "x" does not exist ${SENDER}`), {
        code: '42P01',
      }),
    );
    const { body, signature } = signedRequest();
    await expect(service.receive(body, signature)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(logs.join('\n')).toMatch(/store failed .*error=42P01/);
  });

  it.each([
    [
      'chữ ký sai',
      UnauthorizedException,
      'INVALID_SIGNATURE',
      'mac=' + '0'.repeat(64),
    ],
    ['OA khác', ForbiddenException, 'OA_MISMATCH', undefined],
    ['payload hỏng', BadRequestException, 'MALFORMED_PAYLOAD', undefined],
  ])('%s → %p, không chạm DB', async (name, Exception, code, badSignature) => {
    const { service, repo } = setup();
    let { body, signature } = signedRequest(
      name === 'OA khác' ? { recipient: { id: 'oa-teacher' } } : {},
    );
    if (badSignature) signature = badSignature;
    if (name === 'payload hỏng') body = Buffer.from('{"event_name":');

    const error = await service.receive(body, signature).catch((e) => e);
    expect(error).toBeInstanceOf(Exception);
    expect(error.getResponse()).toEqual({ code });
    expect(repo.query).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain(`rejected code=${code}`);
  });

  it('log không chứa id người gửi, nội dung tin, secret hay chữ ký', async () => {
    const { service, repo } = setup();
    const { body, signature } = signedRequest();
    await service.receive(body, signature);
    repo.query.mockResolvedValueOnce([]);
    await service.receive(body, signature);
    repo.query.mockRejectedValueOnce(new Error(`boom ${SENDER} ${TEXT}`));
    await service.receive(body, signature).catch(() => undefined);
    await service.receive(body, 'mac=' + '1'.repeat(64)).catch(() => undefined);

    const all = logs.join('\n');
    expect(logs).toHaveLength(4);
    expect(all).toMatch(
      /event=41 type=user_send_text oa=oa-recruit status=RECEIVED duplicate=false sender=[0-9a-f]{12}/,
    );
    for (const secret of [
      SENDER,
      TEXT,
      '0912345678',
      ENV.RECRUITMENT_ZALO_OA_SECRET_KEY,
      signature.slice(4, 20),
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
