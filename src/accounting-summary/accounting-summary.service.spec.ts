import { DataSource } from 'typeorm';
import { AccountingSummaryService } from './accounting-summary.service';

describe('AccountingSummaryService', () => {
  const query = jest.fn();
  const service = new AccountingSummaryService({
    query,
  } as unknown as DataSource);

  beforeEach(() => query.mockReset());

  it('tổng hợp thu, chi, công nợ và số dư theo từng trường/kỳ', async () => {
    query
      .mockResolvedValueOnce([
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
          invoiceTotal: '600.00',
          invoiceIssued: '350.00',
          invoiceNone: '50.00',
          invoiceCollected: '450.00',
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
      ])
      .mockResolvedValueOnce([
        {
          schoolExpenseId: '10',
          subjectId: '7',
          subjectName: 'STEM',
          studentCount: '20',
          totalPeriods: '36',
          expectedRevenue: '600.00',
          collectedRevenue: '500.00',
          receivable: '100.00',
          schoolExpense: '300.00',
          schoolExpensePaid: '250.00',
          schoolExpensePayable: '50.00',
          schoolOnlyExpense: '240.00',
          schoolOnlyPaid: '200.00',
          schoolTeacherExpense: '60.00',
          managementExpense: '100.00',
          managementExpensePaid: '75.00',
          managementExpensePayable: '25.00',
          outsideExpense: '80.00',
          outsidePaid: '60.00',
          otherExpense: '20.00',
          companyTeacherExpense: '30.00',
          annualPolicyExpense: '10.00',
          invoiceTotal: '400.00',
          invoiceIssued: '250.00',
          invoiceNone: '50.00',
          invoiceCollected: '300.00',
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
      invoiceTotal: 600,
      invoiceIssued: 350,
      invoiceNotIssued: 200,
      invoiceNone: 50,
      invoiceCollected: 450,
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
      // Đã xuất 350 + chưa xuất 200 + không xuất HĐ 50 = tổng 600.
      invoice: { total: 600, issued: 350, notIssued: 200, noInvoice: 50, collected: 450 },
      subjects: [
        {
          subject: { id: 7, name: 'STEM' },
          quantity: { students: 20, periods: 36 },
          revenue: { expected: 600, collected: 500, receivable: 100 },
          expense: {
            expected: 400,
            paid: 325,
            payable: 75,
          },
          invoice: { total: 400, issued: 250, notIssued: 100, noInvoice: 50, collected: 300 },
          breakdown: {
            school: { expected: 240, paid: 200 },
            outside: { expected: 80, paid: 60 },
            schoolTeacher: 60,
            companyTeacher: 30,
            annualPolicy: 10,
            other: 20,
            profit: 160,
          },
        },
      ],
    });
    // Trường chưa có dòng hóa đơn: các số hóa đơn bằng 0.
    expect(result.items[1].invoice).toEqual({
      total: 0,
      issued: 0,
      notIssued: 0,
      noInvoice: 0,
      collected: 0,
    });
    // Hóa đơn tính theo dòng Chi Trường cùng vị trí, lọc môn theo bảng Doanh Thu.
    const sql = query.mock.calls[0][0] as string;
    // Đã thu = Số tiền thu/chi của dòng Hóa Đơn chọn "Thu", ở cả bảng lẫn từng môn.
    for (const call of query.mock.calls) {
      expect(call[0]).toContain(
        `SUM(r."invoiceCashAmount") FILTER (
            WHERE r."invoiceCashDirection" = 'IN'`,
      );
    }
    expect(sql).toContain('sei."rowIndex" = r."rowIndex"');
    expect(sql).toContain('WHERE r."subject_id" = $5');
  });

  it('trả tổng bằng 0 khi chưa có kỳ thu chi', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

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
      invoiceTotal: 0,
      invoiceIssued: 0,
      invoiceNotIssued: 0,
      invoiceNone: 0,
      invoiceCollected: 0,
      projectedBalance: 0,
      projectedBalanceAfterPolicy: 0,
      cashBalance: 0,
    });
  });
});
