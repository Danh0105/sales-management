import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTeacherDto } from './dto/teacher.dto';
import { effectiveRatePerPeriod } from './teaching-rate.util';

describe('teacher default rate', () => {
  it.each([
    [150_000, 100_000, false, 150_000],
    [null, 100_000, false, 100_000],
    [0, 100_000, false, 0],
    [null, null, false, null],
    [150_000, 100_000, true, null],
  ])(
    'teacher=%s subject=%s company=%s => %s',
    (teacherRate, subjectRate, company, expected) => {
      expect(
        effectiveRatePerPeriod(
          { defaultRatePerPeriod: teacherRate },
          subjectRate,
          company,
        ),
      ).toBe(expected);
    },
  );

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
