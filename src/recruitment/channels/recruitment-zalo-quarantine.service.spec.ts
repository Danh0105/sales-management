import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

import { RecruitmentActorType } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { RecruitmentZaloQuarantineService } from './recruitment-zalo-quarantine.service';
import { RecruitmentZaloWebhookService } from './recruitment-zalo-webhook.service';
import {
  assertRecruitmentZaloConfig,
  zaloEventMac,
} from './zalo-recruitment-event';
import { decryptToken, encryptToken } from './zalo-token.crypto';

const KEY = randomBytes(32);
const SECRET = 'oa-secret-key-0123456789abcdef';
const SENDER = '8812345678901234567';
const TEXT = 'Chào bạn, mình muốn ứng tuyển vị trí tư vấn tuyển sinh';
const HR: RecruitmentActor = {
  type: RecruitmentActorType.HR,
  employeeId: 42,
  name: 'HR Lan',
  roles: ['nhansu'],
};

const BASE = {
  RECRUITMENT_ZALO_ENABLED: 'true',
  RECRUITMENT_ZALO_APP_ID: 'app-recruit',
  RECRUITMENT_ZALO_OA_ID: 'oa-recruit',
  RECRUITMENT_ZALO_TOKEN_KEY: KEY.toString('base64'),
};
const QUARANTINE_ENV = {
  ...BASE,
  RECRUITMENT_ZALO_WEBHOOK_QUARANTINE: 'true',
  RECRUITMENT_ZALO_OA_SECRET_KEY: '',
};
const NORMAL_ENV = { ...BASE, RECRUITMENT_ZALO_OA_SECRET_KEY: SECRET };

function event(overrides: Record<string, unknown> = {}) {
  const payload = {
    app_id: 'app-recruit',
    event_name: 'user_send_text',
    timestamp: '1791000000000',
    sender: { id: SENDER },
    recipient: { id: 'oa-recruit' },
    message: { text: TEXT, msg_id: 'msg-1' },
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload));
  const signature = `mac=${zaloEventMac('app-recruit', body, payload.timestamp, SECRET)}`;
  return { body, signature };
}

const hashOf = (body: Buffer) =>
  createHash('sha256').update(body).digest('hex');
const aad = (body: Buffer) => `quarantine:oa-recruit:${hashOf(body)}`;

/** DB giả: trả theo SQL (regex), ghi lại mọi câu; `transaction` chạy fn với cùng runner. */
function fakeDb(routes: Array<[RegExp, (params: unknown[]) => unknown]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const route = routes.find(([re]) => re.test(sql));
    const result = route ? route[1](params) : [];
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  });
  const em = { query };
  return {
    dataSource: {
      query,
      transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
    },
    calls,
    ran: (re: RegExp) => calls.filter((c) => re.test(c.sql)),
  };
}

function service(env: Record<string, string>, db: ReturnType<typeof fakeDb>) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new RecruitmentZaloQuarantineService(
    db.dataSource as any,
    { get: (k: string) => env[k] } as any,
    audit as any,
  );
  return { svc, audit };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((m: unknown) => void logs.push(String(m)));
  }
});
afterEach(() => {
  // Log không bao giờ chứa nội dung tin, id người gửi hay secret.
  const all = logs.join('\n');
  for (const secret of [TEXT, SENDER, SECRET])
    expect(all).not.toContain(secret);
  jest.restoreAllMocks();
});

