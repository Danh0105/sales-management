import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateHrEmployeeDto,
  ListHrEmployeesQuery,
  UpdateHrEmployeeDto,
} from './dto/create-hr-employee.dto';
import {
  buildSearchTerms,
  escapeLike,
  isValidDateOfBirth,
  maskEmail,
  maskPhone,
  normalizeProfilePhone,
  normalizeVietnameseName,
  phoneVariants,
} from './hr-employee-profile';
import { auditProfileValues, employeeViewFilter } from './hr-employee.service';
import { HrPermission, HrScope } from '../access/hr-permission';
import type { HrGrant } from '../access/hr-access.service';
import { nameSearchCorpus, vietnameseLetters } from './name-search-corpus';

describe('normalizeVietnameseName — hợp đồng v1', () => {
  it('toàn bộ nguyên âm tiếng Việt × 6 thanh × hoa/thường + Đ/đ', () => {
    const letters = vietnameseLetters();
    expect(letters).toHaveLength(12 * 6 * 2 + 2);
    for (const { input, expected } of letters) {
      expect([input, normalizeVietnameseName(input)]).toEqual([
        input,
        expected,
      ]);
    }
  });

  it('các chữ liệt kê tường minh', () => {
    const groups: [string, string][] = [
      ['ăâđêôơư', 'aadeoou'],
      ['ÁÀẢÃẠ', 'aaaaa'],
      ['ẮẰẲẴẶ', 'aaaaa'],
      ['ẤẦẨẪẬ', 'aaaaa'],
      ['ÉÈẺẼẸ ẾỀỂỄỆ', 'eeeee eeeee'],
      ['ÍÌỈĨỊ', 'iiiii'],
      ['ÓÒỎÕỌ ỐỒỔỖỘ ỚỜỞỠỢ', 'ooooo ooooo ooooo'],
      ['ÚÙỦŨỤ ỨỪỬỮỰ', 'uuuuu uuuuu'],
      ['ÝỲỶỸỴ', 'yyyyy'],
    ];
    for (const [input, expected] of groups)
      expect(normalizeVietnameseName(input)).toBe(expected);
  });

  it('Nguyễn Đặng Hồng Ân → nguyen dang hong an (NFC và NFD như nhau)', () => {
    const name = 'Nguyễn Đặng Hồng Ân';
    expect(normalizeVietnameseName(name.normalize('NFC'))).toBe(
      'nguyen dang hong an',
    );
    expect(normalizeVietnameseName(name.normalize('NFD'))).toBe(
      'nguyen dang hong an',
    );
    expect(name.normalize('NFD')).not.toBe(name.normalize('NFC'));
  });

  it('toàn bộ bộ đối chiếu (NFC + NFD, khoảng trắng Unicode)', () => {
    for (const { input, expected } of nameSearchCorpus())
      expect(normalizeVietnameseName(input)).toBe(expected);
  });

  it('không phụ thuộc locale: chỉ A–Z được hạ chữ thường', () => {
    // Ký tự ngoài bảng (vd. Ω) giữ nguyên — SQL translate() cũng vậy.
    expect(normalizeVietnameseName('ΩMEGA')).toBe('Ωmega');
  });
});

