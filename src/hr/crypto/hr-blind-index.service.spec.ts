import { createHash, randomBytes } from 'crypto';
import { HrCryptoError } from './hr-crypto.errors';
import {
  HrBlindIndexService,
  normalizeIdentifier,
} from './hr-blind-index.service';
import { loadHrKeyring } from './hr-keyring';

const newKey = () => randomBytes(32).toString('base64');
const CCCD_CTX = 'hr.employee_identity.identity_number';
const TAX_CTX = 'hr.employee_tax.tax_code';

function service(active: string, keys: Record<string, string>) {
  const env: Record<string, string> = { HR_HMAC_ACTIVE_KEY_VERSION: active };
  for (const [v, key] of Object.entries(keys)) {
    env[`HR_HMAC_KEY_${v.toUpperCase()}`] = key;
  }
  return new HrBlindIndexService(loadHrKeyring(env, 'hmac'));
}

describe('normalizeIdentifier', () => {
  it.each([
    ['0792 0100 1234', '079201001234'],
    ['0123456789-001', '0123456789001'],
    ['  ab.cd-12 ', 'ABCD12'],
    ['０７９２', '0792'], // số full-width → NFKC
  ])('%s → %s', (input, expected) => {
    expect(normalizeIdentifier(input)).toBe(expected);
  });
});

describe('HrBlindIndexService', () => {
  const V1 = newKey();
  const svc = service('v1', { v1: V1 });

  it('ổn định: cùng giá trị (sau chuẩn hoá) → cùng hash', () => {
    const a = svc.hash('079201001234', CCCD_CTX);
    expect(a).toMatch(/^hbi:1:v1:[\w-]{43}$/);
    expect(svc.hash('0792 0100-1234', CCCD_CTX)).toBe(a);
    expect(a).not.toContain('079201001234');
  });

  it('không phải SHA-256 thuần — không có key thì không tính lại được', () => {
    const plain = createHash('sha256')
      .update('079201001234')
      .digest('base64url');
    expect(svc.hash('079201001234', CCCD_CTX)).not.toContain(plain);
    expect(
      service('v1', { v1: newKey() }).hash('079201001234', CCCD_CTX),
    ).not.toBe(svc.hash('079201001234', CCCD_CTX));
  });

  it('tách miền theo context: cùng dãy số ở CCCD và MST → hash khác', () => {
    expect(svc.hash('0123456789', CCCD_CTX)).not.toBe(
      svc.hash('0123456789', TAX_CTX),
    );
  });

  it('rotation: ghi bằng active, tra cứu bằng mọi version', () => {
    const rotated = service('v2', { v1: V1, v2: newKey() });
    const oldHash = svc.hash('079201001234', CCCD_CTX);
    const newHash = rotated.hash('079201001234', CCCD_CTX);
    expect(newHash.startsWith('hbi:1:v2:')).toBe(true);
    expect(rotated.candidates('079201001234', CCCD_CTX)).toEqual([
      oldHash,
      newHash,
    ]);
  });

  it('null → null; rỗng / chỉ ký tự phân cách → từ chối', () => {
    expect(svc.hashNullable(null, CCCD_CTX)).toBeNull();
    expect(svc.hashNullable(undefined, CCCD_CTX)).toBeNull();
    for (const empty of ['', '   ', ' - . ']) {
      expect(() => svc.hash(empty, CCCD_CTX)).toThrow(HrCryptoError);
    }
  });

  it('context sai định dạng → INVALID_CONTEXT', () => {
    expect(() => svc.hash('1', 'cccd')).toThrow('[INVALID_CONTEXT]');
  });
});
