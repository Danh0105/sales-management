import { toCents } from './cashflow-money';
import {
  ExpenseRow,
  FINANCIAL_MOVEMENTS_SQL,
  FinancialMovementRow,
  flagSuspiciousAmounts,
  InvoiceRow,
  mapExpenseRows,
  mapFinancialMovements,
  mapInvoiceRows,
  mapSuggestEvents,
  SuggestEventRow,
} from './cashflow-sources';

const context = {
  school_expense_id: 12,
  school_id: 3,
  school_name: 'TH Đông Hòa',
  subject_id: 5,
  subject_name: 'STEM',
  period_month: 10,
  period_year: 2026,
  row_index: 0,
};

const invoice = (overrides: Partial<InvoiceRow> = {}): InvoiceRow => ({
  ...context,
  content: 'Chương trình giáo dục STEM',
  invoice_number: '0001234',
  invoice_date: '2026-10-02',
  cash_date: '2026-10-05',
  cash_account: '1121',
  cash_direction: 'IN',
  cash_amount: '87100000.00',
  paid_amount: '87100000.00',
  ...overrides,
});

const financialMovement = (
  overrides: Partial<FinancialMovementRow> = {},
): FinancialMovementRow => ({
  direction: 'PAYMENT',
  movement_id: 41,
  request_id: 9,
  request_code: 'TT-2026-00009',
  request_type: 'EXPENSE_PAYMENT',
  title: 'Thanh toán chi phí sự kiện',
  posting_date: '2026-10-30',
  cash_account: '1121',
  amount: '2500000',
  transaction_ref: 'FT-123456',
  requester_id: 22,
  requester_code: 'NV0022',
  requester_name: 'Nguyễn Văn A',
  ...overrides,
});

describe('mapInvoiceRows', () => {
  it('khoản thu đầy đủ → bút toán thu, giữ số hóa đơn có số 0 ở đầu', () => {
    const { lines, issues } = mapInvoiceRows([invoice()]);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      key: 'INVOICE:12:5:0',
      postingDate: '2026-10-05',
      documentDate: '2026-10-02',
      documentNo: 'HD-12-5-1',
      invoiceNo: '0001234',
      accountCode: '1121',
      receipt: toCents('87100000'),
      payment: 0n,
      partnerCode: 'TR3',
      partnerName: 'TH Đông Hòa',
      source: {
        type: 'INVOICE',
        schoolExpenseId: 12,
        subjectId: 5,
        rowIndex: 0,
      },
    });
    expect(lines[0].description).toContain('Thu Chương trình giáo dục STEM');
  });

  it('khoản chi trên Hóa Đơn → bút toán chi; Đã thu chưa ghi tài khoản → cảnh báo', () => {
    const { lines, issues } = mapInvoiceRows([
      invoice({ cash_direction: 'OUT', cash_amount: '5000000.00' }),
    ]);
    expect(lines[0].payment).toBe(toCents('5000000'));
    expect(lines[0].receipt).toBe(0n);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'RECEIPT_NOT_POSTED',
      warningOnly: true,
    });
  });

  it('thiếu thông tin → từng lỗi riêng, không tạo bút toán', () => {
    const { lines, issues } = mapInvoiceRows([
      invoice({
        cash_direction: null,
        cash_amount: null,
        cash_date: null,
        paid_amount: '0',
      }),
    ]);
    expect(lines).toEqual([]);
    expect(issues.map((item) => item.kind).sort()).toEqual([
      'MISSING_AMOUNT',
      'MISSING_DATE',
      'MISSING_DIRECTION',
    ]);
  });

  it('có Đã thu nhưng chưa ghi gì ở Hóa Đơn → chỉ cảnh báo, không đoán tài khoản', () => {
    const { lines, issues } = mapInvoiceRows([
      invoice({
        cash_direction: null,
        cash_amount: null,
        cash_account: null,
        cash_date: null,
      }),
    ]);
    expect(lines).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('RECEIPT_NOT_POSTED');
    expect(issues[0].amount).toBe(toCents('87100000'));
  });
});

const expense = (overrides: Partial<ExpenseRow> = {}): ExpenseRow => ({
  ...context,
  paid_amount: '26044800.00',
  expense_date: '2026-10-10',
  cash_account: '1111',
  ...overrides,
});

