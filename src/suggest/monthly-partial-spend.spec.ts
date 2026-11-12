import { BadRequestException, ConflictException, ForbiddenException, ValidationPipe } from '@nestjs/common';

import { mapSuggestEvents, SuggestEventRow } from '../cashflow-report/cashflow-sources';
import { toCents } from '../cashflow-report/cashflow-money';
import { ExpenseRole } from './constants/expense-roles';
import { ConfirmPartiallySpentDto } from './dto/expense/confirm-partially-spent.dto';
import { SuggestMonthlyItem } from './entities/suggest-monthly-item.entity';
import { SuggestPaymentOrder } from './entities/suggest-payment-order.entity';
import { ExpenseAction } from './enums/expense-action.enum';
import { ExpenseRequestKind } from './enums/expense-request-kind.enum';
import {
  assertExpenseTransition,
  expenseActorForStatus,
} from './expense-flow.state-machine';
import { monthlyItemAmounts, partialSpendSummary, selectApprovedItems } from './monthly-expense-items';
import { SuggestStatus } from './SuggestStatus.enum';
import { SuggestService } from './suggest.service';

const sales = { id: 7, roles: [ExpenseRole.SALES] } as never;
const treasurer = { id: 3, roles: [ExpenseRole.TREASURER] } as never;

const rows = [
  { id: 11, approvedAmount: 800_000, school: { name: 'TH A' }, subject: { name: 'Tin học' }, expensePeriod: { name: 'Tháng 9' } },
  { id: 12, approvedAmount: 500_000, school: { name: 'TH B' }, subject: { name: 'Anh văn' }, expensePeriod: { name: 'Tháng 9' } },
  { id: 13, approvedAmount: 200_000, school: { name: 'TH C' }, subject: { name: 'STEM' }, expensePeriod: { name: 'Tháng 9' } },
];

describe('Luồng chi một phần', () => {
  it('nhận tiền → chi một phần → Thủ quỹ nhận phần dư → Đã chi', () => {
    let status = assertExpenseTransition(
      ExpenseAction.CONFIRM_PARTIALLY_SPENT,
      SuggestStatus.CASH_RECEIVED,
      { actorRoles: [ExpenseRole.SALES], isOwner: true },
    );
    expect(status).toBe(SuggestStatus.PARTIALLY_SPENT);
    status = assertExpenseTransition(
      ExpenseAction.CONFIRM_REMAINDER_RETURNED,
      status,
      { actorRoles: [ExpenseRole.TREASURER], isOwner: false },
    );
    expect(status).toBe(SuggestStatus.SPENT);
  });

  it('chỉ chủ đơn chi một phần, chỉ Thủ quỹ/Kế toán trưởng nhận phần dư', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CONFIRM_PARTIALLY_SPENT,
        SuggestStatus.CASH_RECEIVED,
        { actorRoles: [ExpenseRole.SALES], isOwner: false },
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CONFIRM_REMAINDER_RETURNED,
        SuggestStatus.PARTIALLY_SPENT,
        { actorRoles: [ExpenseRole.DEBT_ACCOUNTANT], isOwner: false },
      ),
    ).toThrow(ForbiddenException);
  });

  it('chưa nhận tiền thì chưa chi một phần được; thiết bị không có bước này', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CONFIRM_PARTIALLY_SPENT,
        SuggestStatus.CASH_RELEASED,
        { actorRoles: [ExpenseRole.SALES], isOwner: true },
      ),
    ).toThrow(ConflictException);
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CONFIRM_PARTIALLY_SPENT,
        SuggestStatus.CASH_RECEIVED,
        { actorRoles: [ExpenseRole.SALES], isOwner: true, kind: ExpenseRequestKind.EQUIPMENT },
      ),
    ).toThrow(ConflictException);
  });

  it('chờ phần dư thì việc nằm ở Thủ quỹ', () => {
    expect(expenseActorForStatus(SuggestStatus.PARTIALLY_SPENT)).toEqual({
      roles: [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT],
      owner: false,
    });
  });
});

