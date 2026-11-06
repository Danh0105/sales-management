import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';

import { RolesGuard } from '../auth/role-guard';
import { ExpenseRole } from './constants/expense-roles';
import { ExpenseRequestController } from './expense-request.controller';
import { buildManagementViewSections } from './expense-management-view';
import { SuggestType } from './enums/suggest-type.enum';
import { SuggestService } from './suggest.service';

const subject = (id: number, schoolYear = '2026-2027', name = 'STEM') => ({
  id,
  name,
  schoolYear,
  catalog: { name },
});

const revenue = (rowIndex: number, subjectRef: unknown, extra = {}) => ({
  rowIndex,
  subject: subjectRef,
  content: `Doanh thu ${rowIndex}`,
  totalPeriods: '35',
  studentCount: '100',
  monthsCount: '0.5',
  ...extra,
});

const item = (rowIndex: number, subjectRef: unknown, extra = {}) => ({
  rowIndex,
  subject: subjectRef,
  ql1UnitPrice: '10000',
  ql1Tax: '1000',
  ql2UnitPrice: '5000',
  ql2Tax: '0',
  otherCosts: [],
  paidAmount: '100000',
  totalOutside: '999',
  ...extra,
});

describe('buildManagementViewSections', () => {
  const s1 = subject(1);

  it('dòng đi kèm Doanh Thu dùng số lượng của Doanh Thu, tính lại thay vì dùng số đã lưu', () => {
    const [section] = buildManagementViewSections(
      [
        {
          id: 9,
          period: { id: 3, name: 'Tháng 9', month: 10, year: 2026 },
          managementExpenseItems: [
            item(0, s1, { totalPeriods: '1', studentCount: '1', monthsCount: '1' }),
          ],
          revenueItems: [revenue(0, s1)],
        },
      ],
      { schoolYear: '2026-2027' },
    );
    const row = section.rows[0];
    expect(row).toMatchObject({
      content: 'Doanh thu 0',
      standalone: false,
      studentCount: 100,
      monthsCount: 0.5,
      ql1Expense: 450000,
      ql2Expense: 250000,
      totalOutside: 700000,
      paidAmount: 100000,
      remaining: 600000,
    });
    expect(section).toMatchObject({
      periodName: 'Tháng 9',
      subjectName: 'STEM',
      totals: { totalOutside: 700000, paidAmount: 100000, remaining: 600000 },
    });
  });

  it('dòng thêm riêng tự giữ nội dung và số lượng, không có học sinh thì tính theo tiết', () => {
    const [section] = buildManagementViewSections(
      [
        {
          id: 9,
          period: { id: 3 },
          managementExpenseItems: [
            item(5, s1, {
              content: 'Chi thêm',
              totalPeriods: '10',
              studentCount: '0',
              monthsCount: '2',
            }),
            item(6, s1, { totalPeriods: '1', studentCount: '0', monthsCount: '1' }),
          ],
          revenueItems: [revenue(0, s1)],
        },
      ],
      {},
    );
    expect(section.rows[0]).toMatchObject({
      standalone: true,
      content: 'Chi thêm',
      ql1Expense: 180000,
    });
    expect(section.rows[1].content).toBe('Chi ngoài bổ sung');
  });

  it('chi khác trừ thuế, không âm, cộng vào Chi ngoài và tạo cột riêng', () => {
    const [section] = buildManagementViewSections(
      [
        {
          id: 9,
          period: { id: 3 },
          managementExpenseItems: [
            item(0, s1, {
              ql1UnitPrice: '0',
              ql1Tax: '0',
              ql2UnitPrice: '0',
              otherCosts: [
                { policyOtherCostId: 7, name: 'Bảo vệ', unitPrice: '3000', tax: '500' },
                { policyOtherCostId: 8, name: 'Thuế cao', unitPrice: '100', tax: '900' },
              ],
            }),
          ],
          revenueItems: [revenue(0, s1, { monthsCount: '1' })],
        },
      ],
      {},
    );
    expect(section.rows[0].otherCosts.map((c) => c.expense)).toEqual([250000, 0]);
    expect(section.rows[0].totalOutside).toBe(250000);
    expect(section.otherCostColumns).toEqual([
      { key: 'policy:7', name: 'Bảo vệ' },
      { key: 'policy:8', name: 'Thuế cao' },
    ]);
    expect(section.totals.otherCostExpenses['policy:7']).toBe(250000);
  });

  it('lọc theo năm học và môn, kỳ mới nhất đứng trước', () => {
    const oldYear = subject(2, '2025-2026');
    const s3 = subject(3, '2026-2027', 'Kỹ năng sống');
    const sheets = [
      {
        id: 1,
        period: { id: 1, month: 9, year: 2026 },
        managementExpenseItems: [item(0, s1), item(0, oldYear), item(0, s3)],
        revenueItems: [],
      },
      {
        id: 2,
        period: { id: 2, month: 13, year: 2026 },
        managementExpenseItems: [item(0, s1)],
        revenueItems: [],
      },
    ];
    const year = buildManagementViewSections(sheets, { schoolYear: '2026-2027' });
    expect(year.map((x) => [x.schoolExpenseId, x.subjectId])).toEqual([
      [2, 1],
      [1, 1],
      [1, 3],
    ]);
    const monthly = buildManagementViewSections([sheets[0]], {
      schoolYear: '2026-2027',
      subjectId: 3,
    });
    expect(monthly.map((x) => x.subjectId)).toEqual([3]);
  });

  it('không có dòng nào thì không có bảng', () => {
    expect(
      buildManagementViewSections(
        [{ id: 1, period: {}, managementExpenseItems: [], revenueItems: [] }],
        {},
      ),
    ).toEqual([]);
  });
});

