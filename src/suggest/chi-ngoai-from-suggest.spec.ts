import { SchoolExpenseManagementConfirmation } from '../school-expenses/entities/school-expense-management-confirmation.entity';
import { ExpenseRole } from './constants/expense-roles';
import { SuggestMonthlyItem } from './entities/suggest-monthly-item.entity';
import { SuggestPolicySupportItem } from './entities/suggest-policy-support-item.entity';
import { SuggestService } from './suggest.service';
import { vnToday } from './utils/vn-date';

/**
 * Kinh doanh xác nhận đã chi một đề xuất chi tháng → Ngày chi / Nguồn chi / Đã
 * chi ghi vào bảng Chi Ngoài của từng trường (phần lúc Giám đốc duyệt, chia cho
 * các dòng theo Còn chi hiện tại).
 */

const sales = { id: 7, roles: [ExpenseRole.SALES] } as never;

// Bảng Chi Ngoài kỳ 3 của trường 5, môn 8: dòng 71 Chi ngoài 100.000 (chưa chi),
// dòng 72 Chi ngoài 200.000 đã chi tay 50.000 → Còn chi 150.000.
const sheet = {
  id: 40,
  school: { id: 5, name: 'TH A' },
  period: { id: 3, month: 9, year: 2026 },
  managementExpenseItems: [
    { id: 71, rowIndex: 0, subject: { id: 8, schoolYear: '2026-2027', policies: [] }, ql1UnitPrice: 1000, paidAmount: 0, otherCosts: [] },
    { id: 72, rowIndex: 1, subject: { id: 8, schoolYear: '2026-2027', policies: [] }, ql1UnitPrice: 2000, paidAmount: 50_000, otherCosts: [] },
    // Môn khác cùng kỳ: không đụng.
    { id: 73, rowIndex: 0, subject: { id: 9, schoolYear: '2026-2027', policies: [] }, ql1UnitPrice: 5000, paidAmount: 0, otherCosts: [] },
  ],
  revenueItems: [
    { rowIndex: 0, subject: { id: 8 }, studentCount: 100, monthsCount: 1 },
    { rowIndex: 1, subject: { id: 8 }, studentCount: 100, monthsCount: 1 },
    { rowIndex: 0, subject: { id: 9 }, studentCount: 100, monthsCount: 1 },
  ],
};

const monthlyRow = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 11,
    schoolId: 5,
    schoolYear: '2026-2027',
    subjectId: 8,
    expensePeriodId: 3,
    approvedAmount: 250_000,
    excluded: false,
    school: { name: 'TH A' },
    subject: { name: 'Tin học' },
    expensePeriod: { name: 'Tháng 9' },
    ...overrides,
  }) as unknown as SuggestMonthlyItem;

function setup(rows = [monthlyRow()], isMonthlyExpense = true, confirmations: unknown[] = []) {
  const sql: { text: string; params: unknown[] }[] = [];
  let sheets: unknown[] = [sheet];
  const manager = {
    // Đề xuất chi Năm: chưa tích dòng chính sách nào.
    find: jest.fn(async (entity: unknown) => (entity === SuggestPolicySupportItem ? [] : rows)),
    findOne: jest.fn().mockResolvedValue({ amount: 250_000, cashAccount: '1111' }),
    update: jest.fn(),
    // Bảng thu chi + xác nhận BBCS theo môn (mặc định chưa môn nào xác nhận).
    getRepository: jest.fn((entity: unknown) => ({
      find: jest
        .fn()
        .mockResolvedValue(entity === SchoolExpenseManagementConfirmation ? confirmations : sheets),
    })),
    setSheets: (value: unknown[]) => {
      sheets = value;
    },
    query: jest.fn(async (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      if (text.includes('FROM school_expenses')) return [{ id: 40 }];
      return [];
    }),
  };
  const row: Record<string, unknown> = { id: 5, code: 'DX-5', createdBy: 7, isMonthlyExpense };
  const service = Object.create(SuggestService.prototype) as SuggestService;
  Object.assign(service as object, {
    logger: { warn: jest.fn(), error: jest.fn() },
    expenseTransition: jest.fn(async (t) => {
      t.mutate?.(row);
      await t.extra?.(manager, row);
      row.data = t.logData ? await t.logData(manager, row) : {};
      return row;
    }),
    saveExpenseAttachments: jest.fn(),
    notifyExpense: jest.fn(),
  });
  const updates = () =>
    sql
      .filter((q) => q.text.includes('UPDATE management_expense_items'))
      .map((q) => q.params);
  const inserts = () =>
    sql
      .filter((q) => q.text.includes('INSERT INTO management_expense_suggest_payments'))
      .map((q) => q.params);
  return { service, manager, row, sql, updates, inserts };
}

