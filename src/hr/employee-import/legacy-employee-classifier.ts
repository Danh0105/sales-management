/**
 * Phân tích tài khoản cũ (`public.employee`) trước khi nhập hồ sơ HR (Phase 1.2).
 *
 * `public.employee` là TÀI KHOẢN ĐĂNG NHẬP, không phải danh sách nhân sự: có
 * tài khoản test, kỹ thuật, đã nghỉ, cộng tác viên… Hàm ở đây chỉ ĐỀ XUẤT —
 * con người xác nhận trước khi nhập. Không tự suy đơn vị từ tên role nếu chưa
 * có mapping được HR cấu hình (`hr.legacy_org_mappings`).
 *
 * Thuần (không truy cập DB) để test đầy đủ.
 */

import { toCsvText } from './csv';

export interface LegacyAccountRow {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  roles: string[];
  departmentId: number | null;
  departmentName: string | null;
  /** `hr.employees.id` nếu tài khoản đã gắn với hồ sơ HR. */
  linkedEmployeeId: number | null;
}

export interface MappingRule {
  sourceType: 'DEPARTMENT' | 'ROLE';
  /** ROLE hỗ trợ `*` (vd. `*_la`); DEPARTMENT so khớp nguyên tên (không phân biệt hoa thường). */
  sourceValue: string;
  orgUnitId: number;
  orgUnitName: string;
  /** Mã đơn vị thật (DV####) — để decision file tham chiếu cho Phase 1.4. */
  orgUnitCode?: string;
  priority: number;
}

export type AccountCategory =
  | 'OFFICE_STAFF'
  | 'TEACHER_STAFF'
  | 'TEACHER_COLLABORATOR'
  | 'TECHNICAL'
  | 'NO_ROLE';

export type Importable = 'YES' | 'NO' | 'REVIEW';

export type AnalysisWarning =
  | 'MISSING_ORGANIZATION'
  | 'MAPPING_CONFLICT'
  | 'DUPLICATE_EMAIL'
  | 'DUPLICATE_PHONE'
  | 'UNKNOWN_DEPARTMENT'
  | 'INACTIVE_ACCOUNT'
  | 'POSSIBLE_TEST_ACCOUNT'
  | 'ALREADY_LINKED'
  | 'UNKNOWN_ROLE'
  | 'NO_ROLE'
  | 'TECHNICAL_ACCOUNT'
  /** Quyết định 30/09/2026: CTV (chỉ role giaovien_ctv) KHÔNG nhập vào hồ sơ HR. */
  | 'COLLABORATOR_EXCLUDED'
  | 'MISSING_NAME';

export interface AnalysisRow {
  accountId: number;
  name: string;
  phone: string;
  email: string;
  legacyRoles: string;
  department: string;
  isActive: boolean;
  category: AccountCategory;
  proposedEmployeeCode: string;
  proposedStatus: 'ACTIVE' | 'INACTIVE';
  proposedOrgUnitId: number | null;
  proposedOrgUnitCode: string;
  proposedOrgUnit: string;
  proposedAttendanceMode: 'SHIFT' | 'TEACHING_SESSION' | 'UNASSIGNED';
  importable: Importable;
  warnings: AnalysisWarning[];
}

/** Role cũ đã biết — nơi DUY NHẤT phân nhóm; role lạ → REVIEW. */
export const TEACHER_STAFF_ROLES = ['giaovien_congty'];
export const TEACHER_COLLABORATOR_ROLES = ['giaovien_ctv'];
export const TECHNICAL_ROLES = ['dev'];
export const OFFICE_ROLES = [
  'nhansu',
  'giaovu',
  'sales',
  'saleadmin',
  'salesadmin',
  'salesadmin_la',
  'director',
  'director_la',
  'troly_gd',
  'accountant',
  'ketoan_congno',
  'ketoan_truong',
  'thuquy',
  'ky_thuat',
  'employee_la',
  'probation',
];

const TEST_PATTERN =
  /(^|[^a-z])(test|demo|dummy|sample|e2e|thu nghiem|thử nghiệm|tài khoản thử)([^a-z]|$)/i;
