import 'reflect-metadata';
import { HrEmployeeStatus } from '../employees/entities/hr-employee.entity';
import { csvCell, parseCsv, toCsvText } from './csv';
import {
  checksumOf,
  DECISION_COLUMNS,
  ImportState,
  parseDecisionFile,
  toDecisionTemplate,
  validateDecisionFile,
} from './decision-file';
import type { AnalysisRow } from './legacy-employee-classifier';

const TODAY = '2026-10-05';

describe('csv', () => {
  it('ghi rồi đọc lại giữ nguyên: dấu phẩy, nháy, xuống dòng, tiếng Việt, +84 (chống công thức)', () => {
    const rows = [
      ['Nguyễn, "A"', '+84912345678', 'dòng 1\ndòng 2', '=HYPERLINK("x")'],
    ];
    const text = toCsvText(['a', 'b', 'c', 'd'], rows);
    expect(text.startsWith(String.fromCharCode(0xfeff))).toBe(true);
    expect(text).toContain(csvCell('=HYPERLINK("x")'));
    expect(parseCsv(text)).toEqual([['a', 'b', 'c', 'd'], ...rows]);
  });

  it('chấp nhận LF, bỏ dòng trống; nháy không đóng → lỗi', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(() => parseCsv('a,b\n"1,2\n')).toThrow('không được đóng');
  });

  it("chỉ bỏ ' khi là tiền tố chống công thức", () => {
    expect(parseCsv("x\n'+84\n'abc\n")).toEqual([['x'], ['+84'], ["'abc"]]);
  });
});

const header = [...DECISION_COLUMNS];
const line = (v: Partial<Record<(typeof DECISION_COLUMNS)[number], string>>) =>
  header.map((h) => v[h] ?? '');
const fileOf = (rows: string[][], cols: string[] = header) =>
  parseDecisionFile(toCsvText(cols, rows));

function state(over: Partial<ImportState> = {}): ImportState {
  return {
    accounts: new Map([
      [1, { isActive: true }],
      [2, { isActive: true }],
      [3, { isActive: false }],
      [4, { isActive: true }],
    ]),
    linkedAccounts: new Map([[4, 'NV000009']]),
    activeOrgUnits: new Map([['DV0002', 12]]),
    existingPhones: new Set(['0900000001']),
    existingEmails: new Set(['da.co@kido.vn']),
    ...over,
  };
}

const ok = (accountId: string, more = {}) =>
  line({
    accountId,
    decision: 'IMPORT',
    fullName: `Người ${accountId}`,
    attendanceMode: 'SHIFT',
    ...more,
  });

