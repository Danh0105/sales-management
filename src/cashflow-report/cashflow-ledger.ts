import { Cents } from './cashflow-money';
import {
  CashAccountInfo,
  CashGroup,
  CollectedLedger,
  LedgerIssue,
  LedgerLine,
} from './cashflow.types';

/**
 * Quy tắc tổng hợp thu chi — hàm thuần, không đụng DB, để test độc lập:
 *   Dư đầu kỳ  = Số dư gốc tại mốc đối chiếu ± phát sinh giữa mốc và ngày đầu kỳ
 *   Dư cuối kỳ = Dư đầu kỳ + Tổng thu - Tổng chi
 * Mọi tổng đều tính trên toàn bộ bút toán đã lọc, không trên trang đang xem.
 */

export interface ReportRange {
  /** YYYY-MM-DD, tính cả ngày này. */
  from: string;
  /** YYYY-MM-DD, tính cả ngày này. */
  to: string;
}

export interface AccountBalance {
  code: string;
  /** null = chưa có số dư gốc đã xác minh (không phải 0). */
  opening: Cents | null;
  receipts: Cents;
  payments: Cents;
  closing: Cents | null;
  lineCount: number;
}

/**
 * Loại bút toán có mã tài khoản ngoài danh mục và bút toán trùng định danh —
 * cả hai chuyển thành lỗi để kế toán xử lý, không tính vào số dư.
 */
export function validateLines(
  collected: CollectedLedger,
  accounts: CashAccountInfo[],
): CollectedLedger {
  const known = new Set(accounts.map((account) => account.code));
  const seen = new Set<string>();
  const lines: LedgerLine[] = [];
  const issues: LedgerIssue[] = [...collected.issues];

  for (const line of collected.lines) {
    const base = {
      key: line.key,
      date: line.postingDate,
      amount: line.receipt > 0n ? line.receipt : line.payment,
      accountCode: line.accountCode,
      documentNo: line.documentNo,
      description: line.description,
      source: line.source,
    };

    if (!known.has(line.accountCode)) {
      issues.push({
        ...base,
        kind: 'UNKNOWN_ACCOUNT',
        message: `Mã tài khoản ${line.accountCode} không có trong danh mục`,
        warningOnly: false,
      });
      continue;
    }

    if (seen.has(line.key)) {
      issues.push({
        ...base,
        kind: 'DUPLICATE',
        message: 'Bút toán trùng định danh — chỉ tính một lần',
        warningOnly: false,
      });
      continue;
    }

    seen.add(line.key);
    lines.push(line);
  }

  return { lines, issues };
}

function net(line: LedgerLine): Cents {
  return line.receipt - line.payment;
}

export function computeBalances(
  accounts: CashAccountInfo[],
  lines: LedgerLine[],
  range: ReportRange,
): Map<string, AccountBalance> {
  const byAccount = new Map<string, LedgerLine[]>();
  for (const line of lines) {
    const list = byAccount.get(line.accountCode) ?? [];
    list.push(line);
    byAccount.set(line.accountCode, list);
  }

  const balances = new Map<string, AccountBalance>();

  for (const account of accounts) {
    const accountLines = byAccount.get(account.code) ?? [];
    let receipts = 0n;
    let payments = 0n;
    let lineCount = 0;

    for (const line of accountLines) {
      if (line.postingDate >= range.from && line.postingDate <= range.to) {
        receipts += line.receipt;
        payments += line.payment;
        lineCount += 1;
      }
    }

    let opening: Cents | null = null;
    const anchorDate = account.openingBalanceDate;

    if (account.openingBalance !== null && anchorDate) {
      opening = account.openingBalance;
      for (const line of accountLines) {
        if (range.from >= anchorDate) {
          // Mốc đối chiếu trước kỳ: cộng phát sinh [mốc, đầu kỳ).
          if (line.postingDate >= anchorDate && line.postingDate < range.from) {
            opening += net(line);
          }
        } else if (
          // Mốc đối chiếu sau ngày đầu kỳ: lùi phát sinh [đầu kỳ, mốc).
          line.postingDate >= range.from &&
          line.postingDate < anchorDate
        ) {
          opening -= net(line);
        }
      }
    }

    balances.set(account.code, {
      code: account.code,
      opening,
      receipts,
      payments,
      closing: opening === null ? null : opening + receipts - payments,
      lineCount,
    });
  }

  return balances;
}

export interface CashflowSummary {
  /** Tổng dư đầu kỳ — null nếu còn tài khoản trong phạm vi chưa có số dư gốc. */
  openingTotal: Cents | null;
  closingTotal: Cents | null;
  /** Tổng dư đầu/cuối của riêng các tài khoản đã xác minh. */
  verifiedOpeningTotal: Cents;
  verifiedClosingTotal: Cents;
  receipts: Cents;
  payments: Cents;
  /** Thu/chi khi loại trừ chuyển tiền nội bộ. */
  externalReceipts: Cents;
  externalPayments: Cents;
  voucherCount: number;
  unverifiedAccounts: string[];
}

