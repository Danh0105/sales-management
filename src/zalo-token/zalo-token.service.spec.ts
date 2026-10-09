import { Logger } from '@nestjs/common';
import axios from 'axios';

import { NotifyService } from '../notify-zalo/notify.service';
import { ZaloToken } from './zalo-token.entity';
import { ZaloTokenError, ZaloTokenService } from './zalo-token.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const OLD_ACCESS = 'old-access-token-AAAAAAAAAAAAAAAAAAAA';
const OLD_REFRESH = 'old-refresh-token-BBBBBBBBBBBBBBBBBBB';
const NEW_ACCESS = 'new-access-token-CCCCCCCCCCCCCCCCCCCC';
const NEW_REFRESH = 'new-refresh-token-DDDDDDDDDDDDDDDDDDD';
const APP_SECRET = 'app-secret-EEEEEEEEEEEEEEEEEEEEEEEEE';
const SECRETS = [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH, APP_SECRET];

/**
 * DB giả: một dòng `zalo_tokens` dùng chung; `transaction()` tuần tự hoá như
 * advisory lock thật (transaction sau chờ transaction trước xong).
 */
function fakeDb(expiresAt: number) {
  const row: Partial<ZaloToken> = {
    id: 1,
    access_token: OLD_ACCESS,
    refresh_token: OLD_REFRESH,
    expires_in: 90000,
    expires_at: expiresAt,
  };
  const lockCalls: unknown[][] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const repoOf = () => ({
    findOne: jest.fn(async () => ({ ...row })),
  });
  const em = {
    query: jest.fn(async (...args: unknown[]) => {
      lockCalls.push(args);
      return [];
    }),
    getRepository: jest.fn(() => repoOf()),
    save: jest.fn(async (token: ZaloToken) => Object.assign(row, token)),
  };
  const manager = {
    getRepository: jest.fn(() => repoOf()),
    transaction: jest.fn((fn: (e: typeof em) => Promise<unknown>) => {
      const run = chain.then(() => fn(em));
      chain = run.catch(() => undefined);
      return run;
    }),
  };
  return { repo: { manager } as any, row, em, lockCalls };
}

describe('ZaloTokenService — refresh không lộ token, có khoá', () => {
  let logs: string[];

  beforeEach(() => {
    process.env.ZALO_APP_ID = 'app-1';
    process.env.ZALO_APP_SECRET = APP_SECRET;
    logs = [];
    post.mockReset();
    const capture = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    for (const level of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      jest.spyOn(console, level).mockImplementation(capture);
    }
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(capture);
    }
  });

  afterEach(() => {
    // Không một log nào được chứa token / secret / body OAuth.
    const all = logs.join('\n');
    for (const secret of SECRETS) expect(all).not.toContain(secret);
    jest.restoreAllMocks();
  });

  it('token còn hạn → dùng luôn, không gọi Zalo', async () => {
    const db = fakeDb(Date.now() + 3_600_000);
    await expect(new ZaloTokenService(db.repo).getValidToken()).resolves.toBe(OLD_ACCESS);
    expect(post).not.toHaveBeenCalled();
  });

  it('hết hạn → refresh dưới advisory lock, lưu cặp token mới, log không chứa token', async () => {
    const db = fakeDb(Date.now() - 1000);
    post.mockResolvedValue({
      data: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: '90000' },
    });
    await expect(new ZaloTokenService(db.repo).getValidToken()).resolves.toBe(NEW_ACCESS);
    expect(db.lockCalls[0]).toEqual(['SELECT pg_advisory_xact_lock(hashtext($1))', ['zalo_tokens:refresh']]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][2].headers.secret_key).toBe(APP_SECRET);
    expect(db.row).toMatchObject({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 90000 });
    expect(logs.join('\n')).toMatch(/Đã refresh token Zalo OA/);
  });

  it('2 lời gọi đồng thời (vd. 3010 + 3011) khi token hết hạn → Zalo chỉ bị refresh ĐÚNG 1 lần', async () => {
    const db = fakeDb(Date.now() - 1000);
    post.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { data: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 90000 } };
    });
    const a = new ZaloTokenService(db.repo);
    const b = new ZaloTokenService(db.repo);
    await expect(Promise.all([a.getValidToken(), b.getValidToken()])).resolves.toEqual([NEW_ACCESS, NEW_ACCESS]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('Zalo trả body thiếu refresh_token (dù có access_token) → lỗi chỉ mang mã, không lưu, không lộ token', async () => {
    const db = fakeDb(Date.now() - 1000);
    post.mockResolvedValue({ data: { access_token: NEW_ACCESS, error: -14014, error_name: 'Invalid refresh token' } });
    const error = await new ZaloTokenService(db.repo).getValidToken().catch((e) => e);
    expect(error).toBeInstanceOf(ZaloTokenError);
    expect(error.message).toContain('-14014');
    for (const secret of SECRETS) expect(error.message).not.toContain(secret);
    expect(db.row.access_token).toBe(OLD_ACCESS);
  });

  it('axios ném lỗi (config chứa refresh_token + secret_key) → lỗi ném ra đã làm sạch', async () => {
    const db = fakeDb(Date.now() - 1000);
    post.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        config: { data: `refresh_token=${OLD_REFRESH}`, headers: { secret_key: APP_SECRET } },
        response: { status: 400, data: { error: -14014, refresh_token: OLD_REFRESH } },
      }),
    );
    const error = await new ZaloTokenService(db.repo).getValidToken().catch((e) => e);
    expect(error).toBeInstanceOf(ZaloTokenError);
    expect(error.message).toBe('Refresh token Zalo OA thất bại (HTTP 400 -14014)');
    expect(JSON.stringify(error)).not.toContain(OLD_REFRESH);
    expect((error as { config?: unknown }).config).toBeUndefined();
  });
});

describe('NotifyService — không log token / response', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    post.mockReset();
    const capture = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    for (const level of ['log', 'error', 'warn'] as const) {
      jest.spyOn(console, level).mockImplementation(capture);
      jest.spyOn(Logger.prototype, level).mockImplementation(capture);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  const tokens = { getValidToken: jest.fn().mockResolvedValue(NEW_ACCESS) } as any;

  it('gửi thành công → không log response, không log token', async () => {
    post.mockResolvedValue({ data: { error: 0, data: { message_id: 'm1', user_id: 'u-123456' } } });
    await new NotifyService(tokens).sendMessage('u-123456', 'Cảnh báo');
    expect(logs).toHaveLength(0);
  });

  it('gửi lỗi → chỉ log mã; lỗi ném ra không mang config (header access_token)', async () => {
    post.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 500'), {
        config: { headers: { access_token: NEW_ACCESS } },
        response: { status: 500, data: { error: -32, message: 'x' } },
      }),
    );
    const error = await new NotifyService(tokens).sendMessage('u-123456', 'Cảnh báo').catch((e) => e);
    expect(error).toBeInstanceOf(ZaloTokenError);
    expect(error.config).toBeUndefined();
    expect(logs.join('\n')).toBe('Zalo send error: HTTP 500 -32');
    expect(logs.join('\n')).not.toContain(NEW_ACCESS);
  });
});
