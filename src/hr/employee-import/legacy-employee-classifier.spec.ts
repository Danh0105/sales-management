import {
  analyzeLegacyAccounts,
  categorize,
  isPossibleTestAccount,
  LegacyAccountRow,
  MappingRule,
  normalizePhone,
  proposeOrgUnit,
  toCsv,
} from './legacy-employee-classifier';

const acc = (
  over: Partial<LegacyAccountRow> & { id: number },
): LegacyAccountRow => ({
  name: `Nhân viên ${over.id}`,
  email: `nv${over.id}@kido.vn`,
  phone: `09000000${String(over.id).padStart(2, '0')}`,
  isActive: true,
  roles: ['sales'],
  departmentId: 1,
  departmentName: 'Kinh doanh',
  linkedEmployeeId: null,
  ...over,
});

const rules: MappingRule[] = [
  {
    sourceType: 'ROLE',
    sourceValue: 'nhansu',
    orgUnitId: 10,
    orgUnitName: 'Nhân sự',
    priority: 10,
  },
  {
    sourceType: 'ROLE',
    sourceValue: 'giaovu',
    orgUnitId: 11,
    orgUnitName: 'Giáo vụ',
    priority: 10,
  },
  {
    sourceType: 'ROLE',
    sourceValue: '*_la',
    orgUnitId: 20,
    orgUnitName: 'Chi nhánh Long An',
    priority: 5,
  },
  {
    sourceType: 'DEPARTMENT',
    sourceValue: 'Kinh doanh',
    orgUnitId: 12,
    orgUnitName: 'Kinh doanh',
    priority: 50,
  },
];

describe('categorize', () => {
  it.each([
    [['nhansu'], 'OFFICE_STAFF'],
    [['giaovien_congty'], 'TEACHER_STAFF'],
    [['giaovien_ctv'], 'TEACHER_COLLABORATOR'],
    [['giaovien_ctv', 'giaovu'], 'OFFICE_STAFF'],
    [['dev'], 'TECHNICAL'],
    [[], 'NO_ROLE'],
  ])('%j → %s', (roles, category) => {
    expect(categorize(roles).category).toBe(category);
  });

  it('role lạ → vẫn phân nhóm nhưng báo unknown', () => {
    expect(categorize(['role_moi']).unknown).toEqual(['role_moi']);
  });
});

describe('tiện ích', () => {
  it('chuẩn hoá SĐT: +84 ≡ 0', () => {
    expect(normalizePhone('+84 912 345 678')).toBe('0912345678');
    expect(normalizePhone('0912.345.678')).toBe('0912345678');
  });

  it('nhận diện tài khoản test', () => {
    expect(
      isPossibleTestAccount({ name: 'Tài khoản test', email: 'a@kido.vn' }),
    ).toBe(true);
    expect(
      isPossibleTestAccount({ name: 'Nguyễn Văn A', email: 'x@e2e.local' }),
    ).toBe(true);
    expect(
      isPossibleTestAccount({ name: 'Nguyễn Văn A', email: 'demo01@kido.vn' }),
    ).toBe(true);
    expect(
      isPossibleTestAccount({ name: 'Trần Thị Tester', email: 'tt@kido.vn' }),
    ).toBe(false);
  });
});

describe('proposeOrgUnit', () => {
  it('ưu tiên nhỏ nhất thắng (wildcard *_la ưu tiên hơn phòng ban)', () => {
    expect(
      proposeOrgUnit(
        { roles: ['salesadmin_la'], departmentName: 'Kinh doanh' },
        rules,
      ).unit?.orgUnitId,
    ).toBe(20);
  });

  it('khớp phòng ban không phân biệt hoa thường', () => {
    expect(
      proposeOrgUnit({ roles: ['sales'], departmentName: 'KINH DOANH ' }, rules)
        .unit?.orgUnitId,
    ).toBe(12);
  });

  it('hai mapping cùng ưu tiên, khác đơn vị → xung đột, không chọn bừa', () => {
    const r = proposeOrgUnit(
      { roles: ['nhansu', 'giaovu'], departmentName: null },
      rules,
    );
    expect(r.unit).toBeNull();
    expect(r.conflict).toBe(true);
  });

  it('không có mapping → không tự suy từ tên role', () => {
    expect(
      proposeOrgUnit({ roles: ['thuquy'], departmentName: null }, rules),
    ).toEqual({ unit: null, conflict: false });
  });
});

