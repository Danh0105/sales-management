import { DataSource } from 'typeorm';
import { AccountingSummaryService } from './accounting-summary.service';

describe('AccountingSummaryService', () => {
  const query = jest.fn();
  const service = new AccountingSummaryService({
    query,
  } as unknown as DataSource);

  beforeEach(() => query.mockReset());

  it('tổng hợp thu, chi, công nợ và số dư theo từng trường/kỳ', async () => {
    query.mockResolvedValue([
      {
        schoolExpenseId: '10',
        schoolId: '2',
        schoolName: 'Trường A',
        periodId: '20',
        periodName: 'Tháng 10/2026',
        month: '10',
        year: '2026',
        finalized: true,
        expectedRevenue: '1000.00',
        collectedRevenue: '700.00',
        receivable: '300.00',
        schoolExpense: '500.00',
        schoolExpensePaid: '400.00',
        schoolExpensePayable: '100.00',
        managementExpense: '200.00',
        managementExpensePaid: '150.00',
        managementExpensePayable: '50.00',
        cashPolicy: '25.00',
      },
      {
        schoolExpenseId: '11',
        schoolId: '3',
        schoolName: 'Trường B',
        periodId: '21',
        periodName: null,
        month: '10',
        year: '2026',
        finalized: false,
        expectedRevenue: '200.00',
        collectedRevenue: '100.00',
        receivable: '100.00',
        schoolExpense: '100.00',
        schoolExpensePaid: '100.00',
        schoolExpensePayable: '0.00',
        managementExpense: '0.00',
        managementExpensePaid: '0.00',
        managementExpensePayable: '0.00',
        cashPolicy: '5.00',
      },
    ]);

    const result = await service.getCashflowSummary({
      year: 2026,
      month: 10,
      schoolId: 2,
      subjectId: 7,
      finalized: true,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "subject_id" = $5'),
      [2026, 10, 2, true, 7],
    );
    expect(query.mock.calls[0][0]).toContain('subject_filter.school_id = s.id');
    expect(result.totals).toEqual({
      expectedRevenue: 1200,
      collectedRevenue: 800,
      receivable: 400,
      expectedExpense: 800,
      paidExpense: 650,
      payable: 150,
      cashPolicy: 30,
      projectedBalance: 400,
      projectedBalanceAfterPolicy: 370,
      cashBalance: 150,
    });
    expect(result.items[0]).toMatchObject({
      schoolExpenseId: 10,
      expense: {
        expected: 700,
        paid: 550,
        payable: 150,
      },
      projectedBalance: 300,
      projectedBalanceAfterPolicy: 275,
      cashBalance: 150,
    });
  });

  it('trả tổng bằng 0 khi chưa có kỳ thu chi', async () => {
    query.mockResolvedValue([]);

    const result = await service.getCashflowSummary({});

    expect(result.count).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.totals).toEqual({
      expectedRevenue: 0,
      collectedRevenue: 0,
      receivable: 0,
      expectedExpense: 0,
      paidExpense: 0,
      payable: 0,
      cashPolicy: 0,
      projectedBalance: 0,
      projectedBalanceAfterPolicy: 0,
      cashBalance: 0,
    });
  });
});
