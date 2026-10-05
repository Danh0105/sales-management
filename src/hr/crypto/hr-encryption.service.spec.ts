import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { inspect } from 'util';
import { HrCryptoError } from './hr-crypto.errors';
import {
  HrEncryptionService,
  MAX_PLAINTEXT_BYTES,
  parseHrEncryptedPayload,
} from './hr-encryption.service';
import { loadHrKeyring } from './hr-keyring';

const newKey = () => randomBytes(32).toString('base64');
const CTX = 'hr.employee_identity.identity_number';
const CCCD = '079201001234';

function service(active: string, keys: Record<string, string>) {
  const env: Record<string, string> = {
    HR_ENCRYPTION_ACTIVE_KEY_VERSION: active,
  };
  for (const [version, key] of Object.entries(keys)) {
    env[`HR_ENCRYPTION_KEY_${version.toUpperCase()}`] = key;
  }
  return new HrEncryptionService(loadHrKeyring(env, 'encryption'));
}

/** Bắt lỗi để kiểm tra cả mã lỗi lẫn nội dung message. */
function caught(fn: () => unknown): HrCryptoError {
  try {
    fn();
  } catch (err) {
    return err as HrCryptoError;
  }
  throw new Error('Mong đợi lỗi nhưng không có');
}

/** Sửa một byte trong phần thứ `index` của payload (giữ base64url hợp lệ). */
function tamper(payload: string, index: number): string {
  const parts = payload.split(':');
  const bytes = Buffer.from(parts[index], 'base64url');
  bytes[0] ^= 0x01;
  parts[index] = bytes.toString('base64url');
  return parts.join(':');
}

describe('HrEncryptionService — AES-256-GCM', () => {
  const V1 = newKey();
  const svc = service('v1', { v1: V1 });

  it('[1] encrypt → decrypt đúng; payload có đủ format/keyVersion/iv/tag/ciphertext', () => {
    const payload = svc.encrypt(CCCD, CTX);
    expect(payload).toMatch(/^hrenc:1:v1:[\w-]{16}:[\w-]{22}:[\w-]+$/);
    expect(payload).not.toContain(CCCD);
    expect(svc.decrypt(payload, CTX)).toBe(CCCD);

    const env = parseHrEncryptedPayload(payload);
    expect(env.iv).toHaveLength(12);
    expect(env.tag).toHaveLength(16);
  });

  it('[2] cùng plaintext mã hoá 2 lần → IV và ciphertext khác nhau', () => {
    const a = svc.encrypt(CCCD, CTX);
    const b = svc.encrypt(CCCD, CTX);
    expect(a).not.toBe(b);
    expect(parseHrEncryptedPayload(a).iv).not.toEqual(
      parseHrEncryptedPayload(b).iv,
    );
    expect(svc.decrypt(a, CTX)).toBe(svc.decrypt(b, CTX));
  });

  it('IV không lặp trong 2000 lần mã hoá', () => {
    const ivs = new Set(
      Array.from({ length: 2000 }, () => svc.encrypt(CCCD, CTX).split(':')[3]),
    );
    expect(ivs.size).toBe(2000);
  });

  it('[3] sửa ciphertext → DECRYPTION_FAILED', () => {
    const e = caught(() => svc.decrypt(tamper(svc.encrypt(CCCD, CTX), 5), CTX));
    expect(e).toBeInstanceOf(HrCryptoError);
    expect(e.code).toBe('DECRYPTION_FAILED');
  });

  it('[4] sửa auth tag → DECRYPTION_FAILED', () => {
    const e = caught(() => svc.decrypt(tamper(svc.encrypt(CCCD, CTX), 4), CTX));
    expect(e.code).toBe('DECRYPTION_FAILED');
  });

  it('sửa IV → DECRYPTION_FAILED', () => {
    const e = caught(() => svc.decrypt(tamper(svc.encrypt(CCCD, CTX), 3), CTX));
    expect(e.code).toBe('DECRYPTION_FAILED');
  });

  it('[5] sai key (cùng tên version v1, khác material) → DECRYPTION_FAILED', () => {
    const other = service('v1', { v1: newKey() });
    const e = caught(() => other.decrypt(svc.encrypt(CCCD, CTX), CTX));
    expect(e.code).toBe('DECRYPTION_FAILED');
  });

  it('AAD: chép ciphertext sang cột khác (context khác) → DECRYPTION_FAILED', () => {
    const payload = svc.encrypt(CCCD, CTX);
    const e = caught(() =>
      svc.decrypt(payload, 'hr.employee_bank.account_number'),
    );
    expect(e.code).toBe('DECRYPTION_FAILED');
  });

  it('AAD: đổi keyVersion trong header sang version khác có thật → DECRYPTION_FAILED', () => {
    const both = service('v2', { v1: V1, v2: newKey() });
    const payload = svc.encrypt(CCCD, CTX).replace(':v1:', ':v2:');
    expect(caught(() => both.decrypt(payload, CTX)).code).toBe(
      'DECRYPTION_FAILED',
    );
  });
});

