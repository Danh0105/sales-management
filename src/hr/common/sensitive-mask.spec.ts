import {
  MASKED,
  maskIdentifier,
  maskSensitive,
  REDACTED,
} from './sensitive-mask';

describe('sensitive-mask', () => {
  it('maskIdentifier giữ 4 ký tự cuối', () => {
    expect(maskIdentifier('079201001234')).toBe('********1234');
    expect(maskIdentifier(123456789)).toBe('********6789');
    expect(maskIdentifier('123')).toBe('***');
    expect(maskIdentifier(null)).toBeNull();
  });

  it('che CCCD, số tài khoản, BHXH theo tên field — không phân biệt kiểu đặt tên', () => {
    expect(
      maskSensitive({
        identityNumber: '079201001234',
        bank_account: '0011002233445',
        'insurance-number': '7912345678',
        CCCD: '001122334455',
        name: 'Nguyễn Văn A',
      }),
    ).toEqual({
      identityNumber: '********1234',
      bank_account: '********3445',
      'insurance-number': '********5678',
      CCCD: '********4455',
      name: 'Nguyễn Văn A',
    });
  });

  it('che toàn bộ số tiền lương (mọi field kết thúc bằng salary)', () => {
    expect(
      maskSensitive({
        salary: 15000000,
        baseSalary: 1,
        probationSalary: 2,
        note: 'x',
      }),
    ).toEqual({
      salary: MASKED,
      baseSalary: MASKED,
      probationSalary: MASKED,
      note: 'x',
    });
  });

  it('xoá hẳn bí mật hệ thống', () => {
    expect(maskSensitive({ password: 'abc', accessToken: 'jwt' })).toEqual({
      password: REDACTED,
      accessToken: REDACTED,
    });
  });

  it('đi sâu vào object lồng và mảng, không sửa object gốc', () => {
    const input = {
      employee: { profile: { identityNumber: '079201001234' } },
      accounts: [{ bankAccount: '9988776655' }],
    };
    const copy = JSON.parse(JSON.stringify(input));
    expect(maskSensitive(input)).toEqual({
      employee: { profile: { identityNumber: '********1234' } },
      accounts: [{ bankAccount: '********6655' }],
    });
    expect(input).toEqual(copy);
  });

  it('field nhạy cảm chứa object → che cả khối', () => {
    expect(
      maskSensitive({ bankAccount: { number: '123456789', bank: 'VCB' } }),
    ).toEqual({
      bankAccount: MASKED,
    });
  });

  it('giữ nguyên null/primitive/Date', () => {
    expect(maskSensitive(null)).toBeNull();
    expect(maskSensitive(5)).toBe(5);
    expect(maskSensitive({ salary: null })).toEqual({ salary: null });
    expect(maskSensitive(new Date('2026-09-25T00:00:00Z'))).toBe(
      '2026-09-25T00:00:00.000Z',
    );
  });
});
