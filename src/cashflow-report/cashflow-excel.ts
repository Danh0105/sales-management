import * as ExcelJS from 'exceljs';
import { Cents, centsToNumber } from './cashflow-money';
import { AccountBalance, ReportRange } from './cashflow-ledger';
import { CashAccountInfo, CashGroup, LedgerLine } from './cashflow.types';

/**
 * Workbook "TỔNG HỢP THU CHI" dựng lại theo file mẫu của kế toán (3 sheet,
 * font, nền, viền, định dạng số và độ rộng cột lấy từ mẫu). Dựng bằng code
 * thay vì sửa file mẫu vì số cặp cột Thu/Chi đổi theo danh mục tài khoản.
 *
 * Khác mẫu có chủ đích (mẫu có lỗi / để trống):
 * - tiêu đề cột lấy từ danh mục (mẫu ghi nhầm 1129 thành 11210, viết tắt tên);
 * - dư đầu / dư cuối luôn nằm ở cột Thu của tài khoản (mẫu lẫn cột Chi);
 * - ô tiền của tài khoản khác để trống (mẫu điền 0 rải rác), ngày luôn là
 *   kiểu ngày (mẫu lẫn chuỗi "02/01/2026");
 * - tiêu đề cột chứng từ gộp 2 hàng, thêm dòng kỳ báo cáo ở hàng 3.
 */

export const SHEET_NAMES = {
  accounts: 'DANH MỤC CÁC TK',
  cash: 'Tiền mặt',
  bank: 'Tiền gửi ngân hàng',
} as const;

const LEDGER_TITLES: Record<CashGroup, string> = {
  '111': 'TK 111: Tiền mặt tại quỹ',
  '112': 'TK 112: Tiền gửi ngân hàng',
};
const GROUP_LABELS: Record<CashGroup, string> = {
  '111': '111-Tiền mặt',
  '112': '112-Tiền Gửi Ngân Hàng',
};

const MONEY_FORMAT = '#,##0 ;(#,##0)';
const DATE_FORMAT = 'dd/mm/yyyy';
const UNVERIFIED = 'Chưa xác minh';
const THIN = { style: 'thin' } as const;
const ALL_BORDERS: Partial<ExcelJS.Borders> = {
  top: THIN,
  left: THIN,
  bottom: THIN,
  right: THIN,
};
const BODY_FONT: Partial<ExcelJS.Font> = { name: 'Times New Roman', size: 11 };
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFD8D8D8' },
};
const ACCOUNT_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFBFBFBF' },
};

export interface ExcelLedger {
  group: CashGroup;
  /** Cột tài khoản của sổ, theo thứ tự danh mục. */
  accounts: CashAccountInfo[];
  /** TẤT CẢ dòng đã lọc (không phân trang). */
  rows: LedgerLine[];
  totals: Map<string, { receipts: Cents; payments: Cents }>;
}

export interface CashflowWorkbookInput {
  range: ReportRange;
  /** Toàn bộ danh mục (sheet 1). */
  accounts: CashAccountInfo[];
  balances: Map<string, AccountBalance>;
  cash: ExcelLedger;
  bank: ExcelLedger;
  search?: string;
}

const viDate = (value: string) => {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
};

/** Ngày YYYY-MM-DD → Date nửa đêm UTC: exceljs ghi serial theo UTC, không lệch ngày. */
const excelDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

export const cashflowFileName = (range: ReportRange) =>
  `Tong_Hop_Thu_Chi_${range.from.replace(/-/g, '')}_${range.to.replace(/-/g, '')}.xlsx`;

