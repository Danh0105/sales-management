import * as ExcelJS from 'exceljs';
import { toCents } from './cashflow-money';
import {
  computeBalances,
  filterLedgerRows,
  selectLedgerAccounts,
} from './cashflow-ledger';
import {
  buildCashflowWorkbook,
  cashflowFileName,
  CashflowWorkbookInput,
  SHEET_NAMES,
} from './cashflow-excel';
import { CashAccountInfo, CashGroup, LedgerLine } from './cashflow.types';

const CATALOG: [string, string][] = [
  ['1111', 'Tiền mặt tại quỹ'],
  ['1112', 'Tiền TK Sếp Khôi'],
  ['1113', 'Tiền mặt - Anh Trung'],
  ['1114', 'Tiền mặt - Cẩm'],
  ['1121', 'TK Techcombank - ICHI'],
  ['1125', 'TK MB Bank - ICHI'],
  ['1126', 'TK Vietcombank - ICHI'],
  ['1127', 'TK Vietinbank - ICHI'],
  ['1128', 'TK Techcombank - Chuyển đổi số'],
  ['1129', 'TK Techcombank - Kido'],
  ['11210', 'TK Vietinbank - Kido'],
  ['11211', 'TK Techcombank - Anh Việt'],
  ['11212', 'TK MB Bank - ST'],
];
const RANGE = { from: '2026-10-01', to: '2026-10-31' };

const accounts = (verified: string[] = []): CashAccountInfo[] =>
  CATALOG.map(([code, name], index) => ({
    code,
    name,
    groupCode: (code.startsWith('111') ? '111' : '112') as CashGroup,
    sortOrder: index,
    isActive: true,
    openingBalance: verified.includes(code) ? toCents('1000000') : null,
    openingBalanceDate: verified.includes(code) ? '2026-01-01' : null,
  }));

let seq = 0;
const line = (
  accountCode: string,
  postingDate: string,
  amounts: { receipt?: string; payment?: string },
  overrides: Partial<LedgerLine> = {},
): LedgerLine => {
  seq += 1;
  return {
    key: `K${seq}`,
    postingDate,
    documentDate: postingDate,
    documentNo: `PC${String(seq).padStart(4, '0')}`,
    invoiceNo: '0001234',
    description: `Diễn giải ${seq}`,
    accountCode,
    receipt: toCents(amounts.receipt ?? 0),
    payment: toCents(amounts.payment ?? 0),
    partnerCode: 'TR01',
    partnerName: 'Trường Đông Hòa',
    isInternalTransfer: false,
    source: { type: 'INVOICE' },
    ...overrides,
  };
};

function input(
  catalog: CashAccountInfo[],
  lines: LedgerLine[],
  search?: string,
): CashflowWorkbookInput {
  const balances = computeBalances(catalog, lines, RANGE);
  const ledger = (group: CashGroup) => {
    const columns = selectLedgerAccounts(catalog, group, balances);
    return {
      group,
      accounts: columns,
      ...filterLedgerRows(
        lines,
        columns.map((a) => a.code),
        RANGE,
        search,
      ),
    };
  };
  return {
    range: RANGE,
    accounts: catalog,
    balances,
    cash: ledger('111'),
    bank: ledger('112'),
    search,
  };
}

async function roundTrip(data: CashflowWorkbookInput) {
  const buffer = await buildCashflowWorkbook(data).xlsx.writeBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  return wb;
}

const value = (ws: ExcelJS.Worksheet, address: string) =>
  ws.getCell(address).value;
const formula = (ws: ExcelJS.Worksheet, address: string) =>
  ws.getCell(address).value as ExcelJS.CellFormulaValue;