describe('mapExpenseRows', () => {
  it('Chi Trường đủ thông tin → bút toán chi', () => {
    const { lines, issues } = mapExpenseRows([expense()], 'SCHOOL_EXPENSE');
    expect(issues).toEqual([]);
    expect(lines[0]).toMatchObject({
      documentNo: 'CT-12-5-1',
      accountCode: '1111',
      payment: toCents('26044800'),
      receipt: 0n,
    });
  });

  it('Chi Ngoài thiếu Nguồn chi / Ngày chi → lỗi; chưa có Đã chi → bỏ qua', () => {
    const { lines, issues } = mapExpenseRows(
      [
        expense({ cash_account: null, payer: 'Lan' }),
        expense({ row_index: 1, expense_date: null }),
        expense({ row_index: 2, paid_amount: '0.00' }),
      ],
      'MANAGEMENT_EXPENSE',
    );
    expect(lines).toEqual([]);
    expect(issues.map((item) => item.kind)).toEqual([
      'MISSING_ACCOUNT',
      'MISSING_DATE',
    ]);
    expect(issues[0].description).toContain('Người chi: Lan');
  });
});

let historyId = 0;
const event = (
  action: string,
  event_date: string,
  overrides: Partial<SuggestEventRow> = {},
): SuggestEventRow => {
  historyId += 1;
  return {
    history_id: historyId,
    suggest_id: 76,
    action,
    event_date,
    data: null,
    suggest_code: 'DX-0076',
    content: 'Mua dụng cụ',
    requester_id: 22,
    requester_name: 'Thái Thị Như Ý',
    po_code: 'LC-202608-0001',
    po_amount: '3000000.00',
    po_cash_account: '1111',
    po_created_date: '2026-08-11',
    ...overrides,
  };
};