function buildAccountsSheet(
  wb: ExcelJS.Workbook,
  input: CashflowWorkbookInput,
) {
  const ws = wb.addWorksheet(SHEET_NAMES.accounts, {
    views: [{ showGridLines: true }],
    pageSetup: {
      paperSize: 9,
      margins: {
        left: 0.7,
        right: 0.7,
        top: 0.75,
        bottom: 0.75,
        header: 0.3,
        footer: 0.3,
      },
    },
  });
  ws.getColumn(3).width = 18.7109375;
  ws.getColumn(4).width = 31.7109375;
  ws.getColumn(5).width = 20;

  ws.getCell('C5').value = 'NGUỒN THU CHI';
  const period = ws.getCell('C6');
  period.value = `Số dư cuối ngày ${viDate(input.range.to)}`;
  period.font = { ...BODY_FONT, italic: true, size: 10 };

  const bordered = (cell: ExcelJS.Cell, value: ExcelJS.CellValue) => {
    cell.value = value;
    cell.font = BODY_FONT;
    cell.border = ALL_BORDERS;
  };

  bordered(ws.getCell('C7'), 'Số hiệu tài khoản');
  bordered(ws.getCell('D7'), 'Tên tài khoản');
  bordered(ws.getCell('E7'), 'Số dư');

  let row = 8;
  for (const group of ['111', '112'] as CashGroup[]) {
    const accounts = input.accounts.filter((a) => a.groupCode === group);
    const groupRow = row;
    bordered(ws.getCell(groupRow, 2), GROUP_LABELS[group]);
    row += 1;
    const firstAccountRow = row;
    let allVerified = true;
    let total = 0n;

    for (const account of accounts) {
      const closing = input.balances.get(account.code)?.closing ?? null;
      // Mã tài khoản là số như file mẫu (không có số 0 ở đầu).
      bordered(
        ws.getCell(row, 3),
        /^\d+$/.test(account.code) ? Number(account.code) : account.code,
      );
      bordered(
        ws.getCell(row, 4),
        account.isActive ? account.name : `${account.name} (ngừng sử dụng)`,
      );
      const balanceCell = ws.getCell(row, 5);
      if (closing === null) {
        allVerified = false;
        bordered(balanceCell, UNVERIFIED);
        balanceCell.font = { ...BODY_FONT, italic: true };
      } else {
        total += closing;
        bordered(balanceCell, centsToNumber(closing));
        balanceCell.numFmt = MONEY_FORMAT;
      }
      row += 1;
    }

    const totalCell = ws.getCell(groupRow, 5);
    if (accounts.length > 0 && allVerified) {
      bordered(totalCell, {
        formula: `SUM(E${firstAccountRow}:E${row - 1})`,
        result: centsToNumber(total),
      });
      totalCell.numFmt = MONEY_FORMAT;
    } else {
      bordered(totalCell, accounts.length > 0 ? UNVERIFIED : 0);
      totalCell.font = { ...BODY_FONT, italic: true };
    }
  }

  // Như mẫu: kẻ viền cả khối B7:E…, kể cả ô trống (cột B dòng tài khoản, C–D dòng nhóm).
  for (let r = 7; r < row; r++) {
    for (let c = 2; c <= 5; c++) {
      const cell = ws.getCell(r, c);
      cell.border = ALL_BORDERS;
      if (!cell.font?.name) cell.font = BODY_FONT;
    }
  }
}