/** Ô gộp hợp lệ: không chồng lấn nhau. */
function assertNoOverlappingMerges(ws: ExcelJS.Worksheet) {
  const seen = new Set<string>();
  for (const range of ws.model.merges) {
    const [start, end] = range.split(':');
    const s = ws.getCell(start);
    const e = ws.getCell(end);
    for (let r = Number(s.row); r <= Number(e.row); r++) {
      for (let c = Number(s.col); c <= Number(e.col); c++) {
        const key = `${r}:${c}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  }
}

describe('buildCashflowWorkbook', () => {
  it('đúng 3 sheet, đúng tên và thứ tự; tên file theo kỳ', async () => {
    const wb = await roundTrip(input(accounts(), []));
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      'DANH MỤC CÁC TK',
      'Tiền mặt',
      'Tiền gửi ngân hàng',
    ]);
    expect(cashflowFileName(RANGE)).toBe(
      'Tong_Hop_Thu_Chi_20261001_20261031.xlsx',
    );
  });

  it('DANH MỤC CÁC TK: nhóm 111 rồi 112, mã theo thứ tự danh mục, số dư cuối kỳ; tổng nhóm chỉ là công thức khi đủ số dư gốc', async () => {
    const catalog = accounts(['1111', '1112', '1113', '1114']);
    const wb = await roundTrip(
      input(catalog, [line('1111', '2026-10-02', { receipt: '500000' })]),
    );
    const ws = wb.getWorksheet(SHEET_NAMES.accounts)!;
    expect(value(ws, 'C5')).toBe('NGUỒN THU CHI');
    expect([value(ws, 'C7'), value(ws, 'D7'), value(ws, 'E7')]).toEqual([
      'Số hiệu tài khoản',
      'Tên tài khoản',
      'Số dư',
    ]);
    expect(value(ws, 'B8')).toBe('111-Tiền mặt');
    expect([9, 10, 11, 12].map((r) => value(ws, `C${r}`))).toEqual([
      1111, 1112, 1113, 1114,
    ]);
    expect(value(ws, 'E9')).toBe(1500000);
    expect(formula(ws, 'E8')).toMatchObject({
      formula: 'SUM(E9:E12)',
      result: 4500000,
    });
    expect(value(ws, 'B13')).toBe('112-Tiền Gửi Ngân Hàng');
    expect([14, 19, 20, 22].map((r) => value(ws, `C${r}`))).toEqual([
      1121, 1129, 11210, 11212,
    ]);
    expect(value(ws, 'E13')).toBe('Chưa xác minh');
    // Viền cả khối B7:E22 như mẫu, kể cả ô trống.
    for (const address of ['B7', 'B9', 'C8', 'D13', 'B22', 'E22']) {
      expect(ws.getCell(address).border?.left?.style).toBe('thin');
    }
    expect(value(ws, 'E14')).toBe('Chưa xác minh');
  });

  it('sổ ngân hàng: tiêu đề gộp, Thu/Chi ở hàng 4, tên tài khoản (lấy từ danh mục) gộp từng cặp ở hàng 5', async () => {
    const wb = await roundTrip(input(accounts(), []));
    const ws = wb.getWorksheet(SHEET_NAMES.bank)!;
    expect(value(ws, 'A1')).toBe('SỔ CHI TIẾT THU CHI');
    expect(value(ws, 'A2')).toBe('TK 112: Tiền gửi ngân hàng');
    expect(ws.model.merges).toEqual(
      expect.arrayContaining([
        'A1:Y1',
        'A2:Y2',
        'F5:G5',
        'P5:Q5',
        'R5:S5',
        'V5:W5',
        'A4:A5',
        'X4:X5',
        'Y4:Y5',
      ]),
    );
    expect([value(ws, 'F4'), value(ws, 'G4'), value(ws, 'W4')]).toEqual([
      'Thu',
      'Chi',
      'Chi',
    ]);
    expect(value(ws, 'P5')).toBe('1129-TK Techcombank - Kido');
    expect(value(ws, 'R5')).toBe('11210-TK Vietinbank - Kido');
    expect([value(ws, 'X4'), value(ws, 'Y4')]).toEqual([
      'Mã đối tượng',
      'Tên đối tượng',
    ]);
    const font = ws.getCell('F5').font;
    expect(font.name).toBe('Times New Roman');
    expect(font.bold).toBe(true);
    expect((ws.getCell('F5').fill as ExcelJS.FillPattern).fgColor?.argb).toBe(
      'FFBFBFBF',
    );
    expect((ws.getCell('A4').fill as ExcelJS.FillPattern).fgColor?.argb).toBe(
      'FFD8D8D8',
    );
    for (const sheet of wb.worksheets) assertNoOverlappingMerges(sheet);
  });

  it('dòng chứng từ: ngày là kiểu ngày, số CT / số HĐ / mã đối tượng là chữ (giữ số 0), tiền là số, cột tài khoản khác để trống', async () => {
    const wb = await roundTrip(
      input(accounts(['1111']), [
        line('1112', '2026-10-05', { payment: '290000' }),
      ]),
    );
    const ws = wb.getWorksheet(SHEET_NAMES.cash)!;
    const date = value(ws, 'A7') as Date;
    expect(date).toBeInstanceOf(Date);
    expect(date.toISOString().slice(0, 10)).toBe('2026-10-05');
    expect(ws.getCell('A7').numFmt).toBe('dd/mm/yyyy');
    expect(value(ws, 'C7')).toMatch(/^PC\d{4}$/);
    expect(value(ws, 'D7')).toBe('0001234');
    expect(value(ws, 'I7')).toBe(290000);
    expect(ws.getCell('I7').numFmt).toBe('#,##0 ;(#,##0)');
    expect([
      value(ws, 'F7'),
      value(ws, 'G7'),
      value(ws, 'H7'),
      value(ws, 'J7'),
    ]).toEqual([null, null, null, null]);
    expect([value(ws, 'N7'), value(ws, 'O7')]).toEqual([
      'TR01',
      'Trường Đông Hòa',
    ]);
  });

  it('Số dư đầu kỳ / Cộng / Số dư cuối kỳ: công thức như mẫu, kết quả khớp số liệu báo cáo', async () => {
    const lines = [
      line('1111', '2026-09-20', { receipt: '200000' }), // trước kỳ → vào dư đầu
      line('1111', '2026-10-02', { receipt: '50000000' }),
      line('1111', '2026-10-03', { payment: '773000' }),
      line('1112', '2026-10-04', { receipt: '10000000' }),
    ];
    const data = input(accounts(['1111']), lines);
    const wb = await roundTrip(data);
    const ws = wb.getWorksheet(SHEET_NAMES.cash)!;
    expect(value(ws, 'E6')).toBe('Số dư đầu kỳ');
    expect(value(ws, 'F6')).toBe(1200000);
    expect(value(ws, 'H6')).toBe('Chưa xác minh');
    expect(value(ws, 'E10')).toBe('Cộng');
    expect(formula(ws, 'F10')).toMatchObject({
      formula: 'SUM(F7:F9)',
      result: 50000000,
    });
    expect(formula(ws, 'G10')).toMatchObject({
      formula: 'SUM(G7:G9)',
      result: 773000,
    });
    expect(value(ws, 'E11')).toBe('Số dư cuối kỳ');
    const closing = formula(ws, 'F11');
    expect(closing).toMatchObject({ formula: 'F6+F10-G10', result: 50427000 });
    expect(closing.result).toBe(
      Number(data.balances.get('1111')!.closing!) / 100,
    );
    expect(value(ws, 'H11')).toBe('Chưa xác minh');
    expect(ws.pageSetup.orientation).toBe('landscape');
    expect(ws.pageSetup.printTitlesRow).toBe('4:5');
  });

  it('lọc theo từ khoá: Cộng là dòng khớp, dư cuối là số dư thật (không dùng công thức), có ghi chú', async () => {
    const lines = [
      line(
        '1111',
        '2026-10-02',
        { receipt: '100' },
        { description: 'Thu Lạc Hồng' },
      ),
      line('1111', '2026-10-03', { payment: '30' }),
    ];
    const wb = await roundTrip(input(accounts(['1111']), lines, 'lac hong'));
    const ws = wb.getWorksheet(SHEET_NAMES.cash)!;
    expect(formula(ws, 'F8')).toMatchObject({ result: 100 });
    expect(value(ws, 'F9')).toBe(1000070);
    expect(String(value(ws, 'A11'))).toContain('Đang lọc theo từ khoá');
  });

  it('không có phát sinh: Cộng = 0, dư cuối = dư đầu; nhóm ngoài phạm vi vẫn có sheet', async () => {
    const data = input(accounts(['1111']), []);
    data.bank = { group: '112', accounts: [], rows: [], totals: new Map() };
    const wb = await roundTrip(data);
    const cash = wb.getWorksheet(SHEET_NAMES.cash)!;
    expect(value(cash, 'F7')).toBe(0);
    expect(formula(cash, 'F8')).toMatchObject({
      formula: 'F6+F7-G7',
      result: 1000000,
    });
    const bank = wb.getWorksheet(SHEET_NAMES.bank)!;
    expect(value(bank, 'E6')).toBe(
      'Không có tài khoản nào theo bộ lọc hiện tại',
    );
  });

  it('xuất nhiều nghìn dòng: đủ số dòng, tổng đúng', async () => {
    const lines = Array.from({ length: 5000 }, (_, index) =>
      line(
        index % 2 ? '1121' : '11212',
        `2026-10-${String((index % 28) + 1).padStart(2, '0')}`,
        {
          receipt: '1000.5',
        },
      ),
    );
    const wb = await roundTrip(input(accounts(), lines));
    const ws = wb.getWorksheet(SHEET_NAMES.bank)!;
    expect(value(ws, `E${7 + 5000}`)).toBe('Cộng');
    expect(formula(ws, `F${7 + 5000}`).result).toBe(2501250);
    expect(formula(ws, `V${7 + 5000}`).result).toBe(2501250);
  });
});
