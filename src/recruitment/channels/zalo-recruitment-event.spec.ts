import { createHash } from 'crypto';

import { ChannelEventChannel, ChannelEventStatus } from '../recruitment.enums';
import {
  assertRecruitmentZaloConfig,
  describeZaloOaMismatch,
  MAX_MESSAGE_TEXT_LENGTH,
  normalizeMessageText,
  parseZaloRecruitmentEvent,
  RECRUITMENT_ZALO_CONFIG_ERROR,
  readRecruitmentZaloConfig,
  zaloEventMac,
  type RecruitmentZaloConfig,
} from './zalo-recruitment-event';

const CONFIG: RecruitmentZaloConfig = {
  appId: 'app123',
  oaId: 'oa-recruit',
  secretKey: 'test-secret-key-0123456789',
};
const NOW = new Date('2026-10-07T08:00:00Z');
const TS = String(NOW.getTime() - 60_000);

function textEvent(overrides: Record<string, unknown> = {}) {
  return {
    app_id: CONFIG.appId,
    user_id_by_app: 'byapp-1',
    event_name: 'user_send_text',
    timestamp: TS,
    sender: { id: 'user-a' },
    recipient: { id: CONFIG.oaId },
    message: { text: 'Chào bạn, mình muốn ứng tuyển', msg_id: 'msg-0001' },
    ...overrides,
  };
}

/** Ký như Zalo: trên đúng chuỗi body gửi đi. */
function signed(
  payload: unknown,
  opts: { secret?: string; appId?: string; raw?: string } = {},
) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const body = Buffer.from(raw, 'utf8');
  const timestamp = (payload as { timestamp?: unknown } | null)?.timestamp;
  const ts =
    typeof timestamp === 'string' || typeof timestamp === 'number'
      ? String(timestamp)
      : '';
  const mac = zaloEventMac(
    opts.appId ?? CONFIG.appId,
    body,
    ts,
    opts.secret ?? CONFIG.secretKey,
  );
  return { body, header: `mac=${mac}` };
}

function parse(payload: unknown, opts?: Parameters<typeof signed>[1]) {
  const { body, header } = signed(payload, opts);
  return parseZaloRecruitmentEvent(CONFIG, body, header, NOW);
}

describe('parseZaloRecruitmentEvent — chữ ký', () => {
  it('event hợp lệ → chuẩn hoá đúng, OA lấy từ cấu hình', () => {
    const { body, header } = signed(textEvent());
    const result = parseZaloRecruitmentEvent(CONFIG, body, header, NOW);
    expect(result).toEqual({
      ok: true,
      event: {
        channel: ChannelEventChannel.ZALO,
        channelAccountId: CONFIG.oaId,
        providerEventId: null,
        dedupeKey: 'user_send_text:msg:msg-0001',
        externalSenderId: 'user-a',
        eventType: 'user_send_text',
        providerMessageId: 'msg-0001',
        providerCreatedAt: new Date(Number(TS)),
        status: ChannelEventStatus.RECEIVED,
        messageText: 'Chào bạn, mình muốn ứng tuyển',
        payloadHash: createHash('sha256').update(body).digest('hex'),
      },
    });
  });

  it('cùng công thức với webhook giáo viên: sha256(appId + body + timestamp + secret)', () => {
    const raw = JSON.stringify(textEvent());
    const expected = createHash('sha256')
      .update(`${CONFIG.appId}${raw}${TS}${CONFIG.secretKey}`)
      .digest('hex');
    expect(
      zaloEventMac(CONFIG.appId, Buffer.from(raw), TS, CONFIG.secretKey),
    ).toBe(expected);
  });

  it('header không có tiền tố mac= / chữ hoa vẫn nhận', () => {
    const { body, header } = signed(textEvent());
    const bare = header.replace('mac=', '').toUpperCase();
    expect(parseZaloRecruitmentEvent(CONFIG, body, bare, NOW).ok).toBe(true);
  });

  it('body tiếng Việt: ký trên byte UTF-8 nhận được', () => {
    expect(
      parse(
        textEvent({ message: { text: 'Lương bao nhiêu ạ? 😊', msg_id: 'm2' } }),
      ).ok,
    ).toBe(true);
  });

  it.each([
    ['thiếu header', undefined],
    ['header rỗng', ''],
    ['không phải hex', 'mac=xyz'],
    ['sai độ dài', `mac=${'a'.repeat(63)}`],
    ['header là mảng', ['mac=a', 'mac=b']],
  ])('%s → INVALID_SIGNATURE', (_name, header) => {
    const { body } = signed(textEvent());
    expect(parseZaloRecruitmentEvent(CONFIG, body, header, NOW)).toEqual({
      ok: false,
      code: 'INVALID_SIGNATURE',
    });
  });

  it('sai secret → INVALID_SIGNATURE', () => {
    expect(
      parse(textEvent(), { secret: 'another-secret-0123456789' }),
    ).toMatchObject({ ok: false, code: 'INVALID_SIGNATURE' });
  });

  it('body bị sửa sau khi ký → INVALID_SIGNATURE', () => {
    const { body, header } = signed(textEvent());
    const tampered = Buffer.from(
      body.toString('utf8').replace('user-a', 'user-b'),
    );
    expect(parseZaloRecruitmentEvent(CONFIG, tampered, header, NOW)).toEqual({
      ok: false,
      code: 'INVALID_SIGNATURE',
    });
  });

  it('ký bằng app_id trong payload (app khác) → INVALID_SIGNATURE: appId lấy từ cấu hình', () => {
    const payload = textEvent({ app_id: 'other-app' });
    expect(parse(payload, { appId: 'other-app' })).toMatchObject({
      ok: false,
      code: 'INVALID_SIGNATURE',
    });
  });

  it('chữ ký đúng nhưng app_id trong payload khác cấu hình → APP_MISMATCH', () => {
    expect(parse(textEvent({ app_id: 'other-app' }))).toMatchObject({
      ok: false,
      code: 'APP_MISMATCH',
    });
  });
});

