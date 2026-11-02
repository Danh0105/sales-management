import { HrGrant } from '../access/hr-access.service';
import { HrPermission, HrScope } from '../access/hr-permission';
import { hrToday } from '../common/effective-date';
import {
  addDays,
  grantScopeCovers,
  inclusiveDays,
  isSensitiveAccess,
  latestSensitiveEffectiveTo,
  MAX_SENSITIVE_ACCESS_DAYS,
  periodCovers,
  SENSITIVE_ACCESS_PERMISSIONS,
  sensitiveDurationError,
  uncoveredPermissions,
} from './hr-grant-policy';

const MAX = MAX_SENSITIVE_ACCESS_DAYS;
const s = (scope: HrScope, scopeRefId: number | null = null) => ({
  scope,
  scopeRefId,
});
const { SELF, TEAM, ORG_UNIT, BRANCH, COMPANY, ALL } = HrScope;

describe('M2 — danh sách tập trung', () => {
  it('quyền nhạy cảm gồm lương, CCCD, ngân hàng, giấy khám sức khỏe (1.3); KHÔNG gồm ACCESS_ADMIN', () => {
    expect([...SENSITIVE_ACCESS_PERMISSIONS].sort()).toEqual(
      [
        'BANK_REVEAL',
        'IDENTITY_REVEAL',
        'SALARY_VIEW',
        'HEALTH_DOCUMENT_VIEW',
      ].sort(),
    );
    expect(SENSITIVE_ACCESS_PERMISSIONS).not.toContain(
      HrPermission.DOCUMENT_VIEW,
    );
    expect(SENSITIVE_ACCESS_PERMISSIONS).not.toContain(
      HrPermission.ACCESS_ADMIN,
    );
  });

  it('isSensitiveAccess: chỉ cần một quyền nhạy cảm', () => {
    expect(isSensitiveAccess(['EMPLOYEE_VIEW', 'SALARY_VIEW'])).toBe(true);
    expect(isSensitiveAccess(['ACCESS_ADMIN', 'ACCESS_VIEW'])).toBe(false);
    expect(isSensitiveAccess([])).toBe(false);
  });
});

describe('M2 — MAX ngày lịch TÍNH CẢ HAI ĐẦU', () => {
  it('ví dụ nghiệp vụ: from 2026-01-01 → effectiveTo muộn nhất 2026-06-29 = đúng MAX ngày', () => {
    expect(latestSensitiveEffectiveTo('2026-01-01')).toBe('2026-06-29');
    expect(inclusiveDays('2026-01-01', '2026-06-29')).toBe(MAX);
  });

  it('[9] offset MAX−1 (= MAX ngày có quyền) → hợp lệ', () => {
    const from = '2026-09-25';
    const to = addDays(from, MAX - 1);
    expect(inclusiveDays(from, to)).toBe(MAX);
    expect(sensitiveDurationError(from, to)).toBeNull();
  });

  it('[10] offset MAX (= MAX+1 ngày có quyền) → lỗi', () => {
    const from = '2026-09-25';
    const to = addDays(from, MAX);
    expect(inclusiveDays(from, to)).toBe(MAX + 1);
    expect(sensitiveDurationError(from, to)).toContain('cannot exceed');
  });

  it('thiếu effectiveTo → lỗi; from = to (1 ngày) → hợp lệ', () => {
    expect(sensitiveDurationError('2026-09-25', null)).toContain(
      'require effectiveTo',
    );
    expect(sensitiveDurationError('2026-09-25', '2026-09-25')).toBeNull();
    expect(inclusiveDays('2026-09-25', '2026-09-25')).toBe(1);
  });

  it.each([
    ['[11] qua năm nhuận (29/02/2028)', '2027-12-01'],
    ['[11] bắt đầu đúng 29/02', '2028-02-29'],
    ['cuối tháng', '2026-01-31'],
    ['cuối năm', '2026-12-31'],
  ])('%s: hạn tối đa luôn đúng MAX ngày tính cả hai đầu', (_label, from) => {
    const latest = latestSensitiveEffectiveTo(from);
    expect(inclusiveDays(from, latest)).toBe(MAX);
    expect(sensitiveDurationError(from, latest)).toBeNull();
    expect(sensitiveDurationError(from, addDays(latest, 1))).not.toBeNull();
  });

  it('[12] "hôm nay" theo giờ Việt Nam: 01:30 sáng 25/09 VN (= 18:30Z 24/09) là ngày 25', () => {
    const today = hrToday(new Date('2026-09-24T18:30:00Z'));
    expect(today).toBe('2026-09-25');
    const latest = latestSensitiveEffectiveTo(today);
    expect(inclusiveDays(today, latest)).toBe(MAX);
    // Lấy nhầm ngày UTC (24/09) làm mốc thì hạn tối đa sớm hơn đúng 1 ngày.
    expect(latestSensitiveEffectiveTo('2026-09-24')).toBe(addDays(latest, -1));
  });
});

