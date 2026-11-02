import { formatVnd } from '../financial-request/financial-money';
import { DayClosingBalance } from './cash-day-closing.entity';
import { computeBalances } from './cashflow-ledger';
import { Cents, centsToNumber, centsToString, toCents } from './cashflow-money';
import { CashAccountInfo, LedgerIssue, LedgerLine } from './cashflow.types';

const vnd = (cents: Cents) =>
  `${formatVnd(Math.round(centsToNumber(cents)))} đ`;

export const vnDate = (date: string) => date.split('-').reverse().join('/');

/** Ảnh số dư cuối một ngày của mọi tài khoản (tính như báo cáo với kỳ [ngày, ngày]). */
export function snapshotDay(
  accounts: CashAccountInfo[],
  lines: LedgerLine[],
  date: string,
): DayClosingBalance[] {
  const balances = computeBalances(accounts, lines, { from: date, to: date });
  return accounts.map((account) => {
    const balance = balances.get(account.code)!;
    return {
      code: account.code,
      name: account.name,
      groupCode: account.groupCode,
      opening: balance.opening === null ? null : centsToString(balance.opening),
      receipts: centsToString(balance.receipts),
      payments: centsToString(balance.payments),
      closing: balance.closing === null ? null : centsToString(balance.closing),
      lineCount: balance.lineCount,
    };
  });
}

/**
 * So thu/chi hiện tại của các ngày đã chốt với ảnh lúc chốt. Lệch = có phân
 * hệ khác ghi/sửa/xoá khoản thu chi của ngày đó sau khi chốt → cảnh báo (vẫn
 * tính số liệu hiện tại). Không so số dư: sửa số dư gốc là việc hợp lệ.
 */
export function closedDayIssues(
  closings: { date: string; balances: DayClosingBalance[] }[],
  lines: LedgerLine[],
): LedgerIssue[] {
  const issues: LedgerIssue[] = [];
  for (const closing of closings) {
    const current = new Map<string, { receipts: Cents; payments: Cents }>();
    for (const line of lines) {
      if (line.postingDate !== closing.date) continue;
      const total = current.get(line.accountCode) ?? {
        receipts: 0n,
        payments: 0n,
      };
      total.receipts += line.receipt;
      total.payments += line.payment;
      current.set(line.accountCode, total);
    }
    const snapshot = new Map(closing.balances.map((b) => [b.code, b]));
    const codes = new Set([...current.keys(), ...snapshot.keys()]);
    for (const code of [...codes].sort()) {
      const before = snapshot.get(code);
      const beforeReceipts = before ? toCents(before.receipts) : 0n;
      const beforePayments = before ? toCents(before.payments) : 0n;
      const now = current.get(code) ?? { receipts: 0n, payments: 0n };
      if (now.receipts === beforeReceipts && now.payments === beforePayments) {
        continue;
      }
      issues.push({
        key: `DAY_CLOSING:${closing.date}:${code}`,
        kind: 'CLOSED_DAY_CHANGED',
        message:
          `Ngày ${vnDate(closing.date)} đã chốt quỹ nhưng số liệu bị đổi sau khi chốt — ` +
          `thu ${vnd(beforeReceipts)} → ${vnd(now.receipts)}, chi ${vnd(beforePayments)} → ${vnd(now.payments)}`,
        warningOnly: true,
        date: closing.date,
        amount: now.receipts - now.payments - (beforeReceipts - beforePayments),
        accountCode: code,
        documentNo: `CHOT-${closing.date}`,
        description: `Chốt quỹ ngày ${vnDate(closing.date)} — tài khoản ${code}`,
        source: { type: 'DAY_CLOSING' },
      });
    }
  }
  return issues;
}