describe('parseZaloRecruitmentEvent — gắn OA tuyển dụng', () => {
  it('event của OA khác (vd. OA giáo viên) → OA_MISMATCH', () => {
    expect(parse(textEvent({ recipient: { id: 'oa-teacher' } }))).toMatchObject(
      { ok: false, code: 'OA_MISMATCH' },
    );
  });

  it('oa_id khai thêm mâu thuẫn với recipient → OA_MISMATCH', () => {
    expect(parse(textEvent({ oa_id: 'oa-teacher' }))).toMatchObject({
      ok: false,
      code: 'OA_MISMATCH',
    });
  });

  it('không xác định được OA → OA_MISMATCH (fail-closed)', () => {
    expect(parse(textEvent({ recipient: undefined }))).toMatchObject({
      ok: false,
      code: 'OA_MISMATCH',
    });
    expect(
      parse({
        app_id: CONFIG.appId,
        event_name: 'shop_has_order',
        timestamp: TS,
      }),
    ).toMatchObject({ ok: false, code: 'OA_MISMATCH' });
  });

  it('follow/unfollow: OA ở oa_id, người dùng ở follower', () => {
    const result = parse({
      app_id: CONFIG.appId,
      oa_id: CONFIG.oaId,
      event_name: 'follow',
      timestamp: TS,
      follower: { id: 'user-a' },
    });
    expect(result).toMatchObject({
      ok: true,
      event: {
        status: ChannelEventStatus.IGNORED,
        externalSenderId: 'user-a',
        channelAccountId: CONFIG.oaId,
      },
    });
  });

  it('oa_send_*: OA là bên gửi → không ghi externalSenderId', () => {
    const result = parse({
      app_id: CONFIG.appId,
      event_name: 'oa_send_text',
      timestamp: TS,
      sender: { id: CONFIG.oaId },
      recipient: { id: 'user-a' },
      message: { text: 'Xin chào', msg_id: 'oa-msg-1' },
    });
    expect(result).toMatchObject({
      ok: true,
      event: {
        status: ChannelEventStatus.IGNORED,
        externalSenderId: null,
        dedupeKey: 'oa_send_text:msg:oa-msg-1',
      },
    });
  });
});