describe('analyzeLegacyAccounts', () => {
  const run = (accounts: LegacyAccountRow[]) =>
    Object.fromEntries(
      analyzeLegacyAccounts(accounts, rules, new Set([1, 2])).map((r) => [
        r.accountId,
        r,
      ]),
    );

  it('nhân viên văn phòng đủ dữ liệu → YES, mã tự sinh, chấm công theo ca', () => {
    const r = run([acc({ id: 1, roles: ['nhansu'] })])[1];
    expect(r.importable).toBe('YES');
    expect(r.proposedOrgUnit).toBe('Nhân sự');
    expect(r.proposedEmployeeCode).toContain('TỰ SINH');
    expect(r.proposedAttendanceMode).toBe('SHIFT');
    expect(r.warnings).toEqual([]);
  });

  it('chặn (NO): đã liên kết, khoá, test, kỹ thuật', () => {
    const r = run([
      acc({ id: 1, linkedEmployeeId: 5 }),
      acc({ id: 2, isActive: false }),
      acc({ id: 3, name: 'test sales' }),
      acc({ id: 4, roles: ['dev'] }),
    ]);
    expect(r[1].importable).toBe('NO');
    expect(r[1].warnings).toContain('ALREADY_LINKED');
    expect(r[2].warnings).toContain('INACTIVE_ACCOUNT');
    expect(r[3].warnings).toContain('POSSIBLE_TEST_ACCOUNT');
    expect(r[4].warnings).toContain('TECHNICAL_ACCOUNT');
    expect([r[2], r[3], r[4]].every((x) => x.importable === 'NO')).toBe(true);
  });

  it('CTV bị loại (NO); cần xem lại (REVIEW): thiếu tổ chức, trùng email/SĐT, phòng ban lạ, không role', () => {
    const r = run([
      acc({
        id: 1,
        roles: ['giaovien_ctv'],
        departmentName: null,
        departmentId: null,
      }),
      acc({
        id: 2,
        roles: ['thuquy'],
        departmentName: null,
        departmentId: null,
      }),
      acc({ id: 3, email: 'trung@kido.vn' }),
      acc({ id: 4, email: 'TRUNG@kido.vn', phone: '+84900000003' }),
      acc({ id: 5, departmentId: 99 }),
      acc({ id: 6, roles: [] }),
    ]);
    expect(r[1].warnings).toEqual(
      expect.arrayContaining(['COLLABORATOR_EXCLUDED', 'MISSING_ORGANIZATION']),
    );
    expect(r[1].proposedAttendanceMode).toBe('TEACHING_SESSION');
    expect(r[2].warnings).toContain('MISSING_ORGANIZATION');
    expect(r[3].warnings).toEqual(
      expect.arrayContaining(['DUPLICATE_EMAIL', 'DUPLICATE_PHONE']),
    );
    expect(r[4].warnings).toEqual(
      expect.arrayContaining(['DUPLICATE_EMAIL', 'DUPLICATE_PHONE']),
    );
    expect(r[5].warnings).toContain('UNKNOWN_DEPARTMENT');
    expect(r[6].warnings).toContain('NO_ROLE');
    // Không role → không có rule rõ ràng → UNASSIGNED (không ngầm SHIFT).
    expect(r[6].proposedAttendanceMode).toBe('UNASSIGNED');
    // Quyết định 30/09/2026: CTV không nhập → NO; các trường hợp còn lại REVIEW.
    expect(r[1].importable).toBe('NO');
    expect(
      [r[2], r[3], r[4], r[5], r[6]].every((x) => x.importable === 'REVIEW'),
    ).toBe(true);
  });

  it('CTV kiêm role văn phòng → xét như nhân viên văn phòng (không bị loại)', () => {
    const r = run([acc({ id: 1, roles: ['giaovien_ctv', 'giaovu'] })])[1];
    expect(r.category).toBe('OFFICE_STAFF');
    expect(r.warnings).not.toContain('COLLABORATOR_EXCLUDED');
  });

  it('giáo viên cơ hữu đủ dữ liệu → YES, chấm công theo tiết dạy', () => {
    const teacherRule: MappingRule = {
      sourceType: 'ROLE',
      sourceValue: 'giaovien_congty',
      orgUnitId: 30,
      orgUnitName: 'Tổ giáo viên',
      priority: 10,
    };
    const [row] = analyzeLegacyAccounts(
      [
        acc({
          id: 1,
          roles: ['giaovien_congty'],
          departmentName: null,
          departmentId: null,
        }),
      ],
      [...rules, teacherRule],
      new Set([1]),
    );
    expect(row.importable).toBe('YES');
    expect(row.proposedAttendanceMode).toBe('TEACHING_SESSION');
    expect(row.proposedOrgUnit).toBe('Tổ giáo viên');
  });

  it('chỉ có role lạ → UNASSIGNED; role văn phòng đã biết → SHIFT', () => {
    const r = run([
      acc({ id: 1, roles: ['role_moi'] }),
      acc({ id: 2, roles: ['role_moi', 'thuquy'] }),
    ]);
    expect(r[1].proposedAttendanceMode).toBe('UNASSIGNED');
    expect(r[2].proposedAttendanceMode).toBe('SHIFT');
  });

  it('không bao giờ đề xuất import dữ liệu định danh nhạy cảm (không có cột CCCD/ngân hàng/BHXH)', () => {
    const row = run([acc({ id: 1 })])[1] as unknown as Record<string, unknown>;
    expect(
      Object.keys(row).some((k) => /cccd|identity|bank|tax|insurance/i.test(k)),
    ).toBe(false);
  });
});

describe('toCsv', () => {
  it('có BOM, escape dấu phẩy/nháy, chặn công thức Excel', () => {
    const rows = analyzeLegacyAccounts(
      [
        acc({ id: 1, name: 'Nguyễn, "A"' }),
        acc({ id: 2, name: '=HYPERLINK("x")' }),
      ],
      rules,
      new Set([1]),
    );
    const csv = toCsv(rows);
    expect(csv.startsWith('﻿accountId,')).toBe(true);
    expect(csv).toContain('"Nguyễn, ""A"""');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