describe('tìm kiếm', () => {
  it('"Đặng" tìm bằng "dang"; "Nguyễn" tìm bằng "nguyen"', () => {
    expect(normalizeVietnameseName('Đặng')).toBe('dang');
    expect(normalizeVietnameseName('Nguyễn')).toBe('nguyen');
    expect(buildSearchTerms('Đặng').nameContains).toBe('dang');
    expect(
      normalizeVietnameseName('Nguyễn Văn A').includes(
        buildSearchTerms('nguyen van').nameContains!,
      ),
    ).toBe(true);
  });

  it('mã NV: tiền tố, không phân biệt hoa thường', () => {
    expect(buildSearchTerms('nv0001').codePrefix).toBe('NV0001');
    expect(buildSearchTerms('nguyen van').codePrefix).toBeNull();
  });

  it('SĐT: bỏ khoảng trắng/chấm/gạch nối; chữ không phải SĐT', () => {
    expect(buildSearchTerms('0912.345-678').phoneContains).toBe('0912345678');
    expect(buildSearchTerms('+84 912').phoneContains).toBe('+84912');
    expect(buildSearchTerms('nguyen').phoneContains).toBeNull();
    expect(buildSearchTerms('12').phoneContains).toBeNull();
  });

  it('email: chữ thường; có khoảng trắng thì không xét email', () => {
    expect(buildSearchTerms('Lan@KIDO.vn').emailContains).toBe('lan@kido.vn');
    expect(buildSearchTerms('nguyen van').emailContains).toBeNull();
  });

  it('chuỗi rỗng → không điều kiện nào', () => {
    expect(buildSearchTerms('   ')).toEqual({
      codePrefix: null,
      nameContains: null,
      phoneContains: null,
      emailContains: null,
    });
  });

  it('thoát ký tự LIKE', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});

describe('liên hệ & ngày sinh', () => {
  it('chuẩn hoá SĐT không đổi đầu số', () => {
    expect(normalizeProfilePhone('+84 912.345-678')).toBe('+84912345678');
    expect(normalizeProfilePhone('0912 345 678')).toBe('0912345678');
  });

  it('biến thể +84 ↔ 0 chỉ để cảnh báo trùng', () => {
    expect(phoneVariants('0912345678')).toEqual(['0912345678', '+84912345678']);
    expect(phoneVariants('+84912345678')).toEqual([
      '+84912345678',
      '0912345678',
    ]);
  });

  it('ngày sinh: ngày có thật, 1900 → hôm nay', () => {
    expect(isValidDateOfBirth('1990-05-17', '2026-09-30')).toBe(true);
    expect(isValidDateOfBirth('2026-02-30', '2026-09-30')).toBe(false);
    expect(isValidDateOfBirth('2026-10-01', '2026-09-30')).toBe(false);
    expect(isValidDateOfBirth('1899-12-31', '2026-09-30')).toBe(false);
    expect(isValidDateOfBirth('17/05/1990', '2026-09-30')).toBe(false);
  });
});

describe('audit', () => {
  it('che SĐT/email, không có ngày sinh và fullNameSearch', () => {
    const out = auditProfileValues({
      fullName: 'Nguyễn Văn A',
      attendanceMode: 'SHIFT',
      gender: 'MALE',
      phone: '0912345678',
      workEmail: 'nguyen.a@kido.vn',
      personalEmail: 'a.nguyen@gmail.com',
      dateOfBirth: '1990-05-17',
      fullNameSearch: 'nguyen van a',
    } as Parameters<typeof auditProfileValues>[0]);
    expect(out).toEqual({
      fullName: 'Nguyễn Văn A',
      attendanceMode: 'SHIFT',
      gender: 'MALE',
      phone: '*******678',
      workEmail: 'n***@kido.vn',
      personalEmail: 'a***@gmail.com',
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain('1990');
    expect(json).not.toContain('0912345678');
    expect(json).not.toContain('nguyen van a');
  });

  it('mask null giữ null', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskEmail(null)).toBeNull();
  });
});

describe('phạm vi xem', () => {
  const grant = (scope: HrScope, permission = HrPermission.EMPLOYEE_VIEW) =>
    ({ permission, scope, scopeRefId: null }) as HrGrant;

  it('COMPANY → tất cả; SELF → hồ sơ của mình; BRANCH (chưa có 1.4) → không ai', () => {
    expect(employeeViewFilter(7, [grant(HrScope.COMPANY)])).toEqual({
      kind: 'ALL',
    });
    expect(employeeViewFilter(7, [grant(HrScope.SELF)])).toEqual({
      kind: 'SELF',
      accountId: 7,
    });
    expect(employeeViewFilter(7, [grant(HrScope.BRANCH)])).toEqual({
      kind: 'NONE',
    });
    expect(
      employeeViewFilter(7, [
        grant(HrScope.COMPANY, HrPermission.EMPLOYEE_EDIT),
      ]),
    ).toEqual({ kind: 'NONE' });
  });
});

describe('DTO', () => {
  const errors = (cls: new () => object, body: object) =>
    validateSync(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).map((e) => e.property);

  it('attendanceMode: SHIFT, TEACHING_SESSION, UNASSIGNED hợp lệ; giá trị khác bị từ chối', () => {
    for (const mode of ['SHIFT', 'TEACHING_SESSION', 'UNASSIGNED'])
      expect(
        errors(CreateHrEmployeeDto, { fullName: 'A', attendanceMode: mode }),
      ).toEqual([]);
    expect(
      errors(CreateHrEmployeeDto, { fullName: 'A', attendanceMode: 'OFFICE' }),
    ).toEqual(['attendanceMode']);
  });

  it('client gửi fullNameSearch / employeeCode → bị từ chối', () => {
    expect(
      errors(CreateHrEmployeeDto, { fullName: 'A', fullNameSearch: 'x' }),
    ).toEqual(['fullNameSearch']);
    expect(
      errors(UpdateHrEmployeeDto, { version: 1, fullNameSearch: 'x' }),
    ).toEqual(['fullNameSearch']);
    expect(
      errors(UpdateHrEmployeeDto, { version: 1, employeeCode: 'NV000001' }),
    ).toEqual(['employeeCode']);
    expect(errors(UpdateHrEmployeeDto, { version: 1, accountId: 3 })).toEqual([
      'accountId',
    ]);
  });

  it('PATCH bắt buộc version', () => {
    expect(errors(UpdateHrEmployeeDto, { fullName: 'B' })).toEqual(['version']);
  });

  it('SĐT/email được chuẩn hoá trước khi kiểm tra', () => {
    const dto = plainToInstance(CreateHrEmployeeDto, {
      fullName: 'A',
      phone: '0912 345.678',
      workEmail: ' Lan@KIDO.vn ',
      personalEmail: '',
    });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.phone).toBe('0912345678');
    expect(dto.workEmail).toBe('lan@kido.vn');
    expect(dto.personalEmail).toBeNull();
    expect(
      errors(CreateHrEmployeeDto, { fullName: 'A', phone: '12ab' }),
    ).toEqual(['phone']);
    expect(
      errors(CreateHrEmployeeDto, { fullName: 'A', workEmail: 'khong-hop-le' }),
    ).toEqual(['workEmail']);
  });

  it('gender và q', () => {
    expect(errors(CreateHrEmployeeDto, { fullName: 'A', gender: 'X' })).toEqual(
      ['gender'],
    );
    expect(errors(ListHrEmployeesQuery, { q: 'x'.repeat(101) })).toEqual(['q']);
    expect(
      errors(ListHrEmployeesQuery, {
        attendanceMode: 'UNASSIGNED',
        limit: '20',
      }),
    ).toEqual([]);
  });
});