describe('Quyền xem bảng Chi Ngoài', () => {
  const canAccess = (roles: string[]) =>
    new RolesGuard(new Reflector()).canActivate({
      getHandler: () => ExpenseRequestController.prototype.managementExpense,
      getClass: () => ExpenseRequestController,
      switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
    } as unknown as ExecutionContext);

  it.each(['director', 'saleadmin', 'ketoan_congno', 'ketoan_truong', 'thuquy'])(
    '%s đọc được',
    (role) => {
      expect(canAccess([role])).toBe(true);
    },
  );

  it.each(['sales', 'giaovien_congty', 'nhansu', 'director_la'])(
    '%s không đọc được',
    (role) => {
      expect(canAccess([role])).toBe(false);
    },
  );

  const makeDetail = () => {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      repo: {
        findOne: jest.fn().mockResolvedValue({
          id: 5,
          type: SuggestType.EXPENSE_REQUEST,
          requestKind: 'CASH',
          createdBy: 7,
        }),
      },
      historyRepo: {
        find: jest.fn().mockResolvedValue([
          {
            id: 1,
            userId: 9,
            action: 'APPROVE',
            data: { amount: 5, managementExpense: { sections: [{ id: 1 }] } },
          },
        ]),
      },
      employeeRepo: { findBy: jest.fn().mockResolvedValue([]) },
    });
    return service;
  };

  it('giám đốc thấy ảnh chụp trong lịch sử', async () => {
    const res = await makeDetail().findOneExpense(5, {
      id: 1,
      roles: [ExpenseRole.DIRECTOR],
    } as never);
    expect(res.logs[0].data).toHaveProperty('managementExpense');
  });

  it.each([
    ['sales', { id: 7, roles: [ExpenseRole.SALES] }],
    ['không rõ người gọi', undefined],
  ])('%s không nhận ảnh chụp, các thông tin khác giữ nguyên', async (_n, actor) => {
    const res = await makeDetail().findOneExpense(5, actor as never);
    expect(res.logs[0].data).toEqual({ amount: 5 });
  });
});

describe('Ảnh chụp lúc Giám đốc quyết định', () => {
  const make = (load: jest.Mock) => {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    const transition = jest.fn(async (opts) => {
      const data = opts.logData
        ? await opts.logData({ findOne: jest.fn().mockResolvedValue({ id: 3, amount: 1 }) }, { id: 5 })
        : {};
      return { id: 5, code: 'DX-1', status: 'X', createdBy: 7, data };
    });
    Object.assign(service as object, {
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 5, isMonthlyExpense: true, schoolId: 467 }),
      },
      loadManagementExpenseSections: load,
      expenseTransition: transition,
      notifyExpense: jest.fn(),
      logger: { error: jest.fn() },
      expenseApproverLabel: jest.fn().mockReturnValue('Giám đốc'),
    });
    return { service, transition };
  };
  const user = { id: 1, roles: [ExpenseRole.DIRECTOR] } as never;

  it('lưu bảng khi duyệt đề xuất tháng', async () => {
    const { service } = make(jest.fn().mockResolvedValue([{ subjectId: 1 }]));
    const saved: any = await service.approveExpense(5, user, {} as never);
    expect(saved.data.managementExpense.sections).toEqual([{ subjectId: 1 }]);
    expect(saved.data.managementExpense.capturedAt).toEqual(expect.any(String));
  });

  it('lưu bảng khi từ chối', async () => {
    const { service } = make(jest.fn().mockResolvedValue([{ subjectId: 1 }]));
    const saved: any = await service.rejectExpense(5, user, 'Sai');
    expect(saved.data.managementExpense.sections).toHaveLength(1);
  });

  it('lỗi đọc bảng không chặn được việc duyệt', async () => {
    const { service, transition } = make(
      jest.fn().mockRejectedValue(new Error('db')),
    );
    const saved: any = await service.approveExpense(5, user, {} as never);
    expect(transition).toHaveBeenCalled();
    expect(saved.data.managementExpense).toBeUndefined();
  });
});