describe('Chia lệnh chi theo trường', () => {
  it('phần của từng dòng = Còn chi các bảng đúng trường + môn + kỳ', () => {
    const sections = [
      { schoolId: 1, subjectId: 10, periodId: 100, totals: { remaining: 300 } },
      { schoolId: 1, subjectId: 10, periodId: 100, totals: { remaining: 0.25 } },
      { schoolId: 2, subjectId: 20, periodId: 200, totals: { remaining: 500 } },
      { schoolId: 1, subjectId: 11, periodId: 100, totals: { remaining: 999 } },
    ] as never;
    expect(
      monthlyItemAmounts(
        [
          { schoolId: 1, subjectId: 10, expensePeriodId: 100 },
          { schoolId: 2, subjectId: 20, expensePeriodId: 200 },
        ],
        sections,
      ),
    ).toEqual([300.25, 500]);
  });

  it('số đã chi = phần các trường đã chọn, phần dư = lệnh chi − số đã chi', () => {
    expect(partialSpendSummary(rows, 1_500_000, [11])).toEqual({
      spentAmount: 800_000,
      returnAmount: 700_000,
    });
    expect(partialSpendSummary(rows, 1_500_000, [12, 13])).toEqual({
      spentAmount: 700_000,
      returnAmount: 800_000,
    });
  });

  it.each([
    ['không chọn trường nào', rows, 1_500_000, [], 'Chọn ít nhất một trường'],
    ['chọn hết', rows, 1_500_000, [11, 12, 13], 'chọn "Đã chi"'],
    ['chọn trùng', rows, 1_500_000, [11, 11], 'Chọn trùng'],
    ['trường của đề xuất khác', rows, 1_500_000, [99], 'không thuộc đề xuất'],
    ['chỉ có một trường', rows.slice(0, 1), 800_000, [11], 'chỉ có một trường'],
    [
      'lệnh chi do Kế toán lập',
      rows.map((row) => ({ ...row, approvedAmount: null })),
      1_500_000,
      [11],
      'do Kế toán lập',
    ],
    ['lệnh chi đã đổi số tiền', rows, 1_400_000, [11], 'đã đổi sau khi Giám đốc duyệt'],
    [
      'trường đã chọn không có tiền',
      [{ id: 1, approvedAmount: 0 }, { id: 2, approvedAmount: 500 }],
      500,
      [1],
      'không có tiền chi',
    ],
  ])('từ chối khi %s', (_name, items, amount, ids, message) => {
    expect(() => partialSpendSummary(items as never, amount, ids)).toThrow(message);
  });
});

describe('Giám đốc chọn trường duyệt', () => {
  it('bỏ trống = duyệt tất cả; chọn bớt thì tổng chỉ gồm trường được chọn', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(selectApprovedItems(items, [100, 200, 300.5]).total).toBe(600.5);
    const picked = selectApprovedItems(items, [100, 200, 300.5], [1, 3]);
    expect([...picked.approvedIds]).toEqual([1, 3]);
    expect(picked.total).toBe(400.5);
  });
});

describe('DTO chi một phần', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata = { type: 'body' as const, metatype: ConfirmPartiallySpentDto };

  it('đọc danh sách từ chuỗi JSON của multipart', async () => {
    await expect(
      pipe.transform({ spentItemIds: '["11","13"]', reason: 'TH B nghỉ' }, metadata),
    ).resolves.toEqual({ spentItemIds: [11, 13], reason: 'TH B nghỉ' });
  });

  it.each([
    [{ spentItemIds: '[]', reason: 'x' }],
    [{ spentItemIds: '["a"]', reason: 'x' }],
    [{ spentItemIds: '[11]', reason: '' }],
  ])('từ chối %j', async (body) => {
    await expect(pipe.transform(body, metadata)).rejects.toThrow(BadRequestException);
  });
});

