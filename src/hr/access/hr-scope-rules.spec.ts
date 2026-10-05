import { HrScope } from './hr-permission';
import { scopeCovers, scopeRefError } from './hr-scope-rules';

const s = (scope: HrScope, scopeRefId: number | null = null) => ({
  scope,
  scopeRefId,
});
const { SELF, TEAM, ORG_UNIT, BRANCH, COMPANY, ALL } = HrScope;

describe('scopeRefError', () => {
  it.each([
    [SELF, undefined],
    [TEAM, null],
    [COMPANY, undefined],
    [ALL, undefined],
    [ORG_UNIT, 5],
    [BRANCH, 1],
  ])('hợp lệ: %s + %s', (scope, ref) => {
    expect(scopeRefError(scope, ref)).toBeNull();
  });

  it.each([
    [ORG_UNIT, undefined, 'bắt buộc có scopeRefId'],
    [BRANCH, null, 'bắt buộc có scopeRefId'],
    [COMPANY, 3, 'không dùng scopeRefId'],
    [SELF, 1, 'không dùng scopeRefId'],
    [ORG_UNIT, 0, 'số nguyên dương'],
    [BRANCH, 1.5, 'số nguyên dương'],
  ])('sai: %s + %s', (scope, ref, message) => {
    expect(scopeRefError(scope, ref)).toContain(message);
  });
});

describe('scopeCovers', () => {
  it('ALL bao trùm mọi scope', () => {
    for (const scope of Object.values(HrScope)) {
      expect(
        scopeCovers(
          s(ALL),
          s(scope, scope === ORG_UNIT || scope === BRANCH ? 1 : null),
        ),
      ).toBe(true);
    }
  });

  it('COMPANY bao trùm mọi scope trừ ALL', () => {
    expect(scopeCovers(s(COMPANY), s(ALL))).toBe(false);
    expect(scopeCovers(s(COMPANY), s(COMPANY))).toBe(true);
    expect(scopeCovers(s(COMPANY), s(BRANCH, 2))).toBe(true);
    expect(scopeCovers(s(COMPANY), s(SELF))).toBe(true);
  });

  it('scope hẹp không cấp được scope rộng hơn', () => {
    expect(scopeCovers(s(BRANCH, 2), s(COMPANY))).toBe(false);
    expect(scopeCovers(s(TEAM), s(ORG_UNIT, 1))).toBe(false);
  });

  it('cùng loại nhưng khác đơn vị → không bao trùm', () => {
    expect(scopeCovers(s(ORG_UNIT, 1), s(ORG_UNIT, 2))).toBe(false);
    expect(scopeCovers(s(ORG_UNIT, 1), s(ORG_UNIT, 1))).toBe(true);
  });
});