describe('parseZaloRecruitmentEvent — payload hỏng', () => {
  it.each([
    ['không có body', undefined],
    ['body rỗng', Buffer.alloc(0)],
    ['không phải JSON', Buffer.from('{not json')],
    ['JSON mảng', Buffer.from('[1,2]')],
    ['JSON chuỗi', Buffer.from('"x"')],
    ['JSON null', Buffer.from('null')],
  ])('%s → MALFORMED_PAYLOAD', (_name, body) => {
    expect(parseZaloRecruitmentEvent(CONFIG, body, 'mac=00', NOW)).toEqual({
      ok: false,
      code: 'MALFORMED_PAYLOAD',
    });
  });

  it.each([
    ['thiếu event_name', { event_name: undefined }],
    ['event_name lạ', { event_name: 'User Send' }],
    ['thiếu timestamp', { timestamp: undefined }],
    ['timestamp không phải số', { timestamp: 'yesterday' }],
    ['thiếu sender', { sender: undefined }],
    ['sender id có ký tự lạ', { sender: { id: 'a:b' } }],
    ['thiếu msg_id', { message: { text: 'hi' } }],
    ['msg_id có khoảng trắng', { message: { text: 'hi', msg_id: 'a b' } }],
    ['thiếu text', { message: { msg_id: 'm1' } }],
    ['message không phải object', { message: 'hi' }],
  ])('chữ ký đúng nhưng %s → MALFORMED_EVENT', (_name, overrides) => {
    expect(parse(textEvent(overrides))).toMatchObject({
      ok: false,
      code: 'MALFORMED_EVENT',
    });
  });
});

describe('parseZaloRecruitmentEvent — loại event và khoá chống trùng', () => {
  it('event hợp lệ nhưng chưa hỗ trợ (ảnh) → IGNORED, vẫn chống trùng theo msg_id', () => {
    const result = parse(
      textEvent({
        event_name: 'user_send_image',
        message: { msg_id: 'img-1', attachments: [] },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      event: {
        status: ChannelEventStatus.IGNORED,
        dedupeKey: 'user_send_image:msg:img-1',
        externalSenderId: 'user-a',
      },
    });
  });

  it('Zalo gửi lại cùng tin (body khác thứ tự key) → cùng dedupe_key, payload_hash khác', () => {
    const a = parse(textEvent());
    const reordered = textEvent();
    const raw = JSON.stringify(
      Object.fromEntries(Object.entries(reordered).reverse()),
      null,
      2,
    );
    const b = parse(reordered, { raw });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.event.dedupeKey).toBe(a.event.dedupeKey);
    expect(b.event.payloadHash).not.toBe(a.event.payloadHash);
  });

  it('event không có msg_id: khoá là hash tất định, không băm raw JSON', () => {
    const follow = {
      app_id: CONFIG.appId,
      oa_id: CONFIG.oaId,
      event_name: 'follow',
      timestamp: TS,
      follower: { id: 'user-a' },
    };
    const first = parse(follow);
    const sameFieldsOtherLayout = parse(follow, {
      raw: JSON.stringify(follow, null, 4),
    });
    const later = parse({ ...follow, timestamp: String(Number(TS) + 1) });
    if (!first.ok || !sameFieldsOtherLayout.ok || !later.ok) {
      throw new Error('mong đợi hợp lệ');
    }
    expect(first.event.dedupeKey).toMatch(/^follow:h:[0-9a-f]{64}$/);
    expect(sameFieldsOtherLayout.event.dedupeKey).toBe(first.event.dedupeKey);
    expect(later.event.dedupeKey).not.toBe(first.event.dedupeKey);
  });

  it('timestamp vô lý → không ghi providerCreatedAt nhưng vẫn nhận', () => {
    expect(parse(textEvent({ timestamp: '154390853474' }))).toMatchObject({
      ok: true,
      event: { providerCreatedAt: null },
    });
  });
});