describe('HrEncryptionService — key rotation', () => {
  const V1 = newKey();
  const V2 = newKey();
  const onlyV1 = service('v1', { v1: V1 });
  const activeV2 = service('v2', { v1: V1, v2: V2 });

  it('[6] dữ liệu ghi bằng v1 vẫn đọc được khi active = v2', () => {
    const old = onlyV1.encrypt(CCCD, CTX);
    expect(activeV2.keyVersionOf(old)).toBe('v1');
    expect(activeV2.decrypt(old, CTX)).toBe(CCCD);
  });

  it('[7] dữ liệu mới khi active = v2 → ghi bằng v2', () => {
    const fresh = activeV2.encrypt(CCCD, CTX);
    expect(fresh.startsWith('hrenc:1:v2:')).toBe(true);
    expect(activeV2.keyVersionOf(fresh)).toBe('v2');
    // Keyring chỉ còn v1 thì không đọc được — vì vậy KHÔNG được gỡ v2 khi rollback.
    expect(caught(() => onlyV1.decrypt(fresh, CTX)).code).toBe(
      'UNKNOWN_KEY_VERSION',
    );
  });

  it('rollback ACTIVE v2 → v1 (giữ V2 trong keyring): đọc được cả hai, ghi lại bằng v1', () => {
    const rolledBack = service('v1', { v1: V1, v2: V2 });
    const writtenByV2 = activeV2.encrypt(CCCD, CTX);
    const writtenByV1 = onlyV1.encrypt(CCCD, CTX);
    expect(rolledBack.decrypt(writtenByV2, CTX)).toBe(CCCD);
    expect(rolledBack.decrypt(writtenByV1, CTX)).toBe(CCCD);
    expect(rolledBack.encrypt(CCCD, CTX).startsWith('hrenc:1:v1:')).toBe(true);
  });

  it('needsReEncryption / reEncrypt: v1 → v2; đã ở v2 thì trả nguyên', () => {
    const old = onlyV1.encrypt(CCCD, CTX);
    expect(activeV2.needsReEncryption(old)).toBe(true);

    const migrated = activeV2.reEncrypt(old, CTX);
    expect(activeV2.keyVersionOf(migrated)).toBe('v2');
    expect(activeV2.decrypt(migrated, CTX)).toBe(CCCD);
    expect(activeV2.needsReEncryption(migrated)).toBe(false);
    expect(activeV2.reEncrypt(migrated, CTX)).toBe(migrated);
  });

  it('reEncrypt không bỏ qua payload đã ở active nhưng bị sửa', () => {
    const tampered = tamper(activeV2.encrypt(CCCD, CTX), 5);
    expect(caught(() => activeV2.reEncrypt(tampered, CTX)).code).toBe(
      'DECRYPTION_FAILED',
    );
  });
});

describe('HrEncryptionService — payload sai', () => {
  const svc = service('v1', { v1: newKey() });
  const good = svc.encrypt(CCCD, CTX);
  const [, , , iv, tag, ct] = good.split(':');

  it.each([
    ['chuỗi rỗng', ''],
    ['không có prefix', CCCD],
    ['prefix khác', good.replace('hrenc', 'enc')],
    ['thiếu phần', `hrenc:1:v1:${iv}:${tag}`],
    ['thừa phần', `${good}:x`],
    ['keyVersion sai định dạng', `hrenc:1:V1:${iv}:${tag}:${ct}`],
    ['iv sai độ dài', `hrenc:1:v1:${iv}AA:${tag}:${ct}`],
    ['tag sai độ dài', `hrenc:1:v1:${iv}:${tag.slice(0, 10)}:${ct}`],
    ['ký tự ngoài base64url', `hrenc:1:v1:${iv}:${tag}:${ct}+/`],
    ['ciphertext rỗng', `hrenc:1:v1:${iv}:${tag}:`],
    ['JSON thay vì chuỗi', JSON.stringify({ keyVersion: 'v1', iv, tag, ct })],
  ])('[8] %s → MALFORMED_PAYLOAD', (_label, payload) => {
    const e = caught(() => svc.decrypt(payload, CTX));
    expect(e).toBeInstanceOf(HrCryptoError);
    expect(e.code).toBe('MALFORMED_PAYLOAD');
  });

  it('[8] không phải chuỗi (object, số) → MALFORMED_PAYLOAD', () => {
    expect(caught(() => svc.decrypt({} as unknown as string, CTX)).code).toBe(
      'MALFORMED_PAYLOAD',
    );
    expect(caught(() => svc.decrypt(123 as unknown as string, CTX)).code).toBe(
      'MALFORMED_PAYLOAD',
    );
  });

  it('format version lạ → UNSUPPORTED_FORMAT', () => {
    expect(
      caught(() => svc.decrypt(good.replace('hrenc:1:', 'hrenc:2:'), CTX)).code,
    ).toBe('UNSUPPORTED_FORMAT');
  });

  it('[9] thiếu keyVersion → MISSING_KEY_VERSION', () => {
    const e = caught(() => svc.decrypt(`hrenc:1::${iv}:${tag}:${ct}`, CTX));
    expect(e.code).toBe('MISSING_KEY_VERSION');
    expect(e.message).toContain('thiếu key version');
  });

  it('keyVersion không có trong keyring → UNKNOWN_KEY_VERSION', () => {
    const e = caught(() => svc.decrypt(`hrenc:1:v9:${iv}:${tag}:${ct}`, CTX));
    expect(e.code).toBe('UNKNOWN_KEY_VERSION');
    expect(e.message).toContain('v9');
  });

  it.each(['', 'identity_number', 'HR.X.Y', 'hr.', 'hr..x', 'hr.x y'])(
    'context sai định dạng "%s" → INVALID_CONTEXT',
    (context) => {
      expect(caught(() => svc.encrypt(CCCD, context)).code).toBe(
        'INVALID_CONTEXT',
      );
      expect(caught(() => svc.decrypt(good, context)).code).toBe(
        'INVALID_CONTEXT',
      );
    },
  );
});