describe('validateDecisionFile', () => {
  it('IMPORT hợp lệ → kế hoạch Employee Core; SKIP không tạo gì; orgUnitCode chỉ là đề xuất', () => {
    const v = validateDecisionFile(
      fileOf([
        ok('2', {
          attendanceMode: 'teaching_session',
          phone: '0912 345.678',
          workEmail: ' A@KIDO.vn ',
          orgUnitCode: 'dv0002',
        }),
        ok('1', { attendanceMode: 'UNASSIGNED' }),
        line({ accountId: '3', decision: 'skip' }),
      ]),
      state(),
      TODAY,
    );
    expect(v.errors).toEqual([]);
    expect([v.importCount, v.skipCount, v.reviewCount, v.failedCount]).toEqual([
      2, 1, 0, 0,
    ]);
    // Thứ tự ghi xác định theo accountId.
    expect(v.toImport.map((r) => r.accountId)).toEqual([1, 2]);
    const teacher = v.toImport[1];
    expect(teacher.input).toEqual({
      fullName: 'Người 2',
      accountId: 2,
      status: HrEmployeeStatus.ACTIVE,
      attendanceMode: 'TEACHING_SESSION',
      dateOfBirth: null,
      gender: null,
      phone: '0912345678',
      workEmail: 'a@kido.vn',
      personalEmail: null,
    });
    expect(teacher.proposedOrgUnitId).toBe(12);
    expect(v.toImport[0].input.attendanceMode).toBe('UNASSIGNED');
    // Không có trường đơn vị/chức danh/ngày vào làm trong dữ liệu ghi hồ sơ.
    expect(Object.keys(teacher.input)).not.toEqual(
      expect.arrayContaining(['orgUnitId', 'positionId', 'joinDate']),
    );
  });

  it('còn REVIEW / decision lạ / trống → lỗi (không đoán)', () => {
    const v = validateDecisionFile(
      fileOf([
        line({ accountId: '1', decision: 'REVIEW' }),
        line({ accountId: '2', decision: 'YES' }),
        line({ accountId: '3', decision: '' }),
      ]),
      state(),
      TODAY,
    );
    const text = v.errors.join('\n');
    expect(text).toContain('Dòng 2 (tài khoản #1): còn REVIEW');
    expect(text).toContain('decision "YES" không nhận diện');
    expect(text).toContain('decision "" không nhận diện');
    expect(v.toImport).toEqual([]);
  });

  it('tài khoản không tồn tại / đã gắn hồ sơ / trùng trong file → lỗi', () => {
    const text = validateDecisionFile(
      fileOf([ok('99'), ok('4'), ok('1'), ok('1')]),
      state(),
      TODAY,
    ).errors.join('\n');
    expect(text).toContain('#99): tài khoản không tồn tại');
    expect(text).toContain('#4): tài khoản đã gắn với hồ sơ NV000009');
    expect(text).toContain('tài khoản trùng với dòng 4');
  });

  it('attendanceMode thiếu hoặc sai → lỗi; dữ liệu theo đúng luật API (DTO)', () => {
    const text = validateDecisionFile(
      fileOf([
        ok('1', { attendanceMode: '' }),
        ok('2', { attendanceMode: 'OFFICE' }),
        ok('3', { phone: '12ab', workEmail: 'khong-hop-le' }),
        ok('4', { dateOfBirth: '2999-01-01' }),
      ]),
      state({ linkedAccounts: new Map() }),
      TODAY,
    ).errors.join('\n');
    expect(text).toContain('#1): thiếu attendanceMode');
    expect(text).toContain('#2): attendanceMode');
    expect(text).toContain('#3): phone');
    expect(text).toContain('#3): workEmail');
    expect(text).toContain('#4): dateOfBirth');
  });

  it('orgUnitCode không phải đơn vị đang hoạt động → lỗi', () => {
    expect(
      validateDecisionFile(
        fileOf([ok('1', { orgUnitCode: 'DV9999' })]),
        state(),
        TODAY,
      ).errors.join('\n'),
    ).toContain('orgUnitCode "DV9999" không phải đơn vị đang hoạt động');
  });

  it('SĐT/email trùng → chỉ cảnh báo, vẫn import; tài khoản khoá → hồ sơ INACTIVE + cảnh báo', () => {
    const v = validateDecisionFile(
      fileOf([
        ok('1', { phone: '+84900000001', workEmail: 'da.co@kido.vn' }),
        ok('2', { phone: '0911111111' }),
        ok('3', { phone: '0911111111' }),
      ]),
      state(),
      TODAY,
    );
    expect(v.errors).toEqual([]);
    expect(v.importCount).toBe(3);
    const w = v.warnings.join('\n');
    expect(w).toContain('#1): SĐT đã có ở hồ sơ HR khác');
    expect(w).toContain('#1): email đã có ở hồ sơ HR khác');
    expect(w).toContain('#3): SĐT trùng dòng 3');
    expect(w).toContain('#3): tài khoản đang khoá');
    expect(v.toImport.find((r) => r.accountId === 3)?.input.status).toBe(
      HrEmployeeStatus.INACTIVE,
    );
  });

  it('cột định danh / việc làm / cột lạ → lỗi cả file; thiếu cột bắt buộc → lỗi', () => {
    const cols = [...header, 'cccd', 'joinDate', 'xyz'];
    const text = validateDecisionFile(
      fileOf([[...ok('1'), '0123', '2020-01-01', 'x']], cols),
      state(),
      TODAY,
    ).errors.join('\n');
    expect(text).toContain('Cột "cccd" không thuộc phạm vi');
    expect(text).toContain('Cột "joinDate" không thuộc phạm vi');
    expect(text).toContain('Cột lạ "xyz"');
    expect(
      validateDecisionFile(fileOf([['1']], ['accountId']), state(), TODAY)
        .errors,
    ).toContain('Thiếu cột bắt buộc "decision"');
  });

  it('một dòng lỗi → không có gì được coi là sẵn sàng ghi (nơi gọi dừng toàn bộ)', () => {
    const v = validateDecisionFile(
      fileOf([ok('1'), ok('2', { attendanceMode: '' })]),
      state(),
      TODAY,
    );
    expect(v.errors.length).toBe(1);
    expect(v.failedCount).toBe(1);
  });
});

describe('toDecisionTemplate', () => {
  const row = (over: Partial<AnalysisRow>): AnalysisRow => ({
    accountId: 1,
    name: 'Nguyễn Văn A',
    phone: '0912 345 678',
    email: 'A@kido.vn',
    legacyRoles: 'sales',
    department: 'Kinh doanh',
    isActive: true,
    category: 'OFFICE_STAFF',
    proposedEmployeeCode: 'TỰ SINH',
    proposedStatus: 'ACTIVE',
    proposedOrgUnitId: 12,
    proposedOrgUnitCode: 'DV0002',
    proposedOrgUnit: 'Kinh doanh',
    proposedAttendanceMode: 'SHIFT',
    importable: 'YES',
    warnings: [],
    ...over,
  });

  it('không tự quyết: NO → SKIP kèm lý do; YES/REVIEW → REVIEW; giá trị đề xuất điền sẵn', () => {
    const parsed = parseDecisionFile(
      toDecisionTemplate([
        row({}),
        row({
          accountId: 2,
          importable: 'NO',
          warnings: ['COLLABORATOR_EXCLUDED'],
          proposedAttendanceMode: 'TEACHING_SESSION',
          phone: 'abc',
        }),
      ]),
    );
    const [a, b] = parsed.rows.map((r) => r.values);
    expect(a).toMatchObject({
      decision: 'REVIEW',
      attendanceMode: 'SHIFT',
      phone: '0912345678',
      workEmail: 'a@kido.vn',
      orgUnitCode: 'DV0002',
    });
    expect(b).toMatchObject({
      decision: 'SKIP',
      phone: '',
      note: 'Không nhập: COLLABORATOR_EXCLUDED',
    });
    // Bản nháp chưa import được (còn REVIEW) — đúng chủ đích.
    const v = validateDecisionFile(
      parsed,
      {
        accounts: new Map([
          [1, { isActive: true }],
          [2, { isActive: true }],
        ]),
        linkedAccounts: new Map(),
        activeOrgUnits: new Map([['DV0002', 12]]),
        existingPhones: new Set(),
        existingEmails: new Set(),
      },
      TODAY,
    );
    expect(v.reviewCount).toBe(1);
    expect(v.errors.length).toBe(1);
  });

  it('checksum ổn định theo nội dung', () => {
    expect(checksumOf('abc')).toBe(checksumOf(Buffer.from('abc')));
    expect(checksumOf('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumOf('abc')).not.toBe(checksumOf('abd'));
  });
});
