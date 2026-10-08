import { randomBytes } from 'crypto';

import {
  assertZaloOutboundConfig,
  readZaloOutboundConfig,
  ZALO_OUTBOUND_CONFIG_ERROR,
} from './zalo-outbound.config';
import { decryptToken, encryptToken } from './zalo-token.crypto';

const KEY = randomBytes(32);
const SECRET = 'app-secret-0123456789abcdef';
const BASE = {
  RECRUITMENT_ZALO_OUTBOUND_ENABLED: 'true',
  RECRUITMENT_ZALO_OA_ID: 'oa-recruit',
  RECRUITMENT_ZALO_APP_ID: 'app123',
  RECRUITMENT_ZALO_APP_SECRET: SECRET,
  RECRUITMENT_ZALO_TOKEN_KEY: KEY.toString('base64'),
};
const get = (values: Record<string, string | undefined>) => (key: string) =>
  values[key];

describe('cấu hình gửi tin Zalo OA tuyển dụng', () => {
  it('đủ biến → URL Zalo thật làm mặc định, mã token mặc định -216, chưa có mã vĩnh viễn', () => {
    const result = readZaloOutboundConfig(get(BASE));
    expect('config' in result).toBe(true);
    if (!('config' in result)) return;
    expect(result.config).toMatchObject({
      oaId: 'oa-recruit',
      apiUrl: 'https://openapi.zalo.me',
      oauthUrl: 'https://oauth.zaloapp.com',
      maxTextLength: 2000,
      maxRejectAttempts: 3,
    });
    expect([...result.config.tokenErrors]).toEqual([-216]);
    expect([...result.config.permanentErrors]).toEqual([]);
    expect(result.config.tokenKey.equals(KEY)).toBe(true);
  });

  it('kill switch tắt (mặc định) → không kiểm, không cần credential', () => {
    expect(() => assertZaloOutboundConfig(get({}))).not.toThrow();
    expect(() =>
      assertZaloOutboundConfig(
        get({ ...BASE, RECRUITMENT_ZALO_OUTBOUND_ENABLED: 'false' }),
      ),
    ).not.toThrow();
  });

  it('khoá dạng hex 64 ký tự cũng nhận', () => {
    const result = readZaloOutboundConfig(
      get({ ...BASE, RECRUITMENT_ZALO_TOKEN_KEY: KEY.toString('hex') }),
    );
    expect('config' in result && result.config.tokenKey.equals(KEY)).toBe(true);
  });

  it.each([
    ['RECRUITMENT_ZALO_TOKEN_KEY', { RECRUITMENT_ZALO_TOKEN_KEY: undefined }],
    ['RECRUITMENT_ZALO_TOKEN_KEY', { RECRUITMENT_ZALO_TOKEN_KEY: 'c2hvcnQ=' }],
    ['RECRUITMENT_ZALO_APP_SECRET', { RECRUITMENT_ZALO_APP_SECRET: 'short' }],
    ['RECRUITMENT_ZALO_OA_ID', { RECRUITMENT_ZALO_OA_ID: 'legacy' }],
    ['RECRUITMENT_ZALO_APP_ID', { RECRUITMENT_ZALO_APP_ID: '' }],
    [
      'RECRUITMENT_ZALO_API_URL',
      { RECRUITMENT_ZALO_API_URL: 'openapi.zalo.me' },
    ],
    [
      'RECRUITMENT_ZALO_PERMANENT_ERRORS',
      { RECRUITMENT_ZALO_PERMANENT_ERRORS: '-213,abc' },
    ],
  ])('bật mà %s sai → không khởi động, lỗi không lộ secret', (name, patch) => {
    let message = '';
    try {
      assertZaloOutboundConfig(get({ ...BASE, ...patch }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(ZALO_OUTBOUND_CONFIG_ERROR);
    expect(message).toContain(name);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(KEY.toString('base64'));
  });

  it('danh sách mã lỗi đọc từ cấu hình', () => {
    const result = readZaloOutboundConfig(
      get({
        ...BASE,
        RECRUITMENT_ZALO_PERMANENT_ERRORS: '-213, -217',
        RECRUITMENT_ZALO_TOKEN_ERRORS: '-216,-124',
      }),
    );
    if (!('config' in result)) throw new Error('mong đợi hợp lệ');
    expect([...result.config.permanentErrors]).toEqual([-213, -217]);
    expect([...result.config.tokenErrors]).toEqual([-216, -124]);
  });
});

describe('mã hoá token trong DB (AES-256-GCM)', () => {
  it('mã hoá rồi giải được; IV ngẫu nhiên nên hai lần mã hoá khác nhau; không chứa bản rõ', () => {
    const a = encryptToken(KEY, 'oa-recruit', 'access-token-xyz');
    const b = encryptToken(KEY, 'oa-recruit', 'access-token-xyz');
    expect(a).not.toBe(b);
    expect(a).not.toContain('access-token-xyz');
    expect(decryptToken(KEY, 'oa-recruit', a)).toBe('access-token-xyz');
  });

  it.each([
    ['sai khoá', (s: string) => decryptToken(randomBytes(32), 'oa-recruit', s)],
    ['chép sang OA khác', (s: string) => decryptToken(KEY, 'oa-teacher', s)],
    [
      'bị sửa',
      (s: string) => decryptToken(KEY, 'oa-recruit', `${s.slice(0, -2)}AA`),
    ],
    ['sai định dạng', () => decryptToken(KEY, 'oa-recruit', 'plain-token')],
  ])('%s → lỗi, không trả token rác', (_name, read) => {
    const stored = encryptToken(KEY, 'oa-recruit', 'access-token-xyz');
    expect(() => read(stored)).toThrow();
  });
});