describe('addDays — lịch UTC thuần', () => {
  it.each([
    ['2026-09-25', 100, '2027-01-03'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-12-31', 60, '2028-02-29'],
    ['2028-02-29', 1, '2028-03-01'],
    ['2026-01-31', 28, '2026-02-28'],
    ['2026-03-01', -1, '2026-02-28'],
  ])('%s + %i = %s', (from, days, expected) => {
    expect(addDays(from, days)).toBe(expected);
  });

  it('từ chối chuỗi ngày sai định dạng', () => {
    expect(() => addDays('25/09/2026', 1)).toThrow('Ngày không hợp lệ');
  });
});

describe('M1 — grantScopeCovers (tập con theo dữ liệu)', () => {
  it.each([
    ['ALL chứa ALL', s(ALL), s(ALL), true],
    ['ALL chứa BRANCH 3', s(ALL), s(BRANCH, 3), true],
    ['COMPANY chứa COMPANY', s(COMPANY), s(COMPANY), true],
    ['COMPANY không chứa ALL', s(COMPANY), s(ALL), false],
    ['COMPANY chứa ORG_UNIT 7', s(COMPANY), s(ORG_UNIT, 7), true],
    ['COMPANY chứa TEAM của người khác', s(COMPANY), s(TEAM), true],
    ['ORG_UNIT 7 chứa ORG_UNIT 7', s(ORG_UNIT, 7), s(ORG_UNIT, 7), true],
    ['ORG_UNIT 7 không chứa ORG_UNIT 8', s(ORG_UNIT, 7), s(ORG_UNIT, 8), false],
    ['ORG_UNIT 7 không chứa COMPANY', s(ORG_UNIT, 7), s(COMPANY), false],
    ['BRANCH 1 không chứa BRANCH 2', s(BRANCH, 1), s(BRANCH, 2), false],
    ['BRANCH 1 không chứa ORG_UNIT 1', s(BRANCH, 1), s(ORG_UNIT, 1), false],
    [
      'BRANCH không gắn đơn vị (director_la) không chứa gì',
      s(BRANCH),
      s(BRANCH, 1),
      false,
    ],
    ['TEAM không chứa TEAM của người khác', s(TEAM), s(TEAM), false],
    ['SELF không chứa SELF của người khác', s(SELF), s(SELF), false],
  ])('%s', (_label, held, requested, expected) => {
    expect(grantScopeCovers(held, requested)).toBe(expected);
  });
});

describe('M1 — periodCovers', () => {
  const p = (effectiveFrom: string | null, effectiveTo: string | null) => ({
    effectiveFrom,
    effectiveTo,
  });
  const t = (effectiveFrom: string, effectiveTo: string | null) => ({
    effectiveFrom,
    effectiveTo,
  });

  it.each([
    [
      'quyền vô thời hạn (role cũ) phủ mọi khoảng',
      p(null, null),
      t('2026-10-01', '2027-03-29'),
      true,
    ],
    [
      'quyền vô thời hạn phủ cả target vô thời hạn',
      p(null, null),
      t('2026-10-01', null),
      true,
    ],
    [
      'hết cùng ngày target hết → phủ (inclusive)',
      p('2026-01-01', '2026-10-25'),
      t('2026-09-25', '2026-10-25'),
      true,
    ],
    [
      'hết trước target 1 ngày → không phủ',
      p('2026-01-01', '2026-10-24'),
      t('2026-09-25', '2026-10-25'),
      false,
    ],
    [
      'có hạn không phủ được target vô thời hạn',
      p('2026-01-01', '2027-12-31'),
      t('2026-09-25', null),
      false,
    ],
    [
      'bắt đầu sau target → không phủ',
      p('2026-10-01', null),
      t('2026-09-25', '2026-10-25'),
      false,
    ],
    [
      'hết trước khi target BẮT ĐẦU → không phủ',
      p('2026-01-01', '2026-10-01'),
      t('2026-11-01', '2026-11-30'),
      false,
    ],
  ])('%s', (_label, held, target, expected) => {
    expect(periodCovers(held, target)).toBe(expected);
  });
});

describe('M1 — uncoveredPermissions (permission + scope + period)', () => {
  const g = (
    permission: HrPermission,
    scope: HrScope,
    ref: number | null = null,
    effectiveTo: string | null = null,
  ): HrGrant => ({
    permission,
    scope,
    scopeRefId: ref,
    source: effectiveTo ? 'assignment' : 'role',
    via: 'x',
    effectiveFrom: effectiveTo ? '2026-01-01' : null,
    effectiveTo,
  });
  const target = { effectiveFrom: '2026-09-25', effectiveTo: '2026-11-23' }; // 60 ngày

  it('thiếu quyền → NOT_HELD_AT_SCOPE', () => {
    expect(
      uncoveredPermissions(
        ['EMPLOYEE_VIEW', 'SALARY_VIEW'],
        [g(HrPermission.EMPLOYEE_VIEW, COMPANY)],
        s(COMPANY),
        target,
      ),
    ).toEqual([{ permission: 'SALARY_VIEW', reason: 'NOT_HELD_AT_SCOPE' }]);
  });

  it('có quyền ở phạm vi hẹp hơn → NOT_HELD_AT_SCOPE (dù thời hạn đủ)', () => {
    expect(
      uncoveredPermissions(
        ['SALARY_VIEW'],
        [g(HrPermission.SALARY_VIEW, BRANCH, 3, '2027-12-31')],
        s(COMPANY),
        target,
      ),
    ).toEqual([{ permission: 'SALARY_VIEW', reason: 'NOT_HELD_AT_SCOPE' }]);
  });

  it('đúng scope nhưng hết hạn trước → PERIOD_NOT_COVERED kèm hạn của người cấp', () => {
    expect(
      uncoveredPermissions(
        ['SALARY_VIEW'],
        [g(HrPermission.SALARY_VIEW, BRANCH, 3, '2026-10-24')],
        s(BRANCH, 3),
        target,
      ),
    ).toEqual([
      {
        permission: 'SALARY_VIEW',
        reason: 'PERIOD_NOT_COVERED',
        actorEffectiveTo: '2026-10-24',
      },
    ]);
  });

  it('[6] nhiều grant: BRANCH 3 hết 30 ngày + COMPANY hết 90 ngày → cấp BRANCH 3 60 ngày được (không lấy grant đầu tiên)', () => {
    expect(
      uncoveredPermissions(
        ['SALARY_VIEW'],
        [
          g(HrPermission.SALARY_VIEW, BRANCH, 3, addDays('2026-09-25', 29)),
          g(HrPermission.SALARY_VIEW, COMPANY, null, addDays('2026-09-25', 89)),
        ],
        s(BRANCH, 3),
        target,
      ),
    ).toEqual([]);
  });

  it('role rỗng → không thiếu gì', () => {
    expect(uncoveredPermissions([], [], s(COMPANY), target)).toEqual([]);
  });
});
