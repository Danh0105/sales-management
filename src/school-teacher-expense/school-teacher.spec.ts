import { BadRequestException } from '@nestjs/common';

import { mapExpenseRows } from '../cashflow-report/cashflow-sources';
import { buildSchoolExpenseItemData } from '../school-expenses/expense-calculations';
import {
  allocateSchoolTeacherTax,
  buildSchoolTeacherItemData,
  schoolTeacherMoneySignature,
  schoolTeacherPaid,
  schoolTeacherSplitApplies,
} from './school-teacher';

describe('Giáo viên trường — kỳ áp dụng', () => {
  it.each([
    [{ year: 2026, month: 10 }, false],
    [{ year: 2026, month: 11 }, true],
    [{ year: 2026, month: 12 }, true],
    [{ year: 2027, month: 1 }, true],
    [{ year: 2025, month: 13 }, false],
    [{ year: 2026, month: 13 }, true],
    [null, false],
    [{ year: null, month: 11 }, false],
  ])('%j → %s', (period, expected) => {
    expect(schoolTeacherSplitApplies(period as any)).toBe(expected);
  });
});

describe('Giáo viên trường — tính một dòng', () => {
  const revenue = { totalPeriods: 20, studentCount: 100, monthsCount: 1 };

  it('dòng đi kèm Doanh Thu: số lượng theo Doanh Thu (có HS thì theo HS); thuế tính sau theo giáo viên', () => {
    expect(
      buildSchoolTeacherItemData(
        { unitPrice: '5000', studentCount: 999, content: 'bỏ qua', schoolTeacherId: '7', pitRate: 50 },
        0,
        revenue,
        false,
      ),
    ).toEqual({
      rowIndex: 0,
      schoolTeacherId: 7,
      content: null,
      totalPeriods: 20,
      studentCount: 100,
      monthsCount: 1,
      unitPrice: 5000,
      amount: 500_000,
      pitRate: 0,
      pitAmount: 0,
      netAmount: 500_000,
      expenseDate: null,
      cashAccount: null,
      note: null,
    });
  });

  it('không có HS thì theo số tiết × số tháng; Ngày chi / Nguồn chi / Ghi chú', () => {
    expect(
      buildSchoolTeacherItemData(
        { unitPrice: 30_000, expenseDate: '2026-11-12', cashAccount: '1111', note: ' ok ' },
        1,
        { totalPeriods: 3, studentCount: 0, monthsCount: 2 },
        false,
      ),
    ).toMatchObject({
      schoolTeacherId: null,
      amount: 180_000,
      expenseDate: '2026-11-12',
      cashAccount: '1111',
      note: 'ok',
    });
  });

  it('dòng thêm riêng giữ Nội dung + số lượng của chính nó', () => {
    expect(
      buildSchoolTeacherItemData(
        { content: '  Trợ giảng  ', totalPeriods: 4, studentCount: 0, monthsCount: 1, unitPrice: 100_000 },
        3,
        { content: '  Trợ giảng  ', totalPeriods: 4, studentCount: 0, monthsCount: 1, rowIndex: 3 },
        true,
      ),
    ).toMatchObject({ rowIndex: 3, content: 'Trợ giảng', amount: 400_000 });
  });

  it.each([
    [{ unitPrice: -1 }],
    [{ unitPrice: 1, schoolTeacherId: 'abc' }],
    [{ unitPrice: 1, schoolTeacherId: -3 }],
    [{ unitPrice: 1, expenseDate: '12/11/2026' }],
    [{ unitPrice: 1, cashAccount: '9999' }],
  ])('dữ liệu sai %j → 400', (item) => {
    expect(() => buildSchoolTeacherItemData(item, 0, revenue, false)).toThrow(BadRequestException);
  });

  it('đủ Ngày chi + Nguồn chi mới là đã trả', () => {
    expect(schoolTeacherPaid({ expenseDate: '2026-11-12', cashAccount: '1111' })).toBe(true);
    expect(schoolTeacherPaid({ expenseDate: '2026-11-12', cashAccount: null })).toBe(false);
    expect(schoolTeacherPaid({ expenseDate: null, cashAccount: '1111' })).toBe(false);
  });
});

describe('Thuế TNCN theo giáo viên — ngưỡng 5.000.000đ / tháng (như Excel của trường)', () => {
  it('cộng mọi dòng (mọi môn) của một giáo viên: từ 5 triệu thì 10% từng dòng, dưới thì 0', () => {
    const tax = allocateSchoolTeacherTax([
      // Mai Thị Sương: 2.000.000 + 2.250.000 + 1.500.000 = 5.750.000 → 10% (575.000)
      { key: 'a1', schoolTeacherId: 1, amount: 2_000_000 },
      { key: 'a2', schoolTeacherId: 1, amount: 2_250_000 },
      { key: 'a3', schoolTeacherId: 1, amount: 1_500_000 },
      // Nguyễn Thị Thu Thanh: 705.000 + 940.000 + 750.000 = 2.395.000 → 0
      { key: 'b1', schoolTeacherId: 2, amount: 705_000 },
      { key: 'b2', schoolTeacherId: 2, amount: 940_000 },
      { key: 'b3', schoolTeacherId: 2, amount: 750_000 },
    ]);
    expect([...tax.entries()].map(([key, v]) => [key, v.pitRate, v.pitAmount, v.netAmount])).toEqual([
      ['a1', 10, 200_000, 1_800_000],
      ['a2', 10, 225_000, 2_025_000],
      ['a3', 10, 150_000, 1_350_000],
      ['b1', 0, 0, 705_000],
      ['b2', 0, 0, 940_000],
      ['b3', 0, 0, 750_000],
    ]);
    const total = [...tax.values()].reduce((sum, v) => sum + v.pitAmount, 0);
    expect(total).toBe(575_000);
  });

  it('đúng 5.000.000 → có thuế; 4.999.999 → không', () => {
    expect(allocateSchoolTeacherTax([{ key: 1, schoolTeacherId: 9, amount: 5_000_000 }]).get(1)!.pitAmount).toBe(500_000);
    expect(allocateSchoolTeacherTax([{ key: 1, schoolTeacherId: 9, amount: 4_999_999 }]).get(1)!.pitAmount).toBe(0);
  });

  it('dòng chưa chọn giáo viên xét riêng từng dòng', () => {
    const tax = allocateSchoolTeacherTax([
      { key: 'x', schoolTeacherId: null, amount: 3_000_000 },
      { key: 'y', schoolTeacherId: null, amount: 3_000_000 },
      { key: 'z', schoolTeacherId: null, amount: 6_000_000 },
    ]);
    expect([tax.get('x')!.pitAmount, tax.get('y')!.pitAmount, tax.get('z')!.pitAmount]).toEqual([0, 0, 600_000]);
  });
});

