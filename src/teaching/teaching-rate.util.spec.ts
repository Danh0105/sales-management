import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTeacherDto } from './dto/teacher.dto';
import { effectiveRatePerPeriod } from './teaching-rate.util';

describe('teacher default rate', () => {
  it.each([
    [150_000, false, 150_000],
    // Chưa khai đơn giá => null, KHÔNG rơi về đơn giá môn học nữa.
    [null, false, null],
    [0, false, 0],
    [150_000, true, null],
  ])('teacher=%s company=%s => %s', (teacherRate, company, expected) => {
    expect(
      effectiveRatePerPeriod({ defaultRatePerPeriod: teacherRate }, company),
    ).toBe(expected);
  });

  it.each([-1, 100_000_001, 1.234])('rejects invalid rate %s', async (rate) => {
    const dto = plainToInstance(CreateTeacherDto, {
      name: 'Nguyen Van A',
      phone: '0901234567',
      email: 'teacher@example.com',
      defaultRatePerPeriod: rate,
    });
    const errors = await validate(dto);
    expect(
      errors.some((error) => error.property === 'defaultRatePerPeriod'),
    ).toBe(true);
  });

  it.each([null, 0, 150_000, 123.45])('accepts valid rate %s', async (rate) => {
    const dto = plainToInstance(CreateTeacherDto, {
      name: 'Nguyen Van A',
      phone: '0901234567',
      email: 'teacher@example.com',
      defaultRatePerPeriod: rate,
    });
    const errors = await validate(dto);
    expect(
      errors.find((error) => error.property === 'defaultRatePerPeriod'),
    ).toBeUndefined();
  });
});