describe('cấu hình chế độ cách ly (fail-closed lúc khởi động)', () => {
  const get = (env: Record<string, string>) => (k: string) => env[k];

  it('quarantine + chưa có secret key + có khoá mã hoá → khởi động được', () => {
    expect(() =>
      assertRecruitmentZaloConfig(get(QUARANTINE_ENV)),
    ).not.toThrow();
  });

  it('quarantine nhưng ĐÃ có OA secret key → từ chối (không chạy song song với kiểm chữ ký)', () => {
    expect(() =>
      assertRecruitmentZaloConfig(
        get({ ...QUARANTINE_ENV, RECRUITMENT_ZALO_OA_SECRET_KEY: SECRET }),
      ),
    ).toThrow(/RECRUITMENT_ZALO_OA_SECRET_KEY \(phải trống/);
  });

  it('quarantine thiếu RECRUITMENT_ZALO_TOKEN_KEY → từ chối (không lưu được bản mã)', () => {
    expect(() =>
      assertRecruitmentZaloConfig(
        get({ ...QUARANTINE_ENV, RECRUITMENT_ZALO_TOKEN_KEY: '' }),
      ),
    ).toThrow(/RECRUITMENT_ZALO_TOKEN_KEY/);
  });

  it('không quarantine mà thiếu secret key → vẫn từ chối như trước', () => {
    expect(() =>
      assertRecruitmentZaloConfig(
        get({ ...BASE, RECRUITMENT_ZALO_OA_SECRET_KEY: '' }),
      ),
    ).toThrow(/RECRUITMENT_ZALO_OA_SECRET_KEY/);
  });

  it('lỗi cấu hình chỉ nêu tên biến, không bao giờ kèm giá trị', () => {
    let message = '';
    try {
      assertRecruitmentZaloConfig(
        get({ ...QUARANTINE_ENV, RECRUITMENT_ZALO_OA_SECRET_KEY: SECRET }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(SECRET);
  });
});

describe('RecruitmentZaloQuarantineService.receive', () => {
  it('request khai đúng app + OA (chưa kiểm chữ ký) → ghi bản MÃ HOÁ rồi mới ACK 200', async () => {
    const db = fakeDb([
      [/INSERT INTO "recruitment_channel_quarantine"/, () => [{ id: 7 }]],
    ]);
    const { svc } = service(QUARANTINE_ENV, db);
    const { body, signature } = event();

    await expect(svc.receive(body, signature)).resolves.toEqual({
      ok: true,
      quarantined: true,
      duplicate: false,
    });
    const [insert] = db.ran(/INSERT INTO "recruitment_channel_quarantine"/);
    const [oa, hash, sig, type, size, enc, max] = insert.params as [
      string,
      string,
      string,
      string,
      number,
      string,
      number,
    ];
    expect([oa, hash, sig, type, size, max]).toEqual([
      'oa-recruit',
      hashOf(body),
      signature,
      'user_send_text',
      body.length,
      2000,
    ]);
    // Không chứa nội dung / người gửi ở dạng rõ; giải mã đúng AAD ra đúng byte gốc.
    expect(JSON.stringify(insert.params)).not.toContain(TEXT);
    expect(JSON.stringify(insert.params)).not.toContain(SENDER);
    expect(
      Buffer.from(decryptToken(KEY, aad(body), enc), 'base64').equals(body),
    ).toBe(true);
    expect(() =>
      decryptToken(KEY, 'quarantine:oa-recruit:khac', enc),
    ).toThrow();
    expect(insert.sql).toMatch(/WHERE \(SELECT count\(\*\)/);
    // Không ghi inbox, không đụng bảng nào khác.
    expect(db.calls).toHaveLength(1);
  });

  it('request KHÔNG có chữ ký vẫn được cách ly (chưa có key để kiểm) — log ghi sig=absent', async () => {
    const db = fakeDb([[/INSERT INTO/, () => [{ id: 8 }]]]);
    const { svc } = service(QUARANTINE_ENV, db);
    await svc.receive(event().body, undefined);
    expect(db.ran(/INSERT INTO/)[0].params[2]).toBeNull();
    expect(logs.join('\n')).toMatch(
      /quarantined id=8 type=user_send_text duplicate=false sig=absent/,
    );
  });

  it.each([
    [
      'không phải JSON',
      Buffer.from('xin chào'),
      BadRequestException,
      'MALFORMED_PAYLOAD',
    ],
    [
      'sai app_id',
      event({ app_id: 'app-khac' }).body,
      ForbiddenException,
      'APP_MISMATCH',
    ],
    [
      'sai OA',
      event({ recipient: { id: 'oa-giao-vien' } }).body,
      ForbiddenException,
      'OA_MISMATCH',
    ],
    [
      'thiếu event_name',
      event({ event_name: undefined }).body,
      BadRequestException,
      'MALFORMED_EVENT',
    ],
  ])(
    '%s → từ chối như receiver thường, KHÔNG ghi gì',
    async (_n, body, type, code) => {
      const db = fakeDb([]);
      const { svc } = service(QUARANTINE_ENV, db);
      const error = await svc.receive(body, 'mac=00').catch((e) => e);
      expect(error).toBeInstanceOf(type);
      expect(error.getResponse()).toEqual({ code });
      expect(db.calls).toHaveLength(0);
    },
  );

  it('request > 64 KB → 413, không ghi (chặn nhồi dung lượng bằng request không chữ ký)', async () => {
    const db = fakeDb([]);
    const { svc } = service(QUARANTINE_ENV, db);
    const { body } = event({
      message: { text: 'a'.repeat(70 * 1024), msg_id: 'big' },
    });
    const error = await svc.receive(body, undefined).catch((e) => e);
    expect(error.getStatus()).toBe(413);
    expect(error.getResponse()).toEqual({ code: 'PAYLOAD_TOO_LARGE' });
    expect(db.calls).toHaveLength(0);
  });

  it('Zalo gửi lại đúng request đó → ACK 200 duplicate=true, không thêm dòng', async () => {
    const db = fakeDb([
      [/INSERT INTO/, () => []],
      [/SELECT "id" FROM "recruitment_channel_quarantine"/, () => [{ id: 7 }]],
    ]);
    const { svc } = service(QUARANTINE_ENV, db);
    await expect(svc.receive(event().body, 'mac=00')).resolves.toMatchObject({
      duplicate: true,
    });
  });

  it('bảng cách ly đầy (trần RECRUITMENT_ZALO_QUARANTINE_MAX_ROWS) → 503 để Zalo gửi lại, không ACK giả', async () => {
    const db = fakeDb([
      [/INSERT INTO/, () => []],
      [/SELECT "id" FROM/, () => []],
    ]);
    const { svc } = service(
      { ...QUARANTINE_ENV, RECRUITMENT_ZALO_QUARANTINE_MAX_ROWS: '3' },
      db,
    );
    const error = await svc.receive(event().body, 'mac=00').catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toEqual({ code: 'QUARANTINE_FULL' });
    expect(db.ran(/INSERT INTO/)[0].params[6]).toBe(3);
  });

  it('DB lỗi khi ghi → 503 EVENT_STORE_UNAVAILABLE (Zalo gửi lại), không bao giờ 200', async () => {
    const db = fakeDb([
      [
        /INSERT INTO/,
        () => Object.assign(new Error('boom'), { code: '57P01' }),
      ],
    ]);
    const { svc } = service(QUARANTINE_ENV, db);
    const error = await svc.receive(event().body, 'mac=00').catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toEqual({ code: 'EVENT_STORE_UNAVAILABLE' });
  });
});

describe('RecruitmentZaloWebhookService ở chế độ cách ly', () => {
  it('cờ quarantine bật → giao cho quarantine, KHÔNG kiểm chữ ký, KHÔNG ghi inbox', async () => {
    const repo = { query: jest.fn() };
    const quarantine = {
      receive: jest
        .fn()
        .mockResolvedValue({ ok: true, quarantined: true, duplicate: false }),
    };
    const webhook = new RecruitmentZaloWebhookService(
      repo as any,
      {
        get: (k: string) => (QUARANTINE_ENV as Record<string, string>)[k],
      } as any,
      quarantine as any,
    );
    const { body } = event();
    await expect(webhook.receive(body, undefined)).resolves.toMatchObject({
      quarantined: true,
    });
    expect(quarantine.receive).toHaveBeenCalledWith(body, undefined);
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('cờ quarantine tắt → receiver thường (request không chữ ký bị 401, không cách ly)', async () => {
    const repo = { query: jest.fn() };
    const quarantine = { receive: jest.fn() };
    const webhook = new RecruitmentZaloWebhookService(
      repo as any,
      { get: (k: string) => (NORMAL_ENV as Record<string, string>)[k] } as any,
      quarantine as any,
    );
    const error = await webhook
      .receive(event().body, undefined)
      .catch((e) => e);
    expect(error.getStatus()).toBe(401);
    expect(quarantine.receive).not.toHaveBeenCalled();
  });
});

describe('RecruitmentZaloQuarantineService.verifyAll — xác minh hồi tố', () => {
  /** Một dòng cách ly như receiver đã ghi. */
  function row(id: number, body: Buffer, signature: string | null, key = KEY) {
    return {
      id,
      channel_account_id: 'oa-recruit',
      payload_hash: hashOf(body),
      signature,
      body_enc: encryptToken(key, aad(body), body.toString('base64')),
    };
  }

  function verifyDb(
    rows: ReturnType<typeof row>[],
    inboxReturns: unknown[][] = [],
  ) {
    const updates: unknown[][] = [];
    let listed = false;
    const db = fakeDb([
      [
        /^\s*UPDATE "recruitment_channel_quarantine"\s+SET "status" = 'EXPIRED'/,
        () => [[], 0],
      ],
      [
        /SELECT "id" FROM "recruitment_channel_quarantine"\s+WHERE "status" = 'QUARANTINED' AND "id" >/,
        () => {
          if (listed) return [];
          listed = true;
          return rows.map((r) => ({ id: r.id }));
        },
      ],
      [/FOR UPDATE SKIP LOCKED/, (p) => rows.filter((r) => r.id === p[0])],
      [
        /INSERT INTO "recruitment_channel_events"/,
        () => inboxReturns.shift() ?? [{ id: 900 }],
      ],
      [
        /SELECT "id", "payload_hash" FROM "recruitment_channel_events"/,
        () => [{ id: 555, payload_hash: 'x' }],
      ],
      [
        /SET "status" = \$2::text/,
        (p) => {
          updates.push(p);
          return [];
        },
      ],
      [/count\(\*\)::int AS "n"/, () => [{ n: 0 }]],
    ]);
    return { db, updates };
  }

  it('quarantine vẫn bật → 409, không xác minh gì', async () => {
    const { db } = verifyDb([]);
    const { svc } = service(QUARANTINE_ENV, db);
    const error = await svc.verifyAll(HR).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe('QUARANTINE_STILL_ACTIVE');
    expect(db.calls).toHaveLength(0);
  });

  it('chưa có OA secret key → 409', async () => {
    const { db } = verifyDb([]);
    const { svc } = service(
      { ...BASE, RECRUITMENT_ZALO_OA_SECRET_KEY: '' },
      db,
    );
    await expect(svc.verifyAll(HR)).rejects.toMatchObject({
      response: { code: 'QUARANTINE_VERIFY_NOT_CONFIGURED' },
    });
  });

  it('chữ ký khớp → vào inbox bằng đường ghi chung (RECEIVED + nội dung chuẩn hoá); sai → REJECTED; mọi dòng xoá nội dung', async () => {
    const good = event();
    const forged = event({ message: { text: 'giả mạo', msg_id: 'msg-2' } });
    const rows = [
      row(1, good.body, good.signature),
      row(2, forged.body, 'mac=' + '0'.repeat(64)),
      row(3, forged.body, null),
    ];
    const { db, updates } = verifyDb(rows);
    const { svc, audit } = service(NORMAL_ENV, db);

    const result = await svc.verifyAll(HR);
    expect(result).toEqual({
      verified: 1,
      duplicates: 0,
      rejected: { INVALID_SIGNATURE: 2 },
      expired: 0,
      undecryptable: 0,
      remaining: 0,
    });
    const [insert] = db.ran(/INSERT INTO "recruitment_channel_events"/);
    expect(insert.params).toEqual([
      'ZALO',
      'oa-recruit',
      null,
      'user_send_text:msg:msg-1',
      SENDER,
      'user_send_text',
      'msg-1',
      expect.any(Date),
      'RECEIVED',
      hashOf(good.body),
      TEXT,
    ]);
    expect(db.ran(/INSERT INTO "recruitment_channel_events"/)).toHaveLength(1);
    expect(updates).toEqual([
      [1, 'VERIFIED', 'NEW', 900],
      [2, 'REJECTED', 'INVALID_SIGNATURE', null],
      [3, 'REJECTED', 'INVALID_SIGNATURE', null],
    ]);
    // UPDATE luôn xoá nội dung.
    for (const u of db.ran(/SET "status" = \$2::text/))
      expect(u.sql).toMatch(/"body_enc" = NULL/);
    // Audit: chỉ số lượng, đúng nhân viên.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: HR,
        action: 'CHANNEL_QUARANTINE_VERIFY',
        entity: 'channel-quarantine',
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(TEXT);
  });

  it('inbox đã có event (Zalo gửi lại sau khi có key) → VERIFIED/DUPLICATE, liên kết event cũ, không ghi thêm', async () => {
    const good = event();
    const { db, updates } = verifyDb([row(1, good.body, good.signature)], [[]]);
    const { svc } = service(NORMAL_ENV, db);
    await expect(svc.verifyAll(HR)).resolves.toMatchObject({
      verified: 0,
      duplicates: 1,
    });
    expect(updates).toEqual([[1, 'VERIFIED', 'DUPLICATE', 555]]);
  });

  it('bản mã giải ra không khớp payload hash → REJECTED/INTEGRITY, không vào inbox', async () => {
    const good = event();
    const tampered = {
      ...row(1, good.body, good.signature),
      payload_hash: 'f'.repeat(64),
    };
    tampered.body_enc = encryptToken(
      KEY,
      `quarantine:oa-recruit:${'f'.repeat(64)}`,
      good.body.toString('base64') + 'AA',
    );
    const { db, updates } = verifyDb([tampered]);
    const { svc } = service(NORMAL_ENV, db);
    await expect(svc.verifyAll(HR)).resolves.toMatchObject({
      rejected: { INTEGRITY: 1 },
    });
    expect(updates).toEqual([[1, 'REJECTED', 'INTEGRITY', null]]);
    expect(db.ran(/INSERT INTO "recruitment_channel_events"/)).toHaveLength(0);
  });

  it('sai RECRUITMENT_ZALO_TOKEN_KEY (không giải mã được) → GIỮ NGUYÊN dòng để sửa key rồi chạy lại', async () => {
    const good = event();
    const { db, updates } = verifyDb([
      row(1, good.body, good.signature, randomBytes(32)),
    ]);
    const { svc } = service(NORMAL_ENV, db);
    await expect(svc.verifyAll(HR)).resolves.toMatchObject({
      undecryptable: 1,
      verified: 0,
    });
    expect(updates).toHaveLength(0);
  });
});
