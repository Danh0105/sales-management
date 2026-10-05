import { randomBytes } from 'crypto';
import { inspect } from 'util';
import { HrCryptoConfigError } from './hr-crypto.errors';
import { loadHrCryptoKeyrings, loadHrKeyring } from './hr-keyring';

// Key sinh ngẫu nhiên trong test — không có key thật nào trong source.
const newKey = (bytes = 32) => randomBytes(bytes).toString('base64');

const load = (env: Record<string, string>) => loadHrKeyring(env, 'encryption');
const expectConfigError = (env: Record<string, string>, text: string) => {
  expect(() => load(env)).toThrow(HrCryptoConfigError);
  expect(() => load(env)).toThrow(text);
};

describe('HrKeyring — nạp cấu hình hợp lệ', () => {
  it('v1 active', () => {
    const ring = load({
      HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
      HR_ENCRYPTION_KEY_V1: newKey(),
    });
    expect(ring.activeVersion).toBe('v1');
    expect(ring.versions()).toEqual(['v1']);
  });

  it('nhiều version, sắp theo số (v2 < v10), active = v2', () => {
    const ring = load({
      HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v2',
      HR_ENCRYPTION_KEY_V10: newKey(),
      HR_ENCRYPTION_KEY_V1: newKey(),
      HR_ENCRYPTION_KEY_V2: newKey(),
    });
    expect(ring.versions()).toEqual(['v1', 'v2', 'v10']);
    expect(ring.activeVersion).toBe('v2');
  });

  it('bỏ qua biến không liên quan', () => {
    const ring = load({
      HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
      HR_ENCRYPTION_KEY_V1: newKey(),
      HR_HMAC_KEY_V1: newKey(),
      JWT_SECRET: 'x',
    });
    expect(ring.versions()).toEqual(['v1']);
  });
});

describe('HrKeyring — fail fast khi cấu hình sai', () => {
  it('thiếu active version', () => {
    expectConfigError(
      { HR_ENCRYPTION_KEY_V1: newKey() },
      'Thiếu HR_ENCRYPTION_ACTIVE_KEY_VERSION',
    );
  });

  it('thiếu toàn bộ key', () => {
    expectConfigError(
      { HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1' },
      'thiếu HR_ENCRYPTION_KEY_V1',
    );
  });

  it('active version không tồn tại trong keyring', () => {
    expectConfigError(
      {
        HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v2',
        HR_ENCRYPTION_KEY_V1: newKey(),
      },
      'thiếu HR_ENCRYPTION_KEY_V2',
    );
  });

  it.each(['1', 'V1', 'v01', 'v0', 'version1', 'v1 x'])(
    'active version sai định dạng: %s',
    (active) => {
      expectConfigError(
        {
          HR_ENCRYPTION_ACTIVE_KEY_VERSION: active,
          HR_ENCRYPTION_KEY_V1: newKey(),
        },
        'phải có dạng v<số>',
      );
    },
  );

  it.each([
    'HR_ENCRYPTION_KEY_V01',
    'HR_ENCRYPTION_KEY_V0',
    'HR_ENCRYPTION_KEY_1',
    'HR_ENCRYPTION_KEY_v1',
    'hr_encryption_key_v1',
    'HR_ENCRYPTION_KEY_V1_OLD',
  ])('tên biến key sai/trùng kiểu chữ: %s', (name) => {
    expectConfigError(
      {
        HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
        HR_ENCRYPTION_KEY_V1: newKey(),
        [name]: newKey(),
      },
      'không hợp lệ',
    );
  });

  it('biến không version HR_ENCRYPTION_KEY bị từ chối', () => {
    expectConfigError(
      { HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1', HR_ENCRYPTION_KEY: newKey() },
      'không được hỗ trợ',
    );
  });

  it('[10] Base64 không hợp lệ', () => {
    for (const bad of [
      'not base64!!',
      `${newKey().slice(0, -1)}`, // mất padding
      newKey().replace(/.$/, '*'),
      Buffer.from(randomBytes(32)).toString('base64url'), // base64url, không phải base64
    ]) {
      expect(() =>
        load({
          HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
          HR_ENCRYPTION_KEY_V1: bad,
        }),
      ).toThrow(HrCryptoConfigError);
    }
  });

  it.each([16, 24, 31, 33, 64])(
    '[11] key giải mã ra %i byte (không đủ/thừa 32) → fail',
    (bytes) => {
      expectConfigError(
        {
          HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
          HR_ENCRYPTION_KEY_V1: newKey(bytes),
        },
        `(đang là ${bytes} byte)`,
      );
    },
  );

  it('key để trống', () => {
    expectConfigError(
      { HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1', HR_ENCRYPTION_KEY_V1: '  ' },
      'đang để trống',
    );
  });

  it('key không ngẫu nhiên (toàn byte 0)', () => {
    expectConfigError(
      {
        HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
        HR_ENCRYPTION_KEY_V1: Buffer.alloc(32).toString('base64'),
      },
      'không phải key ngẫu nhiên',
    );
  });

  it('hai version dùng chung material', () => {
    const key = newKey();
    expectConfigError(
      {
        HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v2',
        HR_ENCRYPTION_KEY_V1: key,
        HR_ENCRYPTION_KEY_V2: key,
      },
      'trùng material',
    );
  });

  it('HMAC key trùng encryption key', () => {
    const key = newKey();
    expect(() =>
      loadHrCryptoKeyrings({
        HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
        HR_ENCRYPTION_KEY_V1: key,
        HR_HMAC_ACTIVE_KEY_VERSION: 'v1',
        HR_HMAC_KEY_V1: key,
      }),
    ).toThrow('hai loại phải sinh riêng');
  });

  it('thiếu cấu hình HMAC → fail', () => {
    expect(() =>
      loadHrCryptoKeyrings({
        HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
        HR_ENCRYPTION_KEY_V1: newKey(),
      }),
    ).toThrow('Thiếu HR_HMAC_ACTIVE_KEY_VERSION');
  });
});

describe('HrKeyring — không lộ key', () => {
  it('message lỗi cấu hình không chứa giá trị key', () => {
    const shortKey = newKey(16);
    let error: Error | undefined;
    try {
      load({
        HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
        HR_ENCRYPTION_KEY_V1: shortKey,
      });
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeInstanceOf(HrCryptoConfigError);
    expect(
      `${error?.message}\n${error?.stack}\n${inspect(error)}`,
    ).not.toContain(shortKey);
  });

  it('inspect / JSON.stringify keyring chỉ ra version', () => {
    const key = newKey();
    const ring = load({
      HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
      HR_ENCRYPTION_KEY_V1: key,
    });
    const hex = Buffer.from(key, 'base64').toString('hex');
    for (const dump of [inspect(ring, { depth: 10 }), JSON.stringify(ring)]) {
      expect(dump).not.toContain(key);
      expect(dump).not.toContain(hex);
      expect(dump).toContain('v1');
    }
  });

  it('buffer env không bị giữ lại: xoá biến môi trường sau khi nạp vẫn dùng được', () => {
    const env: Record<string, string> = {
      HR_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
      HR_ENCRYPTION_KEY_V1: newKey(),
    };
    const ring = load(env);
    delete env.HR_ENCRYPTION_KEY_V1;
    expect(ring.keyFor('v1')?.symmetricKeySize).toBe(32);
  });
});