describe('Giáo viên trường — đổi số tiền thì bỏ dấu Duyệt lương', () => {
  const base = { ...buildSchoolTeacherItemData({ unitPrice: 5000, schoolTeacherId: 3 }, 0, { studentCount: 100, monthsCount: 1 }, false), pitRate: 10, pitAmount: 50000 };
  const stored = { ...base, amount: '500000.00', unitPrice: '5000.00', pitAmount: '50000.00', pitRate: '10.00' };

  it('cùng số tiền (kể cả kiểu chuỗi từ DB, khác Ngày chi / Nguồn chi / Ghi chú) → giữ', () => {
    expect(
      schoolTeacherMoneySignature([{ ...stored, expenseDate: null } as any]),
    ).toBe(
      schoolTeacherMoneySignature([{ ...base, expenseDate: '2026-11-12', cashAccount: '1111', note: 'x' }]),
    );
  });

  it('đổi đơn giá / thuế / số lượng / giáo viên / thêm bớt dòng → khác', () => {
    const sig = schoolTeacherMoneySignature([base]);
    expect(schoolTeacherMoneySignature([{ ...base, schoolTeacherId: 4 }])).not.toBe(sig);
    expect(schoolTeacherMoneySignature([{ ...base, unitPrice: 6000 }])).not.toBe(sig);
    expect(schoolTeacherMoneySignature([{ ...base, pitRate: 5 }])).not.toBe(sig);
    expect(schoolTeacherMoneySignature([{ ...base, studentCount: 99 }])).not.toBe(sig);
    expect(schoolTeacherMoneySignature([base, { ...base, rowIndex: 1 }])).not.toBe(sig);
    expect(schoolTeacherMoneySignature([])).not.toBe(sig);
  });
});

describe('Chi Trường khi tách Giáo viên trường', () => {
  const item = { giaovien: 5000, thue: 1000, csvc: 500, paidAmount: 0 };
  const shared = { studentCount: 100, monthsCount: 1 };

  it('kỳ cũ: Chi Trường gồm Giáo viên trường + Thuế + CSVC', () => {
    expect(buildSchoolExpenseItemData(item, 0, shared)).toMatchObject({
      teacherAmount: 500_000,
      schoolExpenseAmount: 650_000,
    });
  });

  it('kỳ từ 11/2026: Chi Trường chỉ còn Thuế + CSVC', () => {
    expect(buildSchoolExpenseItemData(item, 0, shared, { teacherSplit: true })).toMatchObject({
      giaovien: 0,
      teacherAmount: 0,
      schoolExpenseAmount: 150_000,
      remaining: 150_000,
    });
  });
});

describe('Sổ thu chi — lương Giáo viên trường', () => {
  const ctx = {
    school_expense_id: 4,
    school_id: 5,
    school_name: 'TH A',
    subject_id: 8,
    subject_name: 'Tin học',
    period_month: 11,
    period_year: 2026,
  };

  it('đủ Ngày chi + Nguồn chi → bút toán chi "Còn lại phải chi"; thiếu một → lỗi tiếng Việt', () => {
    const { lines, issues } = mapExpenseRows(
      [
        { ...ctx, item_id: 1, row_index: 0, paid_amount: '450000.00', expense_date: '2026-11-12', cash_account: '1111' },
        { ...ctx, item_id: 2, row_index: 1, paid_amount: '100000.00', expense_date: '2026-11-12', cash_account: null },
        { ...ctx, item_id: 3, row_index: 2, paid_amount: '100000.00', expense_date: null, cash_account: '1121' },
      ],
      'SCHOOL_TEACHER',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      postingDate: '2026-11-12',
      accountCode: '1111',
      documentNo: 'GV-4-8-1',
      payment: 45_000_000n,
      receipt: 0n,
      source: { type: 'SCHOOL_TEACHER', itemId: 1, schoolExpenseId: 4, subjectId: 8, rowIndex: 0 },
    });
    expect(lines[0].description).toContain('Lương GV trường');
    expect(issues.map((issue) => issue.message)).toEqual([
      'Giáo viên trường có Ngày chi nhưng chưa chọn Nguồn chi',
      'Giáo viên trường có Nguồn chi nhưng chưa nhập Ngày chi',
    ]);
  });

  it('Chi Trường / Chi Ngoài giữ thông báo cũ', () => {
    const { issues } = mapExpenseRows(
      [{ ...ctx, item_id: 1, row_index: 0, paid_amount: '1.00', expense_date: '2026-11-12', cash_account: null }],
      'MANAGEMENT_EXPENSE',
    );
    expect(issues[0].message).toBe('Chi Ngoài có Đã chi nhưng chưa chọn Nguồn chi');
  });
});