const TEST_DOMAINS = ['e2e.local', 'example.com', 'test.com'];

export const normalizeEmail = (v: string | null) =>
  (v ?? '').trim().toLowerCase();
/** Bỏ ký tự không phải số; `+84xxxxxxxxx` ≡ `0xxxxxxxxx`. */
export function normalizePhone(v: string | null): string {
  const digits = (v ?? '').replace(/\D/g, '');
  return digits.startsWith('84') && digits.length === 11
    ? `0${digits.slice(2)}`
    : digits;
}

export function categorize(roles: string[]): {
  category: AccountCategory;
  unknown: string[];
} {
  const known = new Set([
    ...TEACHER_STAFF_ROLES,
    ...TEACHER_COLLABORATOR_ROLES,
    ...TECHNICAL_ROLES,
    ...OFFICE_ROLES,
  ]);
  const unknown = roles.filter((r) => !known.has(r));
  if (!roles.length) return { category: 'NO_ROLE', unknown };
  // Vai rộng nhất thắng: văn phòng > giáo viên cơ hữu > CTV > kỹ thuật.
  if (roles.some((r) => OFFICE_ROLES.includes(r)) || unknown.length)
    return { category: 'OFFICE_STAFF', unknown };
  if (roles.some((r) => TEACHER_STAFF_ROLES.includes(r)))
    return { category: 'TEACHER_STAFF', unknown };
  if (roles.some((r) => TEACHER_COLLABORATOR_ROLES.includes(r)))
    return { category: 'TEACHER_COLLABORATOR', unknown };
  return { category: 'TECHNICAL', unknown };
}

/**
 * Kiểu chấm công đề xuất — chỉ theo rule rõ ràng (quyết định 30/09/2026):
 * giáo viên → TEACHING_SESSION; có ít nhất một role văn phòng ĐÃ BIẾT → SHIFT;
 * còn lại (không role, chỉ role lạ, kỹ thuật) → UNASSIGNED để người duyệt quyết.
 */
export function proposeAttendanceMode(
  roles: string[],
  category: AccountCategory,
): 'SHIFT' | 'TEACHING_SESSION' | 'UNASSIGNED' {
  if (category === 'TEACHER_STAFF' || category === 'TEACHER_COLLABORATOR')
    return 'TEACHING_SESSION';
  if (roles.some((r) => OFFICE_ROLES.includes(r))) return 'SHIFT';
  return 'UNASSIGNED';
}

export function isPossibleTestAccount(
  row: Pick<LegacyAccountRow, 'name' | 'email'>,
): boolean {
  const email = normalizeEmail(row.email);
  return (
    TEST_PATTERN.test(row.name ?? '') ||
    TEST_PATTERN.test(email.split('@')[0] ?? '') ||
    TEST_DOMAINS.some((d) => email.endsWith(`@${d}`))
  );
}

function roleMatches(pattern: string, role: string): boolean {
  if (!pattern.includes('*')) return pattern === role;
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(role);
}

/** Đơn vị đề xuất theo mapping có ưu tiên nhỏ nhất; nhiều đơn vị cùng ưu tiên → xung đột. */
export function proposeOrgUnit(
  row: Pick<LegacyAccountRow, 'roles' | 'departmentName'>,
  rules: MappingRule[],
): { unit: MappingRule | null; conflict: boolean } {
  const dept = (row.departmentName ?? '').trim().toLowerCase();
  const matches = rules.filter((r) =>
    r.sourceType === 'DEPARTMENT'
      ? dept !== '' && r.sourceValue.trim().toLowerCase() === dept
      : row.roles.some((role) => roleMatches(r.sourceValue, role)),
  );
  if (!matches.length) return { unit: null, conflict: false };
  const best = Math.min(...matches.map((m) => m.priority));
  const top = matches.filter((m) => m.priority === best);
  const distinct = new Set(top.map((m) => m.orgUnitId));
  return {
    unit: distinct.size === 1 ? top[0] : null,
    conflict: distinct.size > 1,
  };
}

