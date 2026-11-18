import { BadRequestException } from '@nestjs/common';

import {
  allocateSuggestPayment,
  assertLinkedRowsKept,
  keepLinkedPaymentFields,
  LinkedManagementRow,
  loadLinkedManagementRows,
} from './suggest-payments';

const linkedRow = (overrides: Partial<LinkedManagementRow> = {}): LinkedManagementRow => ({
  paidAmount: 500_000,
  expenseDate: null,
  cashAccount: null,
  payments: {
    total: 500_000,
    latest: {
      suggestId: 9,
      suggestCode: 'DX-202611-0009',
      amount: 500_000,
      paidDate: '2026-11-12',
      cashAccount: '1111',
    },
    payments: [
      {
        suggestId: 9,
        suggestCode: 'DX-202611-0009',
        amount: 500_000,
        paidDate: '2026-11-12',
        cashAccount: '1111',
      },
    ],
  },
  ...overrides,
});

describe('Chia phần đã chi của một trường cho các dòng Chi Ngoài', () => {
  it('bảng không đổi từ lúc duyệt: mỗi dòng nhận đúng Còn chi', () => {
    expect(
      allocateSuggestPayment(
        [
          { itemId: 1, remaining: 300_000 },
          { itemId: 2, remaining: 0 },
          { itemId: 3, remaining: 200_000 },
        ],
        500_000,
      ),
    ).toEqual({
      allocations: [
        { itemId: 1, amount: 300_000 },
        { itemId: 3, amount: 200_000 },
      ],
      unallocated: 0,
    });
  });

  it('bảng tăng sau khi duyệt: chia theo thứ tự dòng, dòng sau còn Còn chi', () => {
    expect(
      allocateSuggestPayment(
        [
          { itemId: 1, remaining: 300_000 },
          { itemId: 2, remaining: 400_000 },
        ],
        500_000,
      ).allocations,
    ).toEqual([
      { itemId: 1, amount: 300_000 },
      { itemId: 2, amount: 200_000 },
    ]);
  });

  it('bảng giảm sau khi duyệt: phần dư cộng vào dòng cuối được chia (tiền đã chi thật)', () => {
    expect(
      allocateSuggestPayment(
        [
          { itemId: 1, remaining: 100_000 },
          { itemId: 2, remaining: 150_000.5 },
          { itemId: 3, remaining: -20_000 },
        ],
        300_000,
      ),
    ).toEqual({
      allocations: [
        { itemId: 1, amount: 100_000 },
        { itemId: 2, amount: 200_000 },
      ],
      unallocated: 0,
    });
  });

  it('không dòng nào còn Còn chi: ghi cả vào dòng cuối', () => {
    expect(
      allocateSuggestPayment(
        [
          { itemId: 1, remaining: 0 },
          { itemId: 2, remaining: -5 },
        ],
        80_000,
      ).allocations,
    ).toEqual([{ itemId: 2, amount: 80_000 }]);
  });

  it('bảng không còn dòng nào: không chia được, báo số chưa ghi', () => {
    expect(allocateSuggestPayment([], 80_000)).toEqual({
      allocations: [],
      unallocated: 80_000,
    });
  });

  it('số tiền 0 hoặc âm: không ghi gì', () => {
    expect(allocateSuggestPayment([{ itemId: 1, remaining: 10 }], 0)).toEqual({
      allocations: [],
      unallocated: 0,
    });
  });
});

describe('Dòng có tiền từ đề xuất chi', () => {
  it('giữ Ngày chi / Nguồn chi / Đã chi trên server, Còn lại theo Chi ngoài mới', () => {
    expect(
      keepLinkedPaymentFields(
        { paidAmount: 0, expenseDate: '2026-01-01', cashAccount: '1121', remaining: 9, note: 'x' },
        linkedRow({ paidAmount: 700_000, expenseDate: '2026-10-01', cashAccount: '1111' }),
        1_000_000,
      ),
    ).toEqual({
      paidAmount: 700_000,
      expenseDate: '2026-10-01',
      cashAccount: '1111',
      remaining: 300_000,
      note: 'x',
    });
  });

  it('bảng chưa khoá lưu lại mà thiếu dòng liên kết → báo lỗi kèm mã đề xuất', () => {
    const linked = new Map([[71, linkedRow()]]);
    expect(() => assertLinkedRowsKept(linked, [{ id: 72 }])).toThrow(BadRequestException);
    expect(() => assertLinkedRowsKept(linked, undefined)).toThrow('DX-202611-0009');
    expect(() => assertLinkedRowsKept(linked, [{ id: '71' }, {}])).not.toThrow();
  });

  it('đọc dòng liên kết: chỉ dòng có tiền từ đề xuất, cộng nhiều lần ghi', async () => {
    const query = jest.fn(async (sql: string) =>
      sql.includes('FROM management_expense_suggest_payments')
        ? [
            { item_id: 71, suggest_id: 9, code: 'DX-9', amount: '200000.00', paid_date: '2026-11-01', cash_account: '1111' },
            { item_id: 71, suggest_id: 10, code: 'DX-10', amount: '50000.50', paid_date: '2026-11-12', cash_account: '1121' },
          ]
        : [
            { id: 71, paid: '300000.50', expense_date: '2026-10-05', cash_account: '1111' },
            { id: 72, paid: '0', expense_date: null, cash_account: null },
          ],
    );
    const linked = await loadLinkedManagementRows({ query } as any, {
      schoolExpenseId: 4,
      subjectId: 8,
    });
    expect([...linked.keys()]).toEqual([71]);
    expect(linked.get(71)).toMatchObject({
      paidAmount: 300_000.5,
      expenseDate: '2026-10-05',
      payments: {
        total: 250_000.5,
        latest: { suggestCode: 'DX-10', paidDate: '2026-11-12', cashAccount: '1121' },
      },
    });
    expect(query.mock.calls[0][1]).toEqual([4, 8]);
  });
});