describe('cấu hình OA tuyển dụng', () => {
  const ok = {
    RECRUITMENT_ZALO_ENABLED: 'true',
    RECRUITMENT_ZALO_APP_ID: 'app123',
    RECRUITMENT_ZALO_OA_ID: 'oa-recruit',
    RECRUITMENT_ZALO_OA_SECRET_KEY: 'test-secret-key-0123456789',
  };
  const get = (values: Record<string, string | undefined>) => (key: string) =>
    values[key];

  it('đủ cấu hình → hợp lệ', () => {
    expect(readRecruitmentZaloConfig(get(ok))).toEqual({ config: CONFIG });
    expect(() => assertRecruitmentZaloConfig(get(ok))).not.toThrow();
  });

  it('cờ tắt → không kiểm (mặc định của 3010/3011)', () => {
    expect(() => assertRecruitmentZaloConfig(get({}))).not.toThrow();
  });

  it.each([
    ['RECRUITMENT_ZALO_APP_ID', { RECRUITMENT_ZALO_APP_ID: '' }],
    ['RECRUITMENT_ZALO_OA_ID', { RECRUITMENT_ZALO_OA_ID: undefined }],
    ['RECRUITMENT_ZALO_OA_ID', { RECRUITMENT_ZALO_OA_ID: 'legacy' }],
    ['RECRUITMENT_ZALO_OA_ID', { RECRUITMENT_ZALO_OA_ID: 'oa:x' }],
    [
      'RECRUITMENT_ZALO_OA_SECRET_KEY',
      { RECRUITMENT_ZALO_OA_SECRET_KEY: 'short' },
    ],
  ])(
    'bật mà %s thiếu/sai → không khởi động, lỗi không lộ giá trị',
    (name, patch) => {
      const values = { ...ok, ...patch };
      expect(() => assertRecruitmentZaloConfig(get(values))).toThrow(
        new RegExp(`${RECRUITMENT_ZALO_CONFIG_ERROR}.*${name}`),
      );
      try {
        assertRecruitmentZaloConfig(get(values));
      } catch (error) {
        expect((error as Error).message).not.toContain(
          ok.RECRUITMENT_ZALO_OA_SECRET_KEY,
        );
      }
    },
  );
});

describe('nội dung tin cho worker', () => {
  it('chuẩn hoá: NFC, xuống dòng, bỏ ký tự điều khiển, bỏ khoảng trắng hai đầu', () => {
    const decomposed = 'Tie\u0302\u0301ng Vie\u0323\u0302t'; // "Tiếng Việt" dạng tổ hợp
    expect(
      normalizeMessageText(`  ${decomposed}\r\ndòng 2\u0000\u0007\t!  `),
    ).toBe('Tiếng Việt\ndòng 2\t!');
  });

  it('chỉ event RECEIVED mang nội dung; event IGNORED luôn null', () => {
    const image = parse(
      textEvent({
        event_name: 'user_send_image',
        message: { msg_id: 'i1', text: 'caption' },
      }),
    );
    expect(image).toMatchObject({
      ok: true,
      event: { status: 'IGNORED', messageText: null },
    });
  });

  it('tin chỉ có khoảng trắng → IGNORED, không giữ nội dung', () => {
    expect(
      parse(textEvent({ message: { text: ' \n\u0000 ', msg_id: 'm-blank' } })),
    ).toMatchObject({
      ok: true,
      event: { status: 'IGNORED', messageText: null },
    });
  });

  it(`tin dài hơn ${MAX_MESSAGE_TEXT_LENGTH} ký tự → MALFORMED_EVENT`, () => {
    expect(
      parse(
        textEvent({
          message: {
            text: 'a'.repeat(MAX_MESSAGE_TEXT_LENGTH + 1),
            msg_id: 'm-long',
          },
        }),
      ),
    ).toMatchObject({ ok: false, code: 'MALFORMED_EVENT' });
  });
});

describe('describeZaloOaMismatch — chẩn đoán OA lệch để ghi log', () => {
  const fp = (v: string) =>
    createHash('sha256').update(v).digest('hex').slice(0, 10);

  it.each([
    [
      'recipient là OA khác, không khai oa_id',
      textEvent({ recipient: { id: 'oa-giao-vien' } }),
      `party_oa=${fp('oa-giao-vien')} declared_oa=absent`,
    ],
    [
      'recipient đúng nhưng oa_id khai khác',
      textEvent({ oa_id: 'oa-khac' }),
      `party_oa=match declared_oa=${fp('oa-khac')}`,
    ],
    [
      'không có recipient',
      textEvent({ recipient: undefined }),
      'party_oa=none declared_oa=absent',
    ],
    [
      'follow: OA lấy từ oa_id',
      { ...textEvent(), event_name: 'follow', oa_id: 'oa-khac' },
      `party_oa=${fp('oa-khac')} declared_oa=${fp('oa-khac')}`,
    ],
  ])('%s', (_n, payload, expected) => {
    const out = describeZaloOaMismatch(
      CONFIG,
      String(payload.event_name),
      JSON.parse(JSON.stringify(payload)),
    );
    expect(out).toBe(expected);
    // Không bao giờ chứa id thô.
    expect(out).not.toMatch(/oa-giao-vien|oa-khac|oa-recruit/);
  });
});
