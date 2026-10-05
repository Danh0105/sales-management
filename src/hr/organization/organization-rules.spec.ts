import type { HrGrant } from '../access/hr-access.service';
import { HrPermission, HrScope } from '../access/hr-permission';
import {
  leaderRoleAllowed,
  parentTypeAllowed,
  periodsOverlap,
} from './org-policy';
import {
  canManageUnit,
  canPlaceUnder,
  hasUnrestrictedOrgManage,
} from './org-scope';
import { OrgNode, OrgSnapshot } from './org-tree';
import { leaderViolation, structureViolation } from './org-validation';

const node = (
  id: number,
  unitType: OrgNode['unitType'],
  parentId: number | null,
  status: OrgNode['status'] = 'ACTIVE',
): OrgNode => ({
  id,
  code: `U${id}`,
  revisionId: id,
  unitType,
  name: `Đơn vị ${id}`,
  parentId,
  status,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
});

// 1 COMPANY ─ 2 BRANCH A ─ 4 DEPT ─ 6 TEAM
//           │            └ 5 DEPT
//           └ 3 BRANCH B ─ 7 DEPT
const tree = () =>
  new OrgSnapshot('2026-10-01', [
    node(1, 'COMPANY', null),
    node(2, 'BRANCH', 1),
    node(3, 'BRANCH', 1),
    node(4, 'DEPARTMENT', 2),
    node(5, 'DEPARTMENT', 2),
    node(6, 'TEAM', 4),
    node(7, 'DEPARTMENT', 3),
  ]);

const grant = (scope: HrScope, scopeRefId: number | null = null): HrGrant => ({
  permission: HrPermission.ORG_MANAGE,
  scope,
  scopeRefId,
  source: 'assignment',
  via: 'x',
  effectiveFrom: null,
  effectiveTo: null,
});

describe('Luật loại đơn vị', () => {
  it.each([
    ['COMPANY', null, true],
    ['COMPANY', 'COMPANY', false],
    ['BRANCH', 'COMPANY', true],
    ['BRANCH', 'BRANCH', false],
    ['DEPARTMENT', 'BRANCH', true],
    ['DEPARTMENT', 'DEPARTMENT', true],
    ['TEAM', 'DEPARTMENT', true],
    ['TEAM', 'BRANCH', false],
    ['DEPARTMENT', null, false],
  ] as const)('%s dưới %s → %s', (child, parent, ok) => {
    expect(parentTypeAllowed(child, parent)).toBe(ok);
  });

  it('vai trò lãnh đạo theo loại: BRANCH_DIRECTOR chỉ ở chi nhánh', () => {
    expect(leaderRoleAllowed('BRANCH_DIRECTOR', 'BRANCH')).toBe(true);
    expect(leaderRoleAllowed('BRANCH_DIRECTOR', 'COMPANY')).toBe(false);
    expect(leaderRoleAllowed('DEPARTMENT_HEAD', 'TEAM')).toBe(true);
    expect(leaderRoleAllowed('COMPANY_DIRECTOR', 'BRANCH')).toBe(false);
  });

  it('giao nhau khoảng ngày (inclusive, null = mở)', () => {
    expect(
      periodsOverlap(
        { from: '2026-01-01', to: '2026-06-30' },
        { from: '2026-06-30', to: null },
      ),
    ).toBe(true);
    expect(
      periodsOverlap(
        { from: '2026-01-01', to: '2026-06-29' },
        { from: '2026-06-30', to: null },
      ),
    ).toBe(false);
    expect(
      periodsOverlap(
        { from: '2026-01-01', to: null },
        { from: '2030-01-01', to: '2030-01-02' },
      ),
    ).toBe(true);
  });
});

describe('OrgSnapshot — cây tại một ngày', () => {
  it('tổ tiên, con cháu, chi nhánh gần nhất', () => {
    const s = tree();
    expect(s.ancestors(6).map((n) => n.id)).toEqual([4, 2, 1]);
    expect([...s.subtreeIds(2)].sort()).toEqual([2, 4, 5, 6]);
    expect(s.nearest(6, ['BRANCH'])?.id).toBe(2);
    expect(s.nearest(2, ['BRANCH'])?.id).toBe(2);
    expect(s.nearest(1, ['BRANCH'])).toBeNull();
    expect(s.isStrictDescendant(6, 2)).toBe(true);
    expect(s.isStrictDescendant(2, 2)).toBe(false);
  });

  it('phát hiện vòng lặp khi chuyển cha', () => {
    const s = tree();
    expect(s.wouldCycle(4, 6)).toBe(true); // đặt phòng dưới chính nhóm con
    expect(s.wouldCycle(4, 4)).toBe(true);
    expect(s.wouldCycle(4, 5)).toBe(false);
  });

  it('dữ liệu lỗi có vòng lặp không làm treo', () => {
    const s = new OrgSnapshot('2026-10-01', [
      node(1, 'DEPARTMENT', 2),
      node(2, 'DEPARTMENT', 1),
    ]);
    expect(s.ancestors(1).map((n) => n.id)).toEqual([2]);
    expect(s.subtreeIds(1).size).toBe(2);
  });
});

