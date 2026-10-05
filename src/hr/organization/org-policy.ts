/**
 * Luật cơ cấu tổ chức (thuần, không truy cập DB) — nơi DUY NHẤT định nghĩa
 * loại đơn vị, quan hệ cha–con hợp lệ và vai trò lãnh đạo theo loại đơn vị.
 */

export const ORG_UNIT_TYPES = [
  'COMPANY',
  'BRANCH',
  'DEPARTMENT',
  'TEAM',
] as const;
export type OrgUnitType = (typeof ORG_UNIT_TYPES)[number];

export const ORG_UNIT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type OrgUnitStatus = (typeof ORG_UNIT_STATUSES)[number];

/** Loại đơn vị cha được phép cho từng loại. COMPANY không có cha. */
export const ALLOWED_PARENT_TYPES: Record<OrgUnitType, readonly OrgUnitType[]> =
  {
    COMPANY: [],
    BRANCH: ['COMPANY'],
    DEPARTMENT: ['COMPANY', 'BRANCH', 'DEPARTMENT'],
    TEAM: ['DEPARTMENT'],
  };

/**
 * Vai trò lãnh đạo (semantic). `DIRECTOR` trong workflow = `BRANCH_DIRECTOR`:
 * giám đốc CHI NHÁNH nơi nhân viên thuộc về tại ngày hiệu lực.
 */
export const ORG_LEADER_ROLES = [
  'DEPARTMENT_HEAD',
  'BRANCH_DIRECTOR',
  'COMPANY_DIRECTOR',
  'DEPUTY',
] as const;
export type OrgLeaderRole = (typeof ORG_LEADER_ROLES)[number];

/** Vai trò lãnh đạo gắn được vào loại đơn vị nào. */
export const LEADER_ROLE_UNIT_TYPES: Record<
  OrgLeaderRole,
  readonly OrgUnitType[]
> = {
  DEPARTMENT_HEAD: ['DEPARTMENT', 'TEAM'],
  BRANCH_DIRECTOR: ['BRANCH'],
  COMPANY_DIRECTOR: ['COMPANY'],
  DEPUTY: ['COMPANY', 'BRANCH', 'DEPARTMENT', 'TEAM'],
};

/** Phase này: phó không bao giờ là người duyệt chính (không tự hiểu tương đương). */
export const APPROVAL_AUTHORITY_ROLES: readonly OrgLeaderRole[] = [
  'DEPARTMENT_HEAD',
  'BRANCH_DIRECTOR',
  'COMPANY_DIRECTOR',
];

export const ORG_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export function parentTypeAllowed(
  childType: OrgUnitType,
  parentType: OrgUnitType | null,
): boolean {
  if (childType === 'COMPANY') return parentType === null;
  return (
    parentType !== null && ALLOWED_PARENT_TYPES[childType].includes(parentType)
  );
}

export function leaderRoleAllowed(
  role: OrgLeaderRole,
  unitType: OrgUnitType,
): boolean {
  return LEADER_ROLE_UNIT_TYPES[role].includes(unitType);
}

/** Hai khoảng ngày (inclusive, `null` = không giới hạn) có giao nhau không. */
export function periodsOverlap(
  a: { from: string; to: string | null },
  b: { from: string; to: string | null },
): boolean {
  return (a.to === null || a.to >= b.from) && (b.to === null || b.to >= a.from);
}

export const HR_APPROVER_NOT_CONFIGURED = 'HR_APPROVER_NOT_CONFIGURED';
