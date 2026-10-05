import { BadRequestException } from '@nestjs/common';
import { maskSensitive, REDACTED } from '../common/sensitive-mask';
import { HrBlindIndexDomain } from '../crypto/hr-crypto-context';
import {
  HrIdentifierKind,
  maskedFromLast4,
  prepareIdentifier,
} from './hr-sensitive-identifiers';

function error(kind: HrIdentifierKind, raw: unknown) {
  try {
    prepareIdentifier(kind, raw, 'number');
  } catch (err) {
    return err as BadRequestException;
  }
  throw new Error('Mong đợi lỗi');
}

describe('prepareIdentifier', () => {
  it.each<[HrIdentifierKind, string, string]>([
    ['CCCD', '0792 0100 1234', '079201001234'],
    ['CMND', '024 567 891', '024567891'],
    ['PASSPORT', 'c1234567', 'C1234567'],
    ['WORK_PERMIT', 'gp-123-456', 'GP123456'],
    ['TAX_NUMBER', '0312345678-001', '0312345678001'],
    ['TAX_NUMBER', '079201001234', '079201001234'],
    ['SOCIAL_INSURANCE_NUMBER', '79 2010 0123', '7920100123'],
    ['BANK_ACCOUNT', '0071 0001 23456', '0071000123456'],
  ])('%s: "%s" → %s', (kind, raw, value) => {
    const p = prepareIdentifier(kind, raw, 'number');
    expect(p.value).toBe(value);
    expect(p.last4).toBe(value.slice(-4));
  });

  it.each<[HrIdentifierKind, string]>([
    ['CCCD', '07920100123'],
    ['CCCD', '0792010012345'],
    ['CCCD', 'A79201001234'],
    ['CMND', '1234567890'],
    ['TAX_NUMBER', '123456789'],
    ['SOCIAL_INSURANCE_NUMBER', '123456789'],
    ['BANK_ACCOUNT', '12345'],
    ['PASSPORT', 'ABC'],
  ])('%s sai định dạng "%s" → 400, message KHÔNG chứa giá trị', (kind, raw) => {
    const e = error(kind, raw);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toMatchObject({ code: 'HR_IDENTIFIER_INVALID' });
    expect(JSON.stringify(e.getResponse())).not.toContain(raw);
  });

  it('không phải chuỗi / rỗng → 400', () => {
    expect(error('CCCD', 123)).toBeInstanceOf(BadRequestException);
    expect(error('CCCD', '')).toBeInstanceOf(BadRequestException);
    expect(error('CCCD', '   ')).toBeInstanceOf(BadRequestException);
  });

  it('CCCD và CMND dùng chung miền blind index; MST tách miền', () => {
    expect(prepareIdentifier('CCCD', '079201001234', 'n').domain).toBe(
      HrBlindIndexDomain.NATIONAL_ID,
    );
    expect(prepareIdentifier('CMND', '079201001234', 'n').domain).toBe(
      HrBlindIndexDomain.NATIONAL_ID,
    );
    expect(prepareIdentifier('TAX_NUMBER', '079201001234', 'n').domain).toBe(
      HrBlindIndexDomain.TAX_NUMBER,
    );
  });

  it('dạng che dựng từ last4, không cần giải mã', () => {
    expect(maskedFromLast4('1234')).toBe('********1234');
    expect(maskedFromLast4(null)).toBeNull();
  });
});

describe('[20.6/20.7] audit không chứa ciphertext / blind index', () => {
  it('maskSensitive che giá trị hrenc: / hbi: bất kể tên field', () => {
    const masked = maskSensitive({
      note: 'hrenc:1:v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:CCCC',
      nested: {
        anything: 'hbi:1:v1:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      },
      list: ['hbi:1:v2:x'],
      numberMasked: '********1234',
    });
    expect(masked).toEqual({
      note: REDACTED,
      nested: { anything: REDACTED },
      list: [REDACTED],
      numberMasked: '********1234',
    });
  });
});