describe('Đề xuất chi tháng đã chi → bảng Chi Ngoài', () => {
  it('ghi Đã chi cho đúng các dòng của trường + môn + kỳ, Ngày chi hôm nay, Nguồn chi của Thủ quỹ', async () => {
    const { service, row, sql, updates, inserts } = setup();
    await service.confirmSpent(5, sales, 'ok', []);

    // Khoá bảng Chi Ngoài trước khi ghi (cùng khoá với "Lưu" bảng).
    const lock = sql.find((q) => q.text.includes('FROM school_expenses'))!;
    expect(lock.text).toContain('FOR UPDATE');
    expect(lock.params).toEqual([[5], [3]]);

    expect(updates()).toEqual([
      [71, 100_000],
      [72, 150_000],
    ]);
    const today = vnToday();
    expect(inserts()).toEqual([
      [71, 5, 11, 100_000, today, '1111'],
      [72, 5, 11, 150_000, today, '1111'],
    ]);
    expect((row.data as any).chiNgoai).toEqual({
      paidDate: today,
      cashAccount: '1111',
      items: [
        {
          monthlyItemId: 11,
          label: 'TH A · Tin học · Tháng 9',
          amount: 250_000,
          unallocated: 0,
          rows: [
            { itemId: 71, schoolExpenseId: 40, rowIndex: 0, amount: 100_000 },
            { itemId: 72, schoolExpenseId: 40, rowIndex: 1, amount: 150_000 },
          ],
        },
      ],
    });
  });

  it('trường Giám đốc không duyệt không được ghi', async () => {
    const { service, updates } = setup([
      monthlyRow({ excluded: true, approvedAmount: null }),
    ]);
    await service.confirmSpent(5, sales, 'ok', []);
    expect(updates()).toEqual([]);
  });

  it('lệnh chi do Kế toán lập/sửa (không biết phần từng trường) → không ghi, ghi lý do vào lịch sử', async () => {
    const { service, row, updates, inserts } = setup([monthlyRow({ approvedAmount: null })]);
    await service.confirmSpent(5, sales, 'ok', []);
    expect(updates()).toEqual([]);
    expect(inserts()).toEqual([]);
    expect((row.data as any).chiNgoai.skipped).toContain('Kế toán');
  });

  it('đề xuất năm (không phải chi tháng) → không đụng bảng Chi Ngoài', async () => {
    const { service, row, sql } = setup([monthlyRow()], false);
    await service.confirmSpent(5, sales, 'ok', []);
    expect(sql).toEqual([]);
    expect(row.data).toEqual({});
  });

  it('bảng của trường không còn dòng nào → không ghi, lịch sử ghi số chưa ghi được', async () => {
    const { service, manager, row, updates } = setup();
    manager.setSheets([{ ...sheet, managementExpenseItems: [] }]);
    await service.confirmSpent(5, sales, 'ok', []);
    expect(updates()).toEqual([]);
    expect((row.data as any).chiNgoai.items[0]).toMatchObject({
      amount: 250_000,
      unallocated: 250_000,
      rows: [],
    });
  });

  it('bảng Chi Ngoài hiện Ngày chi / Nguồn chi / mã đề xuất của dòng đã ghi', async () => {
    const { service, manager } = setup();
    manager.query.mockImplementation(async (text: string) =>
      text.includes('FROM management_expense_suggest_payments')
        ? [{ item_id: 72, suggest_id: 5, code: 'DX-5', amount: '150000.00', paid_date: '2026-11-12', cash_account: '1121' }]
        : [],
    );
    const sections = await (service as any).loadSchoolManagementSections(
      5,
      3,
      { schoolYear: '2026-2027', subjectId: 8 },
      manager,
    );
    expect(sections[0].rows.map((r: any) => [r.itemId, r.paymentDate, r.cashAccount, r.suggestCodes])).toEqual([
      [71, null, null, undefined],
      [72, '2026-11-12', '1121', 'DX-5'],
    ]);
  });
  it('BBCS xác nhận theo môn: môn 8 đã xác nhận không làm môn 9 hiện đã xác nhận', async () => {
    const { service, manager } = setup([monthlyRow()], true, [{ schoolExpenseId: 40, subjectId: 8 }]);
    const sections = await (service as any).loadSchoolManagementSections(
      5,
      3,
      { schoolYear: '2026-2027' },
      manager,
    );
    const bySubject = Object.fromEntries(sections.map((s: any) => [s.subjectId, s.confirmed]));
    expect(bySubject).toEqual({ 8: true, 9: false });
  });
});
