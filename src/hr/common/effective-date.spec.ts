import { assertIsoDate, hrToday, isEffectiveOn } from './effective-date';

describe('effective-date', () => {
  it('hrToday tính theo giờ Việt Nam, không theo giờ server', () => {
    // 2026-09-24T18:30Z = 01:30 ngày 25/09 ở Việt Nam.
    expect(hrToday(new Date('2026-09-24T18:30:00Z'))).toBe('2026-09-25');
    expect(hrToday(new Date('2026-09-24T16:59:00Z'))).toBe('2026-09-24');
  });

  it.each([
    ['2026-01-01', null, '2026-09-25', true],
    ['2026-01-01', '2026-09-30', '2026-09-30', true],
    ['2026-01-01', '2026-09-30', '2026-10-01', false],
    ['2026-10-01', null, '2026-09-30', false],
  ])('from %s to %s on %s → %s', (from, to, on, expected) => {
    expect(isEffectiveOn(from, to, on)).toBe(expected);
  });

  it('assertIsoDate từ chối dạng sai', () => {
    expect(() => assertIsoDate('25/09/2026')).toThrow('YYYY-MM-DD');
    expect(() => assertIsoDate('2026-13-45')).toThrow();
    expect(() => assertIsoDate('2026-09-25')).not.toThrow();
  });
});