describe('HrEncryptionService — Unicode, null, rỗng', () => {
  const svc = service('v1', { v1: newKey() });

  it.each([
    'Nguyễn Thị Ánh Tuyết',
    'Số 12, đường Lê Lợi, phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
    'ẮẰẲẴẶ ấầẩẫậ ỨỪỬỮỰ đĐ',
    'é (dạng NFD) vs é (NFC)',
    '😀 emoji 4 byte',
  ])('[13] Unicode giữ nguyên từng byte: %s', (text) => {
    const back = svc.decrypt(svc.encrypt(text, CTX), CTX);
    expect(back).toBe(text);
    expect(Buffer.from(back, 'utf8')).toEqual(Buffer.from(text, 'utf8'));
  });

  it('[14] null/undefined = không có giá trị → lưu NULL, đọc NULL', () => {
    expect(svc.encryptNullable(null, CTX)).toBeNull();
    expect(svc.encryptNullable(undefined, CTX)).toBeNull();
    expect(svc.decryptNullable(null, CTX)).toBeNull();
    expect(svc.decryptNullable(undefined, CTX)).toBeNull();
    expect(svc.decryptNullable(svc.encryptNullable(CCCD, CTX), CTX)).toBe(CCCD);
  });

  it('[14] chuỗi rỗng bị từ chối (không mã hoá ""; trường trống phải là null)', () => {
    expect(caught(() => svc.encrypt('', CTX)).code).toBe('EMPTY_PLAINTEXT');
    expect(caught(() => svc.encryptNullable('', CTX)).code).toBe(
      'EMPTY_PLAINTEXT',
    );
  });

  it('[14] khoảng trắng là giá trị thật — mã hoá nguyên văn (chuẩn hoá là việc của DTO)', () => {
    expect(svc.decrypt(svc.encrypt(' ', CTX), CTX)).toBe(' ');
  });

  it('plaintext quá lớn → PLAINTEXT_TOO_LONG', () => {
    expect(
      caught(() => svc.encrypt('x'.repeat(MAX_PLAINTEXT_BYTES + 1), CTX)).code,
    ).toBe('PLAINTEXT_TOO_LONG');
    expect(() =>
      svc.encrypt('x'.repeat(MAX_PLAINTEXT_BYTES), CTX),
    ).not.toThrow();
  });
});

describe('[12] plaintext / key không lọt vào log hay message lỗi', () => {
  const KEY = newKey();
  const svc = service('v1', { v1: KEY });
  const KEY_HEX = Buffer.from(KEY, 'base64').toString('hex');
  const spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(jest.spyOn(console, method).mockImplementation(() => {}));
    }
    for (const method of [
      'log',
      'warn',
      'error',
      'debug',
      'verbose',
    ] as const) {
      spies.push(
        jest.spyOn(Logger.prototype, method).mockImplementation(() => {}),
      );
      spies.push(jest.spyOn(Logger, method).mockImplementation(() => {}));
    }
  });
  afterEach(() => {
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  it('mã hoá / giải mã / mọi nhánh lỗi không ghi log gì; lỗi không chứa plaintext, key, ciphertext', () => {
    const payload = svc.encrypt(CCCD, CTX);
    svc.decrypt(payload, CTX);

    const errors = [
      caught(() => svc.decrypt(tamper(payload, 5), CTX)),
      caught(() => svc.decrypt(tamper(payload, 4), CTX)),
      caught(() => service('v1', { v1: newKey() }).decrypt(payload, CTX)),
      caught(() => svc.decrypt(payload, 'hr.other.column')),
      caught(() => svc.decrypt(`${payload}:${CCCD}`, CTX)),
      caught(() => svc.decrypt(CCCD, CTX)),
      caught(() => svc.encrypt(`${CCCD}`.repeat(1000), CTX)),
      caught(() => svc.encrypt(CCCD, `bad ${CCCD}`)),
    ];

    const ciphertext = payload.split(':')[5];
    for (const e of errors) {
      const dump = `${e.message}\n${e.stack}\n${inspect(e)}`;
      for (const secret of [CCCD, KEY, KEY_HEX, ciphertext]) {
        expect(dump).not.toContain(secret);
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('inspect service không lộ key', () => {
    const dump = inspect(svc, { depth: 10, showHidden: true });
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(KEY_HEX);
  });
});