describe('mapSuggestEvents', () => {
  it('chi tháng: chi lại sau hoàn quỹ giữ đúng số tiền từng vòng', () => {
    const { lines, issues } = mapSuggestEvents([
      event('CREATE_MONTHLY_PAYMENT_ORDER', '2026-08-11', {
        data: { paymentOrder: { code: 'LC-1', amount: 1000000 } },
      }),
      event('CONFIRM_CASH_RELEASED', '2026-08-13', {
        data: { cashAccount: '1112' },
      }),
      event('CONFIRM_FUND_RETURNED', '2026-08-14'),
      event('CREATE_MONTHLY_PAYMENT_ORDER', '2026-08-15', {
        data: { paymentOrder: { code: 'LC-2', amount: 3000000 } },
      }),
      event('CONFIRM_CASH_RELEASED', '2026-08-16', {
        data: { cashAccount: '1112' },
      }),
    ]);
    expect(issues).toEqual([]);
    const payments = lines
      .filter((line) => line.payment > 0)
      .map((line) => line.payment);
    expect(payments).toEqual([toCents('1000000'), toCents('3000000')]);
    expect(lines.filter((line) => line.receipt > 0).map((l) => l.receipt)).toEqual([
      toCents('1000000'),
    ]);
  });

  it('chi tháng: kế toán sửa số tiền rồi xuất lại thì lấy số tiền mới', () => {
    const { lines } = mapSuggestEvents([
      event('CREATE_MONTHLY_PAYMENT_ORDER', '2026-08-11', {
        data: { paymentOrder: { code: 'LC-1', amount: 1000000 } },
      }),
      event('EDIT_MONTHLY_PAYMENT_ORDER', '2026-08-12'),
      event('CONFIRM_CASH_RELEASED', '2026-08-13', {
        data: { cashAccount: '1112' },
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].payment).toBe(toCents('3000000'));
  });

  it('xuất tiền có tài khoản → bút toán chi, đối tượng là người đề xuất', () => {
    const { lines, issues } = mapSuggestEvents([
      event('CREATE_PAYMENT_ORDER', '2026-08-11', {
        data: { paymentOrder: { code: 'LC-202608-0001', amount: 2500000 } },
      }),
      event('CONFIRM_CASH_RELEASED', '2026-08-13', {
        data: { cashAccount: '1112' },
      }),
    ]);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      postingDate: '2026-08-13',
      documentNo: 'LC-202608-0001',
      accountCode: '1112',
      payment: toCents('2500000'),
      partnerCode: 'NV22',
      source: { type: 'EXPENSE_REQUEST', suggestId: 76 },
    });
  });

  it('bản ghi cũ chỉ có nhóm nguồn tiền → GROUP_ONLY, không tính vào báo cáo', () => {
    const { lines, issues } = mapSuggestEvents([
      event('CONFIRM_CASH_RELEASED', '2026-08-13', {
        data: { fundSource: 'COMPANY_CASH' },
        po_cash_account: null,
      }),
    ]);
    expect(lines).toEqual([]);
    expect(issues[0]).toMatchObject({ kind: 'GROUP_ONLY', warningOnly: false });
    expect(issues[0].message).toContain('Tiền mặt');
  });

  it('chưa chi → hoàn quỹ: chi rồi thu lại cùng tài khoản, cùng số tiền (giao dịch hủy có số dư ròng 0)', () => {
    const { lines } = mapSuggestEvents([
      event('CONFIRM_CASH_RELEASED', '2026-08-13', {
        data: { cashAccount: '1121' },
      }),
      event('CONFIRM_FUND_RETURNED', '2026-08-20'),
    ]);
    expect(
      lines.map((item) => [item.accountCode, item.receipt, item.payment]),
    ).toEqual([
      ['1121', 0n, toCents('3000000')],
      ['1121', toCents('3000000'), 0n],
    ]);
  });

  it('sửa lệnh chi rồi xác nhận xuất tiền lại (không hoàn quỹ) → chỉ tính lần sau, lần trước thành cảnh báo', () => {
    const { lines, issues } = mapSuggestEvents([
      event('CREATE_PAYMENT_ORDER', '2026-08-11', {
        data: { paymentOrder: { code: 'LC-202608-0001', amount: 2500000 } },
      }),
      event('CONFIRM_CASH_RELEASED', '2026-08-13', {
        data: { fundSource: 'COMPANY_CASH' },
      }),
      event('EDIT_PAYMENT_ORDER', '2026-09-24'),
      event('CONFIRM_CASH_RELEASED', '2026-09-24', {
        data: { cashAccount: '1111' },
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      postingDate: '2026-09-24',
      payment: toCents('3000000'), // số tiền lệnh chi hiện tại sau khi sửa
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'SUPERSEDED_RELEASE',
      warningOnly: true,
    });
  });

  it('đề nghị bị rút / từ chối trước khi xuất tiền → không có bút toán', () => {
    expect(
      mapSuggestEvents([event('CREATE_PAYMENT_ORDER', '2026-08-11')]),
    ).toEqual({
      lines: [],
      issues: [],
    });
  });
});

describe('mapFinancialMovements', () => {
  it('nguồn SQL chỉ lấy giao dịch còn hiệu lực và bù tài khoản cho phiếu chi cũ', () => {
    expect(FINANCIAL_MOVEMENTS_SQL).toContain("p.status = 'RECORDED'");
    expect(FINANCIAL_MOVEMENTS_SQL).toContain("f.status = 'RECORDED'");
    expect(FINANCIAL_MOVEMENTS_SQL).toContain(
      'COALESCE(p.cash_account_code, r.control_cash_account_code)',
    );
  });

  it('phiếu chi → bút toán chi đúng tài khoản và liên kết phiếu gốc', () => {
    const { lines, issues } = mapFinancialMovements([financialMovement()]);

    expect(issues).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      accountCode: '1121',
      receipt: 0n,
      payment: toCents('2500000'),
      documentNo: 'TT-2026-00009',
      invoiceNo: 'FT-123456',
      partnerCode: 'NV0022',
      source: { type: 'FINANCIAL_REQUEST', requestId: 9 },
    });
  });

  it('phiếu hoàn trả → bút toán thu', () => {
    const { lines } = mapFinancialMovements([
      financialMovement({
        direction: 'REFUND',
        movement_id: 8,
        cash_account: '1111',
        amount: '300000',
      }),
    ]);

    expect(lines[0]).toMatchObject({
      accountCode: '1111',
      receipt: toCents('300000'),
      payment: 0n,
    });
  });

  it('giao dịch thiếu tài khoản → chưa phân loại, không cộng vào tổng', () => {
    const { lines, issues } = mapFinancialMovements([
      financialMovement({ cash_account: null }),
    ]);

    expect(lines).toEqual([]);
    expect(issues[0]).toMatchObject({
      kind: 'MISSING_ACCOUNT',
      source: { type: 'FINANCIAL_REQUEST', requestId: 9 },
    });
  });
});

describe('flagSuspiciousAmounts', () => {
  it('số tiền ≥ 10 tỷ → cảnh báo kèm theo, vẫn giữ bút toán / lỗi gốc', () => {
    const collected = mapSuggestEvents([
      event('CONFIRM_CASH_RELEASED', '2026-08-13', {
        data: { fundSource: 'BANK_ACCOUNT' },
        po_amount: '2000000000000.00',
        po_cash_account: null,
      }),
    ]);
    const flagged = flagSuspiciousAmounts(collected);
    expect(flagged.issues.map((item) => item.kind)).toEqual([
      'GROUP_ONLY',
      'SUSPICIOUS_AMOUNT',
    ]);
    expect(flagged.issues[1].warningOnly).toBe(true);
  });
});

describe('diễn giải', () => {
  it('gom tab / xuống dòng trong nội dung doanh thu', () => {
    const { lines } = mapInvoiceRows([
      invoice({ content: 'Chương trình\t\tSTEM\n tháng 9  ' }),
    ]);
    expect(lines[0].description).toBe(
      'Thu Chương trình STEM tháng 9 — TH Đông Hòa (T10/2026)',
    );
  });
});
