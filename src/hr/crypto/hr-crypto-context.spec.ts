import { randomBytes } from 'crypto';
import { HrBlindIndexService } from './hr-blind-index.service';
import {
  blindIndexContext,
  employeeFieldContext,
  HrBlindIndexDomain,
  HrEncryptedField,
} from './hr-crypto-context';
import { HrEncryptionService } from './hr-encryption.service';
import { loadHrKeyring } from './hr-keyring';

const newKey = () => randomBytes(32).toString('base64');
const CCCD = '079201001234';
const { IDENTITY_NUMBER, BANK_ACCOUNT_NUMBER } = HrEncryptedField;

function encryption(active: string, keys: Record<string, string>) {
  const env: Record<string, string> = {
    HR_ENCRYPTION_ACTIVE_KEY_VERSION: active,
  };
  for (const [v, k] of Object.entries(keys))
    env[`HR_ENCRYPTION_KEY_${v.toUpperCase()}`] = k;
  return new HrEncryptionService(loadHrKeyring(env, 'encryption'));
}

function decryptCode(svc: HrEncryptionService, payload: string, ctx: string) {
  try {
    svc.decrypt(payload, ctx);
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('Context chuẩn', () => {
  it('format cố định: hr:v1:employee:<id>:<field> và hr:v1:bi:<domain>', () => {
    expect(employeeFieldContext(123, IDENTITY_NUMBER)).toBe(
      'hr:v1:employee:123:identity_number',
    );
    expect(blindIndexContext(HrBlindIndexDomain.NATIONAL_ID)).toBe(
      'hr:v1:bi:national_id',
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'employeeId không hợp lệ (%p) → lỗi',
    (id) => {
      expect(() => employeeFieldContext(id, IDENTITY_NUMBER)).toThrow();
    },
  );

  it('field / domain ngoài danh mục → lỗi', () => {
    expect(() =>
      employeeFieldContext(1, 'salary' as HrEncryptedField),
    ).toThrow();
    expect(() => blindIndexContext('cccd' as HrBlindIndexDomain)).toThrow();
  });
});

describe('[22] Ciphertext gắn đúng nhân viên + field', () => {
  const V1 = newKey();
  const svc = encryption('v1', { v1: V1 });
  const ctxA = employeeFieldContext(101, IDENTITY_NUMBER);
  const payloadA = svc.encrypt(CCCD, ctxA);

  it('[22.1] mã hoá CCCD nhân viên A → giải mã cho A được', () => {
    expect(svc.decrypt(payloadA, ctxA)).toBe(CCCD);
  });

  it('[22.2] chép ciphertext của A sang nhân viên B → xác thực thất bại', () => {
    expect(
      decryptCode(svc, payloadA, employeeFieldContext(102, IDENTITY_NUMBER)),
    ).toBe('DECRYPTION_FAILED');
  });

  it('[22.3] chép ciphertext CCCD sang cột số tài khoản cùng nhân viên → thất bại', () => {
    expect(
      decryptCode(
        svc,
        payloadA,
        employeeFieldContext(101, BANK_ACCOUNT_NUMBER),
      ),
    ).toBe('DECRYPTION_FAILED');
  });

  it('[22.4] không có companyId trong context (một công ty, id nhân viên duy nhất toàn cục)', () => {
    expect(ctxA).not.toMatch(/company/);
  });

  it('[22.5] re-encrypt sang khoá mới giữ nguyên context → vẫn giải mã đúng, và vẫn gắn A', () => {
    const rotated = encryption('v2', { v1: V1, v2: newKey() });
    const migrated = rotated.reEncrypt(payloadA, ctxA);
    expect(rotated.keyVersionOf(migrated)).toBe('v2');
    expect(rotated.decrypt(migrated, ctxA)).toBe(CCCD);
    expect(
      decryptCode(
        rotated,
        migrated,
        employeeFieldContext(102, IDENTITY_NUMBER),
      ),
    ).toBe('DECRYPTION_FAILED');
  });
});

describe('Blind index — tách miền', () => {
  const env = { HR_HMAC_ACTIVE_KEY_VERSION: 'v1', HR_HMAC_KEY_V1: newKey() };
  const bi = new HrBlindIndexService(loadHrKeyring(env, 'hmac'));
  const digits = '0123456789';

  it('cùng dãy số ở CCCD / MST / BHXH / số tài khoản → 4 hash khác nhau', () => {
    const hashes = [
      HrBlindIndexDomain.NATIONAL_ID,
      HrBlindIndexDomain.TAX_NUMBER,
      HrBlindIndexDomain.SOCIAL_INSURANCE_NUMBER,
      HrBlindIndexDomain.BANK_ACCOUNT,
    ].map((d) => bi.hash(digits, blindIndexContext(d)));
    expect(new Set(hashes).size).toBe(4);
  });

  it('blind index KHÔNG gắn nhân viên: cùng số ở 2 người → cùng hash (để phát hiện trùng)', () => {
    const ctx = blindIndexContext(HrBlindIndexDomain.NATIONAL_ID);
    expect(bi.hash(CCCD, ctx)).toBe(bi.hash(CCCD, ctx));
  });
});