export function analyzeLegacyAccounts(
  accounts: LegacyAccountRow[],
  rules: MappingRule[],
  knownDepartmentIds: Set<number>,
): AnalysisRow[] {
  const count = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) if (k) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const emails = count(accounts.map((a) => normalizeEmail(a.email)));
  const phones = count(accounts.map((a) => normalizePhone(a.phone)));

  return accounts.map((a) => {
    const warnings: AnalysisWarning[] = [];
    const { category, unknown } = categorize(a.roles);
    const { unit, conflict } = proposeOrgUnit(a, rules);

    if (!a.name?.trim()) warnings.push('MISSING_NAME');
    if (a.linkedEmployeeId !== null) warnings.push('ALREADY_LINKED');
    if (!a.isActive) warnings.push('INACTIVE_ACCOUNT');
    if (isPossibleTestAccount(a)) warnings.push('POSSIBLE_TEST_ACCOUNT');
    if (category === 'TECHNICAL') warnings.push('TECHNICAL_ACCOUNT');
    if (category === 'NO_ROLE') warnings.push('NO_ROLE');
    if (unknown.length) warnings.push('UNKNOWN_ROLE');
    if (category === 'TEACHER_COLLABORATOR')
      warnings.push('COLLABORATOR_EXCLUDED');
    if (a.departmentId !== null && !knownDepartmentIds.has(a.departmentId))
      warnings.push('UNKNOWN_DEPARTMENT');
    if (conflict) warnings.push('MAPPING_CONFLICT');
    else if (!unit) warnings.push('MISSING_ORGANIZATION');
    if ((emails.get(normalizeEmail(a.email)) ?? 0) > 1)
      warnings.push('DUPLICATE_EMAIL');
    if ((phones.get(normalizePhone(a.phone)) ?? 0) > 1)
      warnings.push('DUPLICATE_PHONE');

    const blocking: AnalysisWarning[] = [
      'ALREADY_LINKED',
      'INACTIVE_ACCOUNT',
      'POSSIBLE_TEST_ACCOUNT',
      'TECHNICAL_ACCOUNT',
      'COLLABORATOR_EXCLUDED',
    ];
    const importable: Importable = warnings.some((w) => blocking.includes(w))
      ? 'NO'
      : warnings.length
        ? 'REVIEW'
        : 'YES';

    return {
      accountId: a.id,
      name: a.name?.trim() ?? '',
      phone: a.phone ?? '',
      email: a.email ?? '',
      legacyRoles: a.roles.join('|'),
      department: a.departmentName ?? '',
      isActive: a.isActive,
      category,
      proposedEmployeeCode:
        a.linkedEmployeeId !== null ? '(đã có hồ sơ)' : 'TỰ SINH (NV + 6 số)',
      proposedStatus: a.isActive ? 'ACTIVE' : 'INACTIVE',
      proposedOrgUnitId: unit?.orgUnitId ?? null,
      proposedOrgUnitCode: unit?.orgUnitCode ?? '',
      proposedOrgUnit: unit?.orgUnitName ?? '',
      proposedAttendanceMode: proposeAttendanceMode(a.roles, category),
      importable,
      warnings,
    };
  });
}

const CSV_COLUMNS: (keyof AnalysisRow)[] = [
  'accountId',
  'name',
  'phone',
  'email',
  'legacyRoles',
  'department',
  'isActive',
  'category',
  'proposedEmployeeCode',
  'proposedStatus',
  'proposedOrgUnitId',
  'proposedOrgUnitCode',
  'proposedOrgUnit',
  'proposedAttendanceMode',
  'importable',
  'warnings',
];

/** CSV UTF-8 có BOM (mở đúng tiếng Việt trong Excel). Chặn công thức (=, +, -, @). */
export function toCsv(rows: AnalysisRow[]): string {
  return toCsvText(
    CSV_COLUMNS,
    rows.map((r) =>
      CSV_COLUMNS.map((c) => {
        const v = r[c];
        return Array.isArray(v) ? v.join('|') : v;
      }),
    ),
  );
}