describe('structureViolation', () => {
  it('công ty thứ hai đang hoạt động → HR_ORG_COMPANY_EXISTS', () => {
    const c = node(-1, 'COMPANY', null);
    expect(structureViolation(tree().withNode(c), c)?.code).toBe(
      'HR_ORG_COMPANY_EXISTS',
    );
  });

  it('cha không tồn tại / sai loại / ngừng hoạt động', () => {
    const s = tree();
    const orphan = node(-1, 'DEPARTMENT', 99);
    expect(structureViolation(s.withNode(orphan), orphan)?.code).toBe(
      'HR_ORG_PARENT_NOT_FOUND',
    );
    const team = node(-1, 'TEAM', 2);
    expect(structureViolation(s.withNode(team), team)?.code).toBe(
      'HR_ORG_PARENT_TYPE',
    );
    const closed = s.withNode(node(5, 'DEPARTMENT', 2, 'INACTIVE'));
    const dept = node(-1, 'DEPARTMENT', 5);
    expect(structureViolation(closed.withNode(dept), dept)?.code).toBe(
      'HR_ORG_PARENT_INACTIVE',
    );
  });

  it('chuyển phòng dưới chính nhóm con → HR_ORG_CYCLE', () => {
    const moved = { ...node(4, 'DEPARTMENT', 6) };
    expect(structureViolation(tree().withNode(moved), moved)?.code).toBe(
      'HR_ORG_PARENT_TYPE',
    );
    const deptUnderSub = { ...node(4, 'DEPARTMENT', 4) };
    expect(
      structureViolation(tree().withNode(deptUnderSub), deptUnderSub)?.code,
    ).toBe('HR_ORG_CYCLE');
  });

  it('đóng đơn vị còn con đang hoạt động → HR_ORG_HAS_ACTIVE_CHILDREN', () => {
    const closing = node(2, 'BRANCH', 1, 'INACTIVE');
    expect(structureViolation(tree().withNode(closing), closing)?.code).toBe(
      'HR_ORG_HAS_ACTIVE_CHILDREN',
    );
  });

  it('đổi loại làm đơn vị con không còn hợp lệ → HR_ORG_CHILD_TYPE', () => {
    const asTeam = node(4, 'TEAM', 5);
    expect(structureViolation(tree().withNode(asTeam), asTeam)?.code).toBe(
      'HR_ORG_CHILD_TYPE',
    );
  });

  it('hợp lệ → null', () => {
    const dept = node(-1, 'DEPARTMENT', 3);
    expect(structureViolation(tree().withNode(dept), dept)).toBeNull();
  });

  it('vai trò lãnh đạo trên đơn vị đóng / sai loại', () => {
    const s = tree().withNode(node(5, 'DEPARTMENT', 2, 'INACTIVE'));
    expect(leaderViolation(s, 5, 'DEPARTMENT_HEAD')?.code).toBe(
      'HR_ORG_UNIT_INACTIVE',
    );
    expect(leaderViolation(s, 4, 'BRANCH_DIRECTOR')?.code).toBe(
      'HR_ORG_LEADER_ROLE',
    );
    expect(leaderViolation(s, 2, 'BRANCH_DIRECTOR')).toBeNull();
  });
});

describe('Phạm vi ORG_MANAGE', () => {
  const s = tree();

  it('COMPANY/ALL: toàn bộ', () => {
    expect(hasUnrestrictedOrgManage([grant(HrScope.COMPANY)])).toBe(true);
    expect(canManageUnit([grant(HrScope.ALL)], s, 1)).toBe(true);
  });

  it('BRANCH A: chỉ con cháu của A, không sửa chính A, không đụng B', () => {
    const g = [grant(HrScope.BRANCH, 2)];
    expect(canManageUnit(g, s, 4)).toBe(true);
    expect(canManageUnit(g, s, 6)).toBe(true);
    expect(canManageUnit(g, s, 2)).toBe(false);
    expect(canManageUnit(g, s, 7)).toBe(false);
    expect(canManageUnit(g, s, 3)).toBe(false);
    expect(canPlaceUnder(g, s, 2)).toBe(true); // tạo phòng mới ngay dưới A
    expect(canPlaceUnder(g, s, 3)).toBe(false); // không đặt vào B
  });

  it('BRANCH trỏ tới đơn vị không phải chi nhánh → không có hiệu lực', () => {
    expect(canManageUnit([grant(HrScope.BRANCH, 4)], s, 6)).toBe(false);
  });

  it('ORG_UNIT X: con cháu của X', () => {
    const g = [grant(HrScope.ORG_UNIT, 4)];
    expect(canManageUnit(g, s, 6)).toBe(true);
    expect(canManageUnit(g, s, 4)).toBe(false);
    expect(canManageUnit(g, s, 5)).toBe(false);
  });

  it('SELF / TEAM / BRANCH không gắn đơn vị → không quản lý được gì', () => {
    for (const g of [
      grant(HrScope.SELF),
      grant(HrScope.TEAM),
      grant(HrScope.BRANCH),
    ]) {
      expect(canManageUnit([g], s, 6)).toBe(false);
      expect(canPlaceUnder([g], s, 4)).toBe(false);
    }
  });

  it('quyền khác (EMPLOYEE_EDIT COMPANY) không thay được ORG_MANAGE', () => {
    const other: HrGrant = {
      ...grant(HrScope.COMPANY),
      permission: HrPermission.EMPLOYEE_EDIT,
    };
    expect(canManageUnit([other], s, 4)).toBe(false);
  });
});