function buildLedgerSheet(
  wb: ExcelJS.Workbook,
  name: string,
  ledger: ExcelLedger,
  input: CashflowWorkbookInput,
) {
  const accountCount = ledger.accounts.length;
  const firstAmountCol = 6;
  const partnerCodeCol = firstAmountCol + accountCount * 2;
  const lastCol = partnerCodeCol + 1;

  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', xSplit: 5, ySplit: 5, showGridLines: true }],
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      margins: {
        left: 0.39370078740157477,
        right: 0.39370078740157477,
        top: 0.39370078740157477,
        bottom: 0.39370078740157477,
        header: 0.5,
        footer: 0.5,
      },
      printTitlesRow: '4:5',
    },
  });

  [15, 15, 15, 15, 31.28515625].forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });
  for (let index = 0; index < accountCount; index++) {
    ws.getColumn(firstAmountCol + index * 2).width = 17.42578125;
    ws.getColumn(firstAmountCol + index * 2 + 1).width = 18;
  }
  ws.getColumn(partnerCodeCol).width = 15;
  ws.getColumn(lastCol).width = 25;
  const letter = (col: number) => ws.getColumn(col).letter;

  // Hàng 1–3: tiêu đề, nhóm tài khoản, kỳ báo cáo.
  const titleRows: [number, string, Partial<ExcelJS.Font>, number][] = [
    [1, 'SỔ CHI TIẾT THU CHI', { name: 'Arial', size: 16, bold: true }, 28.35],
    [
      2,
      LEDGER_TITLES[ledger.group],
      { name: 'Arial', size: 11, bold: true },
      28.35,
    ],
    [
      3,
      `Từ ngày ${viDate(input.range.from)} đến ngày ${viDate(input.range.to)}`,
      { name: 'Arial', size: 10, italic: true },
      18,
    ],
  ];
  for (const [rowNumber, text, font, height] of titleRows) {
    ws.mergeCells(rowNumber, 1, rowNumber, lastCol);
    const cell = ws.getCell(rowNumber, 1);
    cell.value = text;
    cell.font = font;
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
    ws.getRow(rowNumber).height = height;
  }

  // Hàng 4–5: tiêu đề cột (Thu/Chi ở hàng 4, tên tài khoản ở hàng 5 như mẫu).
  const headerCell = (
    row: number,
    col: number,
    value: string,
    fill: ExcelJS.Fill,
    font: Partial<ExcelJS.Font>,
  ) => {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font = font;
    cell.fill = fill;
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
    cell.border = ALL_BORDERS;
  };
  const headerFont = { name: 'Arial', size: 10, bold: true };
  const fixedHeaders: [number, string][] = [
    [1, 'Ngày hạch toán'],
    [2, 'Ngày chứng từ'],
    [3, 'Số chứng từ'],
    [4, 'Số hóa đơn'],
    [5, 'Diễn giải'],
    [partnerCodeCol, 'Mã đối tượng'],
    [lastCol, 'Tên đối tượng'],
  ];
  for (const [col, label] of fixedHeaders) {
    headerCell(4, col, label, HEADER_FILL, headerFont);
    headerCell(5, col, label, HEADER_FILL, headerFont);
    ws.mergeCells(4, col, 5, col);
  }
  ledger.accounts.forEach((account, index) => {
    const thuCol = firstAmountCol + index * 2;
    headerCell(4, thuCol, 'Thu', HEADER_FILL, headerFont);
    headerCell(4, thuCol + 1, 'Chi', HEADER_FILL, headerFont);
    const label = `${account.code}-${account.name}`;
    const accountFont = { ...BODY_FONT, bold: true };
    headerCell(5, thuCol, label, ACCOUNT_FILL, accountFont);
    headerCell(5, thuCol + 1, label, ACCOUNT_FILL, accountFont);
    ws.mergeCells(5, thuCol, 5, thuCol + 1);
  });
  ws.getRow(4).height = 25.5;
  ws.getRow(5).height = 28.5;

  const bodyCell = (
    row: number,
    col: number,
    value: ExcelJS.CellValue,
    options: {
      bold?: boolean;
      italic?: boolean;
      money?: boolean;
      date?: boolean;
    } = {},
  ) => {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font = { ...BODY_FONT, bold: options.bold, italic: options.italic };
    cell.border = ALL_BORDERS;
    if (options.money) {
      cell.numFmt = MONEY_FORMAT;
      cell.alignment = { horizontal: 'right', wrapText: true };
    } else if (options.date) {
      cell.numFmt = DATE_FORMAT;
      cell.alignment = { horizontal: 'center', wrapText: true };
    } else {
      cell.alignment = { horizontal: 'left', wrapText: true };
    }
    return cell;
  };

  if (accountCount === 0) {
    bodyCell(6, 5, 'Không có tài khoản nào theo bộ lọc hiện tại', {
      italic: true,
    });
    return;
  }

  // Hàng 6: số dư đầu kỳ (cột Thu của từng tài khoản).
  const openingRow = 6;
  for (let col = 1; col <= lastCol; col++) {
    bodyCell(openingRow, col, null, {
      bold: true,
      date: col <= 2,
      money: col >= firstAmountCol && col < partnerCodeCol,
    });
  }
  ws.getCell(openingRow, 5).value = 'Số dư đầu kỳ';
  ledger.accounts.forEach((account, index) => {
    const opening = input.balances.get(account.code)?.opening ?? null;
    const cell = ws.getCell(openingRow, firstAmountCol + index * 2);
    if (opening === null) {
      cell.value = UNVERIFIED;
      cell.font = { ...BODY_FONT, bold: true, italic: true };
    } else {
      cell.value = centsToNumber(opening);
    }
  });

  // Chứng từ phát sinh.
  const columnOf = new Map(
    ledger.accounts.map((account, index) => [
      account.code,
      firstAmountCol + index * 2,
    ]),
  );
  let row = openingRow + 1;
  for (const line of ledger.rows) {
    bodyCell(row, 1, excelDate(line.postingDate), { date: true });
    bodyCell(row, 2, line.documentDate ? excelDate(line.documentDate) : null, {
      date: true,
    });
    // Giữ số chứng từ / số hóa đơn / mã đối tượng ở dạng chữ: không mất số 0 ở đầu.
    bodyCell(row, 3, line.documentNo);
    bodyCell(row, 4, line.invoiceNo ?? '');
    bodyCell(row, 5, line.description);
    for (let col = firstAmountCol; col < partnerCodeCol; col++) {
      bodyCell(row, col, null, { money: true });
    }
    const thuCol = columnOf.get(line.accountCode)!;
    if (line.receipt !== 0n)
      ws.getCell(row, thuCol).value = centsToNumber(line.receipt);
    if (line.payment !== 0n)
      ws.getCell(row, thuCol + 1).value = centsToNumber(line.payment);
    bodyCell(row, partnerCodeCol, line.partnerCode ?? '');
    bodyCell(row, lastCol, line.partnerName ?? '');
    row += 1;
  }
  const lastDataRow = row - 1;
  const hasRows = lastDataRow >= openingRow + 1;

  // Cộng: công thức SUM như mẫu, kèm sẵn kết quả để file mở ra có số ngay.
  const totalRow = row;
  for (let col = 1; col <= lastCol; col++) {
    bodyCell(totalRow, col, null, {
      bold: true,
      date: col <= 2,
      money: col >= firstAmountCol && col < partnerCodeCol,
    });
  }
  ws.getCell(totalRow, 5).value = 'Cộng';
  ledger.accounts.forEach((account, index) => {
    const total = ledger.totals.get(account.code) ?? {
      receipts: 0n,
      payments: 0n,
    };
    [total.receipts, total.payments].forEach((amount, offset) => {
      const col = firstAmountCol + index * 2 + offset;
      ws.getCell(totalRow, col).value = hasRows
        ? {
            formula: `SUM(${letter(col)}${openingRow + 1}:${letter(col)}${lastDataRow})`,
            result: centsToNumber(amount),
          }
        : 0;
    });
  });

  // Số dư cuối kỳ: = đầu + thu - chi (cột Thu), nền xám như mẫu. Khi lọc theo từ
  // khoá thì "Cộng" chỉ là các dòng khớp, nên ghi số dư thật thay vì công thức.
  const closingRow = totalRow + 1;
  const label = bodyCell(closingRow, 5, 'Số dư cuối kỳ', { bold: true });
  label.fill = HEADER_FILL;
  label.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  const searchActive = !!input.search?.trim();
  ledger.accounts.forEach((account, index) => {
    const thuCol = firstAmountCol + index * 2;
    const balance = input.balances.get(account.code);
    const cell = bodyCell(closingRow, thuCol, null, {
      bold: true,
      money: true,
    });
    cell.fill = HEADER_FILL;
    if (!balance || balance.closing === null) {
      cell.value = UNVERIFIED;
      cell.font = { ...BODY_FONT, bold: true, italic: true };
    } else if (searchActive) {
      cell.value = centsToNumber(balance.closing);
    } else {
      const thu = letter(thuCol);
      const chi = letter(thuCol + 1);
      cell.value = {
        formula: `${thu}${openingRow}+${thu}${totalRow}-${chi}${totalRow}`,
        result: centsToNumber(balance.closing),
      };
    }
  });

  if (searchActive) {
    const note = ws.getCell(closingRow + 2, 1);
    note.value =
      `Đang lọc theo từ khoá "${input.search!.trim()}": dòng Cộng chỉ tính các chứng từ khớp; ` +
      'số dư đầu/cuối kỳ là số dư thật của tài khoản.';
    note.font = { ...BODY_FONT, italic: true, size: 10 };
  }

  ws.pageSetup.printArea = `A1:${letter(lastCol)}${closingRow}`;
}

export function buildCashflowWorkbook(
  input: CashflowWorkbookInput,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kido';
  wb.created = new Date();
  buildAccountsSheet(wb, input);
  buildLedgerSheet(wb, SHEET_NAMES.cash, input.cash, input);
  buildLedgerSheet(wb, SHEET_NAMES.bank, input.bank, input);
  return wb;
}
