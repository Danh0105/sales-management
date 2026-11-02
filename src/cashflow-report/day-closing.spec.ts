import { CashAccountInfo, LedgerLine } from './cashflow.types';
import { closedDayIssues, snapshotDay } from './day-closing';

const account = (code: string, opening: bigint | null): CashAccountInfo => ({
  code,
  name: `TK ${code}`,
  groupCode: code.startsWith('111') ? '111' : '112',
  sortOrder: 1,
  isActive: true,
  openingBalance: opening,
  openingBalanceDate: opening === null ? null : '2026-11-01',
});

const line = (
  key: string,
  date: string,
  accountCode: string,
  receipt: bigint,
  payment: bigint,
): LedgerLine => ({
  key,
  postingDate: date,
  documentDate: date,
  documentNo: key,
  invoiceNo: null,
  description: key,
  accountCode,
  receipt,
  payment,
  partnerCode: null,
  partnerName: null,
  isInternalTransfer: false,
  source: { type: 'MANUAL_ENTRY', manualEntryId: 1 },
});

describe('snapshotDay', () => {
  it('số dư đầu/cuối ngày theo số dư gốc; tài khoản chưa xác minh giữ null', () => {
    const lines = [
      line('a', '2026-11-01', '1111', 100_00n, 0n),
      line('b', '2026-11-02', '1111', 50_00n, 30_00n),
      line('c', '2026-11-02', '1121', 0n, 10_00n),
      line('d', '2026-11-03', '1111', 999_00n, 0n),
    ];
    const snap = snapshotDay(
      [account('1111', 1000_00n), account('1121', null)],
      lines,
      '2026-11-02',
    );
    expect(snap).toEqual([
      {
        code: '1111',
        name: 'TK 1111',
        groupCode: '111',
        opening: '1100.00',
        receipts: '50.00',
        payments: '30.00',
        closing: '1120.00',
        lineCount: 1,
      },
      {
        code: '1121',
        name: 'TK 1121',
        groupCode: '112',
        opening: null,
        receipts: '0.00',
        payments: '10.00',
        closing: null,
        lineCount: 1,
      },
    ]);
  });
});

describe('closedDayIssues', () => {
  const closing = {
    date: '2026-11-02',
    balances: snapshotDay(
      [account('1111', 0n)],
      [line('b', '2026-11-02', '1111', 50_00n, 30_00n)],
      '2026-11-02',
    ),
  };

  it('không lệch thì không cảnh báo', () => {
    expect(
      closedDayIssues(
        [closing],
        [line('b', '2026-11-02', '1111', 50_00n, 30_00n)],
      ),
    ).toEqual([]);
  });

  it('thêm khoản sau khi chốt (kể cả tài khoản mới) → cảnh báo từng tài khoản', () => {
    const issues = closedDayIssues(
      [closing],
      [
        line('b', '2026-11-02', '1111', 50_00n, 30_00n),
        line('late', '2026-11-02', '1111', 0n, 20_00n),
        line('other', '2026-11-02', '1121', 7_00n, 0n),
        line('nextday', '2026-11-03', '1111', 1_00n, 0n),
      ],
    );
    expect(
      issues.map((i) => [
        i.kind,
        i.accountCode,
        i.warningOnly,
        i.amount,
        i.date,
      ]),
    ).toEqual([
      ['CLOSED_DAY_CHANGED', '1111', true, -20_00n, '2026-11-02'],
      ['CLOSED_DAY_CHANGED', '1121', true, 7_00n, '2026-11-02'],
    ]);
    expect(issues[0].message).toBe(
      'Ngày 02/11/2026 đã chốt quỹ nhưng số liệu bị đổi sau khi chốt — thu 50 đ → 50 đ, chi 30 đ → 50 đ',
    );
  });

  it('xoá khoản đã chốt cũng là lệch', () => {
    expect(closedDayIssues([closing], [])).toHaveLength(1);
  });
});
