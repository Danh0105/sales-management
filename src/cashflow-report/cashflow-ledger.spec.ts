import { centsToNumber, centsToString, toCents } from './cashflow-money';
import {
  buildSummary,
  computeBalances,
  filterLedgerRows,
  foldSearchText,
  selectLedgerAccounts,
  validateLines,
} from './cashflow-ledger';
import { CashAccountInfo, LedgerLine } from './cashflow.types';

const account = (
  code: string,
  overrides: Partial<CashAccountInfo> = {},
): CashAccountInfo => ({
  code,
  name: `TK ${code}`,
  groupCode: code.startsWith('111') ? '111' : '112',
  sortOrder: 0,
  isActive: true,
  openingBalance: null,
  openingBalanceDate: null,
  ...overrides,
});

let seq = 0;
const line = (
  accountCode: string,
  postingDate: string,
  amounts: { receipt?: string; payment?: string },
  overrides: Partial<LedgerLine> = {},
): LedgerLine => {
  seq += 1;
  return {
    key: `L${seq}`,
    postingDate,
    documentDate: postingDate,
    documentNo: `CT${seq}`,
    invoiceNo: null,
    description: `Bút toán ${seq}`,
    accountCode,
    receipt: toCents(amounts.receipt ?? 0),
    payment: toCents(amounts.payment ?? 0),
    partnerCode: null,
    partnerName: null,
    isInternalTransfer: false,
    source: { type: 'INVOICE' },
    ...overrides,
  };
};

const OCT = { from: '2026-10-01', to: '2026-10-31' };

describe('cashflow-money', () => {
  it('parse chuỗi numeric của Postgres chính xác tới xu', () => {
    expect(toCents('1085860000.00')).toBe(108586000000n);
    expect(toCents('0.1')).toBe(10n);
    expect(toCents('-5.05')).toBe(-505n);
    expect(toCents(0.3)).toBe(30n);
    expect(toCents(null)).toBe(0n);
  });

  it('không lệch khi cộng số lẻ (0.1 + 0.2)', () => {
    expect(centsToString(toCents('0.1') + toCents('0.2'))).toBe('0.30');
  });

  it('từ chối chuỗi không phải số tiền', () => {
    expect(() => toCents('1,000')).toThrow();
    expect(() => toCents('1.234')).toThrow();
    expect(() => toCents('abc')).toThrow();
  });

  it('số tiền lớn numeric(18,2) vẫn đúng tuyệt đối; vượt 2^53 xu thì không đổi sang number', () => {
    const big = toCents('9999999999999999.99');
    expect(centsToString(big + toCents('0.01'))).toBe('10000000000000000.00');
    expect(() => centsToNumber(big)).toThrow();
    expect(centsToNumber(toCents('2000000000000.00'))).toBe(2_000_000_000_000);
  });
});

