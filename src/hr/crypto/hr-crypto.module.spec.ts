import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { HrModule } from '../hr.module';
import { HrCryptoModule } from './hr-crypto.module';
import { HrCryptoService } from './hr-crypto.service';

const newKey = () => randomBytes(32).toString('base64');
const VARS = [
  'HR_ENCRYPTION_ACTIVE_KEY_VERSION',
  'HR_ENCRYPTION_KEY_V1',
  'HR_HMAC_ACTIVE_KEY_VERSION',
  'HR_HMAC_KEY_V1',
];

/**
 * Chỉ dựng provider HrCryptoService (controller/guard của module cần DB).
 * Cùng factory `HrCryptoService.fromEnv(process.env)` như module thật.
 */
async function compileCrypto() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      {
        provide: HrCryptoService,
        useFactory: () => HrCryptoService.fromEnv(process.env),
      },
    ],
  }).compile();
  return moduleRef.get(HrCryptoService);
}

describe('HrCryptoModule — degraded mode lúc khởi động', () => {
  const saved: Record<string, string | undefined> = {};
  let warn: jest.SpyInstance;
  const warned = () => warn.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    for (const name of VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('[21.1] thiếu toàn bộ khoá → KHÔNG ném, UNAVAILABLE, log tên biến + mã lỗi', async () => {
    const crypto = await compileCrypto();
    expect(crypto.status()).toEqual({
      status: 'UNAVAILABLE',
      encryptionKeyringReady: false,
      hmacKeyringReady: false,
      activeEncryptionVersion: null,
      activeHmacVersion: null,
    });
    expect(warned()).toContain('HR crypto unavailable');
    expect(warned()).toContain('HR_ENCRYPTION_ACTIVE_KEY_VERSION');
    expect(warned()).toContain('[HR_CRYPTO_CONFIG]');
  });

  it('[21.9] khoá sai → log chỉ có tên biến, không có giá trị', async () => {
    const bad = randomBytes(16).toString('base64');
    const hmac = newKey();
    process.env.HR_ENCRYPTION_ACTIVE_KEY_VERSION = 'v1';
    process.env.HR_ENCRYPTION_KEY_V1 = bad;
    process.env.HR_HMAC_ACTIVE_KEY_VERSION = 'v1';
    process.env.HR_HMAC_KEY_V1 = hmac;
    const crypto = await compileCrypto();

    expect(warned()).toContain('HR_ENCRYPTION_KEY_V1');
    expect(warned()).not.toContain(bad);
    expect(warned()).not.toContain(hmac);
    expect(warned()).not.toMatch(/HR_ENCRYPTION_KEY_V1=/);
    expect(crypto.status()).toMatchObject({
      status: 'UNAVAILABLE',
      encryptionKeyringReady: false,
      hmacKeyringReady: true,
    });
  });

  it('[21.6] thiếu HMAC → ghi dữ liệu nhạy cảm 503; reveal (chỉ cần khoá mã hoá) vẫn được', async () => {
    process.env.HR_ENCRYPTION_ACTIVE_KEY_VERSION = 'v1';
    process.env.HR_ENCRYPTION_KEY_V1 = newKey();
    const crypto = await compileCrypto();
    expect(() => crypto.forSensitiveWrite()).toThrow(
      ServiceUnavailableException,
    );
    expect(crypto.encryption().activeKeyVersion).toBe('v1');
  });

  it('HMAC trùng khoá mã hoá → cả hai UNAVAILABLE, log không có khoá', async () => {
    const key = newKey();
    process.env.HR_ENCRYPTION_ACTIVE_KEY_VERSION = 'v1';
    process.env.HR_ENCRYPTION_KEY_V1 = key;
    process.env.HR_HMAC_ACTIVE_KEY_VERSION = 'v1';
    process.env.HR_HMAC_KEY_V1 = key;
    const crypto = await compileCrypto();
    expect(crypto.status()).toMatchObject({
      status: 'UNAVAILABLE',
      encryptionKeyringReady: false,
      hmacKeyringReady: false,
    });
    expect(warned()).not.toContain(key);
  });

  it('503 mang mã HR_CRYPTO_UNAVAILABLE', async () => {
    const crypto = await compileCrypto();
    let error: ServiceUnavailableException | undefined;
    try {
      crypto.encryption();
    } catch (err) {
      error = err as ServiceUnavailableException;
    }
    expect(error?.getStatus()).toBe(503);
    expect(error?.getResponse()).toMatchObject({
      code: 'HR_CRYPTO_UNAVAILABLE',
    });
  });

  it('đủ khoá → AVAILABLE; status chỉ lộ version', async () => {
    const enc = newKey();
    const hmac = newKey();
    process.env.HR_ENCRYPTION_ACTIVE_KEY_VERSION = 'v1';
    process.env.HR_ENCRYPTION_KEY_V1 = enc;
    process.env.HR_HMAC_ACTIVE_KEY_VERSION = 'v1';
    process.env.HR_HMAC_KEY_V1 = hmac;
    const crypto = await compileCrypto();
    const status = crypto.status();
    expect(status).toEqual({
      status: 'AVAILABLE',
      encryptionKeyringReady: true,
      hmacKeyringReady: true,
      activeEncryptionVersion: 'v1',
      activeHmacVersion: 'v1',
    });
    expect(JSON.stringify(status)).not.toContain(enc);
    expect(JSON.stringify(status)).not.toContain(hmac);
  });

  it('module đã gắn vào HrModule (0.4B)', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', HrModule) ?? [];
    expect(imports).toContain(HrCryptoModule);
  });
});