export function buildSummary(
  scope: CashAccountInfo[],
  balances: Map<string, AccountBalance>,
  lines: LedgerLine[],
  range: ReportRange,
): CashflowSummary {
  const scopeCodes = new Set(scope.map((account) => account.code));
  const unverifiedAccounts: string[] = [];
  let verifiedOpeningTotal = 0n;
  let verifiedClosingTotal = 0n;
  let receipts = 0n;
  let payments = 0n;

  for (const account of scope) {
    const balance = balances.get(account.code);
    if (!balance) continue;
    receipts += balance.receipts;
    payments += balance.payments;
    if (balance.opening === null || balance.closing === null) {
      unverifiedAccounts.push(account.code);
    } else {
      verifiedOpeningTotal += balance.opening;
      verifiedClosingTotal += balance.closing;
    }
  }

  let externalReceipts = 0n;
  let externalPayments = 0n;
  const documents = new Set<string>();

  for (const line of lines) {
    if (
      !scopeCodes.has(line.accountCode) ||
      line.postingDate < range.from ||
      line.postingDate > range.to
    ) {
      continue;
    }
    documents.add(line.documentNo);
    if (!line.isInternalTransfer) {
      externalReceipts += line.receipt;
      externalPayments += line.payment;
    }
  }

  const allVerified = unverifiedAccounts.length === 0;

  return {
    openingTotal: allVerified ? verifiedOpeningTotal : null,
    closingTotal: allVerified ? verifiedClosingTotal : null,
    verifiedOpeningTotal,
    verifiedClosingTotal,
    receipts,
    payments,
    externalReceipts,
    externalPayments,
    voucherCount: documents.size,
    unverifiedAccounts,
  };
}

/** Bỏ dấu tiếng Việt + chữ thường để tìm kiếm không phân biệt dấu. */
export function foldSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function lineMatches(line: LedgerLine, folded: string): boolean {
  return [
    line.documentNo,
    line.invoiceNo,
    line.description,
    line.partnerCode,
    line.partnerName,
  ].some((field) => field && foldSearchText(field).includes(folded));
}

export function compareLines(a: LedgerLine, b: LedgerLine): number {
  return (
    a.postingDate.localeCompare(b.postingDate) ||
    (a.documentDate ?? '').localeCompare(b.documentDate ?? '') ||
    a.documentNo.localeCompare(b.documentNo) ||
    a.key.localeCompare(b.key)
  );
}

/**
 * Cột tài khoản của một sổ: tài khoản đang dùng, cộng tài khoản đã ngừng nhưng
 * còn số dư hoặc còn phát sinh trong kỳ (không được mất số liệu lịch sử).
 */
export function selectLedgerAccounts(
  accounts: CashAccountInfo[],
  group: CashGroup,
  balances: Map<string, AccountBalance>,
  accountCode?: string,
): CashAccountInfo[] {
  return accounts
    .filter((account) => account.groupCode === group)
    .filter((account) => !accountCode || account.code === accountCode)
    .filter((account) => {
      if (account.isActive) return true;
      const balance = balances.get(account.code);
      return (
        !!balance &&
        (balance.lineCount > 0 ||
          (balance.opening !== null && balance.opening !== 0n) ||
          (balance.closing !== null && balance.closing !== 0n))
      );
    })
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.code.localeCompare(b.code, undefined, { numeric: true }),
    );
}

export interface LedgerRowsResult {
  rows: LedgerLine[];
  /** Tổng thu/chi từng tài khoản trên TẤT CẢ dòng đã lọc (không theo trang). */
  totals: Map<string, { receipts: Cents; payments: Cents }>;
  totalRows: number;
}

export function filterLedgerRows(
  lines: LedgerLine[],
  accountCodes: string[],
  range: ReportRange,
  search?: string,
): LedgerRowsResult {
  const codes = new Set(accountCodes);
  const folded = search ? foldSearchText(search) : '';
  const rows = lines
    .filter(
      (line) =>
        codes.has(line.accountCode) &&
        line.postingDate >= range.from &&
        line.postingDate <= range.to &&
        (!folded || lineMatches(line, folded)),
    )
    .sort(compareLines);

  const totals = new Map<string, { receipts: Cents; payments: Cents }>();
  for (const code of accountCodes) {
    totals.set(code, { receipts: 0n, payments: 0n });
  }
  for (const row of rows) {
    const total = totals.get(row.accountCode)!;
    total.receipts += row.receipt;
    total.payments += row.payment;
  }

  return { rows, totals, totalRows: rows.length };
}