describe('Kinh doanh chi một phần', () => {
  const make = (order: unknown, isMonthlyExpense = true) => {
    const manager = {
      find: jest.fn().mockResolvedValue(rows),
      findOne: jest.fn().mockResolvedValue(order),
      update: jest.fn(),
    };
    const row: Record<string, unknown> = { id: 5, code: 'DX-1', createdBy: 7, isMonthlyExpense };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      expenseTransition: jest.fn(async (t) => {
        t.mutate?.(row);
        await t.extra?.(manager, row);
        row.data = t.logData ? await t.logData(manager, row) : {};
        return row;
      }),
      saveExpenseAttachments: jest.fn(),
      notifyExpense: jest.fn(),
      // Ghi sang bảng Chi Ngoài: có spec riêng (chi-ngoai-from-suggest.spec.ts).
      recordChiNgoaiPayments: jest.fn().mockResolvedValue(null),
    });
    return { service, manager, row };
  };

  it('ghi trường đã chi/không chi, lưu số đã chi + phần dư, báo Thủ quỹ', async () => {
    const { service, manager } = make({ amount: 1_500_000 });
    const saved: any = await service.confirmPartiallySpent(5, sales, [11, 13], 'TH B nghỉ học', []);

    expect(manager.update).toHaveBeenCalledWith(SuggestMonthlyItem, { id: 11 }, { spent: true });
    expect(manager.update).toHaveBeenCalledWith(SuggestMonthlyItem, { id: 12 }, { spent: false });
    expect(manager.update).toHaveBeenCalledWith(SuggestMonthlyItem, { id: 13 }, { spent: true });
    expect(saved.notSpentReason).toBe('TH B nghỉ học');
    expect(saved.data.partialSpend).toMatchObject({
      spentAmount: 1_000_000,
      returnAmount: 500_000,
      items: [
        { id: 11, label: 'TH A · Tin học · Tháng 9', amount: 800_000, spent: true },
        { id: 12, spent: false },
        { id: 13, spent: true },
      ],
    });
    const notify = (service as never as { notifyExpense: jest.Mock }).notifyExpense;
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('chi 2/3 trường') as unknown,
      }),
      { roles: [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT] },
    );
    expect(notify.mock.calls[0][0].message).toContain('500.000 đ');
    // Chỉ các trường đã tích được ghi Đã chi sang Chi Ngoài.
    const record = (service as never as { recordChiNgoaiPayments: jest.Mock })
      .recordChiNgoaiPayments;
    expect(record.mock.calls[0][2].map((r: { id: number }) => r.id)).toEqual([11, 13]);
  });

  it('trường Giám đốc không duyệt không tham gia chi một phần', async () => {
    const { service, manager } = make({ amount: 1_300_000 });
    manager.find.mockResolvedValue([
      ...rows.slice(0, 2),
      { ...rows[2], approvedAmount: null, excluded: true },
    ]);
    const saved: any = await service.confirmPartiallySpent(5, sales, [11], 'TH B nghỉ', []);
    expect(saved.data.partialSpend).toMatchObject({ spentAmount: 800_000, returnAmount: 500_000 });
    expect(saved.data.partialSpend.items).toHaveLength(2);
    expect(manager.update).not.toHaveBeenCalledWith(SuggestMonthlyItem, { id: 13 }, expect.anything());
  });

  it('chọn sai thì không ghi gì', async () => {
    const { service, manager } = make({ amount: 1_500_000 });
    await expect(
      service.confirmPartiallySpent(5, sales, [11, 12, 13], 'x', []),
    ).rejects.toThrow('chọn "Đã chi"');
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('chi Năm không có bước này', async () => {
    const { service } = make({ amount: 1_500_000 }, false);
    await expect(
      service.confirmPartiallySpent(5, sales, [11], 'x', []),
    ).rejects.toThrow('Chỉ đề xuất chi tháng');
  });
});

