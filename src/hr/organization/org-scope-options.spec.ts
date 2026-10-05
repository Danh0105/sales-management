import type { HrGrant } from '../access/hr-access.service';
import { HrPermission, HrScope } from '../access/hr-permission';
import { isScopeUnitAllowed, scopeOptions } from './org-scope-options';
import { OrgNode, OrgSnapshot } from './org-tree';

const node = (
  id: number,
  unitType: OrgNode['unitType'],
  parentId: number | null,
  name: string,
  status: OrgNode['status'] = 'ACTIVE',
): OrgNode => ({
  id,
  code: `DV${String(id).padStart(4, '0')}`,
  revisionId: id,
  unitType,
  name,
  parentId,
  status,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
});

const snapshot = new OrgSnapshot('2026-10-01', [
  node(1, 'COMPANY', null, 'Công ty'),
  node(2, 'BRANCH', 1, 'Chi nhánh A'),
  node(3, 'BRANCH', 1, 'Chi nhánh B'),
  node(4, 'DEPARTMENT', 2, 'Phòng A1'),
  node(5, 'TEAM', 4, 'Nhóm A1-1'),
  node(6, 'DEPARTMENT', 3, 'Phòng B1'),
  node(7, 'BRANCH', 1, 'Chi nhánh đã đóng', 'INACTIVE'),
]);

const grant = (
  scope: HrScope,
  scopeRefId: number | null = null,
  permission = HrPermission.ACCESS_ADMIN,
): HrGrant => ({
  permission,
  scope,
  scopeRefId,
  source: 'account',
  via: 'test',
  effectiveFrom: null,
  effectiveTo: null,
});

const ids = (scopeType: 'BRANCH' | 'ORG_UNIT', grants: HrGrant[]) =>
  scopeOptions(snapshot, scopeType, grants).map((o) => o.id);

describe('scopeOptions — ô chọn phạm vi cho ACCESS_ADMIN', () => {
  it('COMPANY/ALL: mọi chi nhánh / phòng ban đang hoạt động, sắp theo đường dẫn', () => {
    expect(ids('BRANCH', [grant(HrScope.COMPANY)])).toEqual([2, 3]);
    expect(ids('ORG_UNIT', [grant(HrScope.ALL)])).toEqual([4, 5, 6]);
  });

  it('chỉ projection tối thiểu: id, mã, tên, loại, cha, đường dẫn — không lãnh đạo/nhân viên', () => {
    const [first] = scopeOptions(snapshot, 'ORG_UNIT', [
      grant(HrScope.COMPANY),
    ]);
    expect(first).toEqual({
      id: 4,
      code: 'DV0004',
      name: 'Phòng A1',
      unitType: 'DEPARTMENT',
      parentId: 2,
      path: 'Công ty > Chi nhánh A > Phòng A1',
    });
  });

  it('BRANCH A: chỉ thấy chi nhánh A, không thấy chi nhánh B; ORG_UNIT → không có (đúng luật M1 hiện tại)', () => {
    expect(ids('BRANCH', [grant(HrScope.BRANCH, 2)])).toEqual([2]);
    expect(ids('ORG_UNIT', [grant(HrScope.BRANCH, 2)])).toEqual([]);
  });

  it('ORG_UNIT phòng A1: chỉ đúng phòng A1', () => {
    expect(ids('ORG_UNIT', [grant(HrScope.ORG_UNIT, 4)])).toEqual([4]);
    expect(ids('BRANCH', [grant(HrScope.ORG_UNIT, 4)])).toEqual([]);
  });

  it('SELF/TEAM hoặc BRANCH/ORG_UNIT không gắn đơn vị → không có lựa chọn', () => {
    for (const g of [
      grant(HrScope.SELF),
      grant(HrScope.TEAM),
      grant(HrScope.BRANCH, null),
    ]) {
      expect(ids('BRANCH', [g])).toEqual([]);
      expect(ids('ORG_UNIT', [g])).toEqual([]);
    }
  });

  it('chỉ xét grant ACCESS_ADMIN (quyền khác ở COMPANY không mở rộng danh sách)', () => {
    expect(
      ids('BRANCH', [
        grant(HrScope.BRANCH, 2),
        grant(HrScope.COMPANY, null, HrPermission.EMPLOYEE_VIEW),
      ]),
    ).toEqual([2]);
  });
});

describe('isScopeUnitAllowed — một nguồn sự thật cho ô chọn và kiểm tra khi cấp quyền', () => {
  it.each([
    ['BRANCH', 'BRANCH', 'ACTIVE', true],
    ['BRANCH', 'DEPARTMENT', 'ACTIVE', false],
    ['BRANCH', 'BRANCH', 'INACTIVE', false],
    ['ORG_UNIT', 'DEPARTMENT', 'ACTIVE', true],
    ['ORG_UNIT', 'TEAM', 'ACTIVE', true],
    ['ORG_UNIT', 'BRANCH', 'ACTIVE', false],
    ['ORG_UNIT', 'COMPANY', 'ACTIVE', false],
    ['ORG_UNIT', 'TEAM', 'INACTIVE', false],
  ] as const)('%s + %s (%s) → %s', (scope, unitType, status, expected) => {
    expect(isScopeUnitAllowed({ unitType, status }, scope)).toBe(expected);
  });

  it('không tồn tại / chưa có revision hiệu lực (null) → false', () => {
    expect(isScopeUnitAllowed(null, 'BRANCH')).toBe(false);
    expect(isScopeUnitAllowed(undefined, 'ORG_UNIT')).toBe(false);
  });

  it('scopeOptions dùng đúng luật này (không có đơn vị INACTIVE / sai loại)', () => {
    const all = scopeOptions(snapshot, 'BRANCH', [grant(HrScope.ALL)]);
    expect(
      all.every((o) =>
        isScopeUnitAllowed(
          { unitType: o.unitType, status: 'ACTIVE' },
          'BRANCH',
        ),
      ),
    ).toBe(true);
    expect(all.map((o) => o.id)).not.toContain(7);
  });
});