describe('computeBalances', () => {
  it('không có giao dịch, chưa có số dư gốc → dư đầu/cuối null (chưa xác minh), thu chi = 0', () => {
    const balances = computeBalances([account('1111')], [], OCT);
    expect(balances.get('1111')).toEqual({
      code: '1111',
      opening: null,
      receipts: 0n,
      payments: 0n,
      closing: null,
      lineCount: 0,
    });
  });

  it('có số dư gốc nhưng không phát sinh → dư cuối = dư đầu = số dư gốc', () => {
    const accounts = [
      account('1111', {
        openingBalance: toCents('5000000'),
        openingBalanceDate: '2026-09-01',
      }),
    ];
    const balance = computeBalances(accounts, [], OCT).get('1111')!;
    expect(balance.opening).toBe(toCents('5000000'));
    expect(balance.closing).toBe(toCents('5000000'));
  });

  it('chỉ thu / chỉ chi / cả thu và chi; cộng phát sinh trước kỳ vào dư đầu', () => {
    const accounts = [
      account('1111', { openingBalance: 0n, openingBalanceDate: '2026-01-01' }),
      account('1121', { openingBalance: 0n, openingBalanceDate: '2026-01-01' }),
      account('1125', { openingBalance: 0n, openingBalanceDate: '2026-01-01' }),
    ];
    const lines = [
      line('1111', '2026-09-15', { receipt: '1000000' }), // trước kỳ
      line('1111', '2026-10-05', { receipt: '200000' }),
      line('1121', '2026-10-06', { payment: '300000' }),
      line('1125', '2026-10-07', { receipt: '50000' }),
      line('1125', '2026-10-08', { payment: '20000' }),
    ];
    const balances = computeBalances(accounts, lines, OCT);
    expect(balances.get('1111')).toMatchObject({
      opening: toCents('1000000'),
      receipts: toCents('200000'),
      payments: 0n,
      closing: toCents('1200000'),
    });
    expect(balances.get('1121')).toMatchObject({
      opening: 0n,
      receipts: 0n,
      payments: toCents('300000'),
      closing: toCents('-300000'),
    });
    expect(balances.get('1125')!.closing).toBe(toCents('30000'));
  });

  it('mốc đối chiếu nằm sau ngày đầu kỳ → lùi phát sinh từ đầu kỳ tới mốc', () => {
    const accounts = [
      account('1111', {
        openingBalance: toCents('1000000'),
        openingBalanceDate: '2026-10-10',
      }),
    ];
    const lines = [
      line('1111', '2026-10-03', { receipt: '400000' }),
      line('1111', '2026-10-09', { payment: '100000' }),
      line('1111', '2026-10-10', { receipt: '50000' }), // tính từ mốc trở đi
    ];
    const balance = computeBalances(accounts, lines, OCT).get('1111')!;
    // Đầu 01/10 = 1.000.000 - (400.000 - 100.000) = 700.000
    expect(balance.opening).toBe(toCents('700000'));
    expect(balance.closing).toBe(toCents('1050000'));
  });

  it('lọc ngày tính cả ngày đầu kỳ và ngày cuối kỳ', () => {
    const accounts = [
      account('1111', { openingBalance: 0n, openingBalanceDate: '2026-01-01' }),
    ];
    const lines = [
      line('1111', '2026-09-30', { receipt: '1' }),
      line('1111', '2026-10-01', { receipt: '10' }),
      line('1111', '2026-10-31', { receipt: '100' }),
      line('1111', '2026-11-01', { receipt: '1000' }),
    ];
    const balance = computeBalances(accounts, lines, OCT).get('1111')!;
    expect(balance.receipts).toBe(toCents('110'));
    expect(balance.opening).toBe(toCents('1'));
    expect(balance.lineCount).toBe(2);
  });

  it('nhiều tài khoản ngân hàng không lẫn số liệu của nhau', () => {
    const codes = [
      '1121',
      '1125',
      '1126',
      '1127',
      '1128',
      '1129',
      '11210',
      '11211',
      '11212',
    ];
    const accounts = codes.map((code) =>
      account(code, { openingBalance: 0n, openingBalanceDate: '2026-01-01' }),
    );
    const lines = codes.map((code, index) =>
      line(code, '2026-10-02', { receipt: String((index + 1) * 1000) }),
    );
    const balances = computeBalances(accounts, lines, OCT);
    codes.forEach((code, index) => {
      expect(balances.get(code)!.closing).toBe(
        toCents(String((index + 1) * 1000)),
      );
    });
  });

  it('bất biến Dư đầu + Thu - Chi = Dư cuối trên dữ liệu ngẫu nhiên', () => {
    let random = 42;
    const next = () => (random = (random * 1103515245 + 12345) % 2 ** 31);
    const codes = ['1111', '1112', '1121', '11212'];
    const accounts = codes.map((code) =>
      account(code, {
        openingBalance: BigInt(next() % 10_000_000) * 100n,
        openingBalanceDate: `2026-${String((next() % 12) + 1).padStart(2, '0')}-01`,
      }),
    );
    const lines = Array.from({ length: 2000 }, () => {
      const month = String((next() % 12) + 1).padStart(2, '0');
      const day = String((next() % 28) + 1).padStart(2, '0');
      const amount = String(next() % 50_000_000);
      return line(
        codes[next() % codes.length],
        `2026-${month}-${day}`,
        next() % 2 ? { receipt: amount } : { payment: amount },
      );
    });
    const range = { from: '2026-04-15', to: '2026-08-20' };
    const balances = computeBalances(accounts, lines, range);
    for (const code of codes) {
      const balance = balances.get(code)!;
      expect(balance.closing).toBe(
        balance.opening! + balance.receipts - balance.payments,
      );
      // Đối chiếu độc lập: dư cuối kỳ phải bằng dư đầu của ngày kế tiếp.
      const nextDay = computeBalances(accounts, lines, {
        from: '2026-08-21',
        to: '2026-08-21',
      }).get(code)!;
      expect(nextDay.opening).toBe(balance.closing);
    }
  });
});

describe('validateLines', () => {
  it('mã tài khoản ngoài danh mục và bút toán trùng → lỗi, không tính vào số dư', () => {
    const ok = line('1111', '2026-10-01', { receipt: '100' });
    const unknown = line('9999', '2026-10-01', { receipt: '100' });
    const duplicate = { ...ok };
    const result = validateLines(
      { lines: [ok, unknown, duplicate], issues: [] },
      [account('1111')],
    );
    expect(result.lines).toEqual([ok]);
    expect(result.issues.map((item) => item.kind).sort()).toEqual([
      'DUPLICATE',
      'UNKNOWN_ACCOUNT',
    ]);
    expect(result.issues.every((item) => !item.warningOnly)).toBe(true);
  });
});