describe('Thủ quỹ nhận lại phần dư', () => {
  it('ghi đúng phần dư + tài khoản để sổ quỹ ghi thu, báo chủ đơn', async () => {
    const manager = {
      find: jest.fn().mockResolvedValue(
        rows.map((row) => ({ ...row, spent: row.id !== 12 })),
      ),
      findOne: jest.fn().mockResolvedValue({ amount: 1_500_000, cashAccount: '1121' }),
    };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      expenseTransition: jest.fn(async (t) => {
        const row: Record<string, unknown> = { id: 5, code: 'DX-1', createdBy: 7 };
        await t.extra?.(manager, row);
        row.data = await t.logData(manager, row);
        return row;
      }),
      notifyExpense: jest.fn(),
    });
    const saved: any = await service.confirmRemainderReturned(5, treasurer);
    expect(saved.data).toEqual({ returnAmount: 500_000, cashAccount: '1121' });
    expect(
      (service as never as { notifyExpense: jest.Mock }).notifyExpense,
    ).toHaveBeenCalledWith(expect.anything(), { userIds: [7] });
  });
});

describe('Kế toán lập/sửa lệnh chi xoá phần chia theo trường', () => {
  it('sửa số tiền chi tháng thì không chi một phần theo số cũ được nữa', async () => {
    const manager = {
      findOne: jest.fn().mockResolvedValue({ id: 31, suggestId: 5, amount: 1 }),
      save: jest.fn(async (_entity, data) => data),
      update: jest.fn(),
    };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      repo: { findOne: jest.fn().mockResolvedValue({ id: 5, isMonthlyExpense: true }) },
      expenseTransition: jest.fn(async (t) => {
        const row = { id: 5, isMonthlyExpense: true };
        t.mutate?.(row);
        await t.extra?.(manager, row);
        return row;
      }),
      notifyExpense: jest.fn(),
    });
    await service.editExpensePaymentOrder(
      5,
      { amount: 2000, paymentMethod: 'CASH' } as never,
      { id: 9, roles: [ExpenseRole.DEBT_ACCOUNTANT] } as never,
    );
    expect(manager.update).toHaveBeenCalledWith(
      SuggestMonthlyItem,
      { suggestId: 5 },
      { approvedAmount: null, spent: null },
    );
    expect(manager.save).toHaveBeenCalledWith(SuggestPaymentOrder, expect.anything());
  });
});

describe('Sổ quỹ khi chi một phần', () => {
  let historyId = 1000;
  const event = (action: string, date: string, data: unknown = null): SuggestEventRow => ({
    history_id: ++historyId,
    suggest_id: 5,
    action,
    event_date: date,
    data: data as never,
    suggest_code: 'DX-1',
    content: 'Chi tháng 3 trường',
    requester_id: 7,
    requester_name: 'NV',
    po_code: 'LC-1',
    po_amount: '1500000.00',
    po_cash_account: '1121',
    po_created_date: '2026-11-09',
  });

  it('chi đủ số đã xuất, thu đúng phần dư về cùng tài khoản', () => {
    const { lines, issues } = mapSuggestEvents([
      event('APPROVE_MONTHLY', '2026-11-09', { paymentOrder: { code: 'LC-1', amount: 1_500_000 } }),
      event('CONFIRM_CASH_RELEASED', '2026-11-10', { cashAccount: '1121' }),
      event('CONFIRM_REMAINDER_RETURNED', '2026-11-12', { returnAmount: 500_000, cashAccount: '1121' }),
    ]);
    expect(issues).toEqual([]);
    expect(lines.map((line) => [line.postingDate, line.accountCode, line.payment, line.receipt])).toEqual([
      ['2026-11-10', '1121', toCents('1500000'), 0n],
      ['2026-11-12', '1121', 0n, toCents('500000')],
    ]);
    expect(lines[1].description).toContain('Hoàn phần dư');
  });
});
