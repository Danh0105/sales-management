import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { EMPLOYEE_CODE_PATTERN, formatEmployeeCode } from './hr-employee-code';
import { CreateHrEmployeeDto } from './dto/create-hr-employee.dto';

describe('Mã nhân viên tự sinh (NV + 6 số)', () => {
  it.each([
    [1, 'NV000001'],
    [42, 'NV000042'],
    [123456, 'NV123456'],
    [999999, 'NV999999'],
  ])('%i → %s', (n, code) => {
    expect(formatEmployeeCode(n)).toBe(code);
    expect(code).toMatch(EMPLOYEE_CODE_PATTERN);
  });

  it.each([0, -1, 1_000_000, 1.5, Number.NaN])(
    'số ngoài khoảng / không nguyên (%p) → lỗi',
    (n) => {
      expect(() => formatEmployeeCode(n)).toThrow();
    },
  );

  it('khớp CHECK của cột employee_code trong DB', () => {
    expect(formatEmployeeCode(7)).toMatch(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
  });

  it('client gửi employeeCode → 400 (mã chỉ do hệ thống sinh)', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const meta = { type: 'body' as const, metatype: CreateHrEmployeeDto };
    await expect(
      pipe.transform(
        { fullName: 'Nguyễn Văn A', employeeCode: 'NV000001' },
        meta,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform({ fullName: 'Nguyễn Văn A' }, meta),
    ).resolves.toMatchObject({ fullName: 'Nguyễn Văn A' });
  });
});