describe('buildSummary', () => {
  it('còn tài khoản chưa xác minh → tổng dư đầu/cuối null, vẫn có tổng của TK đã xác minh', () => {
    const accounts = [
      account('1111', {
        openingBalance: toCents('100'),
        openingBalanceDate: '2026-01-01',
      }),
      account('1112'),
    ];
    const lines = [line('1112', '2026-10-02', { receipt: '50' })];
    const balances = computeBalances(accounts, lines, OCT);
    const summary = buildSummary(accounts, balances, lines, OCT);
    expect(summary.openingTotal).toBeNull();
    expect(summary.closingTotal).toBeNull();
    expect(summary.verifiedOpeningTotal).toBe(toCents('100'));
    expect(summary.receipts).toBe(toCents('50'));
    expect(summary.unverifiedAccounts).toEqual(['1112']);
  });

  it('chuyển tiền nội bộ: số dư tính đủ hai chân, tổng thu chi thực tế không nhân đôi', () => {
    const accounts = [
      account('1111', { openingBalance: 0n, openingBalanceDate: '2026-01-01' }),
      account('1121', {
        openingBalance: toCents('10000000'),
        openingBalanceDate: '2026-01-01',
      }),
    ];
    const lines = [
      line(
        '1121',
        '2026-10-03',
        { payment: '10000000' },
        { documentNo: 'CK1', isInternalTransfer: true },
      ),
      line(
        '1111',
        '2026-10-03',
        { receipt: '10000000' },
        { documentNo: 'CK1', isInternalTransfer: true },
      ),
      line('1111', '2026-10-04', { payment: '2000000' }),
    ];
    const balances = computeBalances(accounts, lines, OCT);
    const summary = buildSummary(accounts, balances, lines, OCT);
    expect(balances.get('1111')!.closing).toBe(toCents('8000000'));
    expect(balances.get('1121')!.closing).toBe(0n);
    expect(summary.receipts).toBe(toCents('10000000'));
    expect(summary.externalReceipts).toBe(0n);
    expect(summary.externalPayments).toBe(toCents('2000000'));
    expect(summary.voucherCount).toBe(2); // CK1 tính một chứng từ
    expect(summary.closingTotal).toBe(toCents('8000000'));
  });
});

describe('selectLedgerAccounts', () => {
  it('tài khoản ngừng dùng vẫn hiện nếu còn số dư hoặc phát sinh, ẩn nếu không còn gì', () => {
    const accounts = [
      account('1121', { sortOrder: 10 }),
      account('1125', {
        sortOrder: 20,
        isActive: false,
        openingBalance: toCents('5'),
        openingBalanceDate: '2026-01-01',
      }),
      account('1126', { sortOrder: 30, isActive: false }),
      account('1127', { sortOrder: 40, isActive: false }),
    ];
    const lines = [line('1127', '2026-10-02', { payment: '1' })];
    const balances = computeBalances(accounts, lines, OCT);
    expect(
      selectLedgerAccounts(accounts, '112', balances).map((a) => a.code),
    ).toEqual(['1121', '1125', '1127']);
  });

  it('xếp theo thứ tự danh mục, mã số học (1129 trước 11210)', () => {
    const accounts = [
      account('11210'),
      account('1129'),
      account('11212'),
      account('1121'),
    ];
    const balances = computeBalances(accounts, [], OCT);
    expect(
      selectLedgerAccounts(accounts, '112', balances).map((a) => a.code),
    ).toEqual(['1121', '1129', '11210', '11212']);
  });
});

describe('filterLedgerRows', () => {
  it('tìm không phân biệt dấu trên số CT / diễn giải / đối tượng; tổng tính trên mọi dòng đã lọc', () => {
    const lines = [
      line(
        '1111',
        '2026-10-02',
        { receipt: '100' },
        { description: 'Thu tiền Trường Đông Hòa', partnerName: null },
      ),
      line(
        '1111',
        '2026-10-03',
        { payment: '30' },
        { partnerName: 'Nguyễn Văn Đức' },
      ),
      line('1111', '2026-10-04', { receipt: '7' }),
    ];
    expect(foldSearchText('Đông Hòa')).toBe('dong hoa');
    const byDescription = filterLedgerRows(lines, ['1111'], OCT, 'dong hoa');
    expect(byDescription.totalRows).toBe(1);
    const byPartner = filterLedgerRows(lines, ['1111'], OCT, 'duc');
    expect(byPartner.rows[0].payment).toBe(toCents('30'));
    const all = filterLedgerRows(lines, ['1111'], OCT);
    expect(all.totals.get('1111')).toEqual({
      receipts: toCents('107'),
      payments: toCents('30'),
    });
  });

  it('chứng từ không có đối tượng vẫn hiển thị và được cộng', () => {
    const lines = [line('1111', '2026-10-02', { receipt: '5' })];
    const result = filterLedgerRows(lines, ['1111'], OCT);
    expect(result.rows[0].partnerCode).toBeNull();
    expect(result.totals.get('1111')!.receipts).toBe(toCents('5'));
  });

  it('nhiều nghìn dòng: sắp theo ngày hạch toán, tổng chính xác', () => {
    const lines = Array.from({ length: 20000 }, (_, index) =>
      line('1121', `2026-10-${String((index % 31) + 1).padStart(2, '0')}`, {
        receipt: '1000.01',
      }),
    );
    const started = Date.now();
    const result = filterLedgerRows(lines, ['1121'], OCT);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.totalRows).toBe(20000);
    expect(result.totals.get('1121')!.receipts).toBe(toCents('20000200'));
    expect(result.rows[0].postingDate <= result.rows[19999].postingDate).toBe(
      true,
    );
  });
});
