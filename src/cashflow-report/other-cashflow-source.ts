import {
  CashflowDirection,
  contractCode,
} from '../other-cashflow/other-cashflow.constants';
import { toCents } from './cashflow-money';
import { CollectedLedger, LedgerLine } from './cashflow.types';

/** Một lần thủ quỹ thu/chi của hợp đồng Thu Chi ngoài. */
export interface OtherCashflowEntryRow {
  entry_id: number;
  contract_id: number;
  /** Chiều tiền của chính lần này (hợp đồng có cả khoản thu lẫn khoản chi). */
  flow: CashflowDirection;
  form: string;
  title: string;
  partner_name: string;
  school_id: number | null;
  /** Khoản chi được chi (mọi lần chi). */
  cost_description: string | null;
  cost_payee: string | null;
  entry_date: string;
  amount: string;
  cash_account_code: string;
}

/** Lần thu/chi đã huỷ (VOIDED) không phải bút toán. */
export const OTHER_CASHFLOW_ENTRIES_SQL = `
SELECT e.id AS entry_id,
  c.id AS contract_id,
  e.flow,
  c.form,
  c.title,
  c.partner_name,
  c.school_id,
  k.description AS cost_description,
  k.payee AS cost_payee,
  to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
  e.amount::text AS amount,
  e.cash_account_code
FROM other_cashflow_entries e
JOIN other_cashflow_contracts c ON c.id = e.contract_id
LEFT JOIN other_cashflow_costs k ON k.id = e.cost_id
WHERE e.status = 'RECORDED'
ORDER BY e.entry_date, c.id, e.id`;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Thu Chi ngoài: mỗi lần thu/chi còn hiệu lực là một bút toán theo ngày và
 * tài khoản thủ quỹ chọn (bắt buộc nên không có mục "chưa chọn tài khoản";
 * mã lạ do validateLines xử lý). Lần thu: đối tượng = đối tác của hợp đồng.
 * Lần chi gắn một khoản chi: đối tượng = người nhận của khoản đó, không ghi
 * thì là đối tác. Hợp đồng Chi lập trước khi gộp có một khoản chi trùng tên
 * hợp đồng — diễn giải giữ như cũ.
 */
export function mapOtherCashflowEntries(
  rows: OtherCashflowEntryRow[],
): CollectedLedger {
  const lines: LedgerLine[] = [];

  for (const row of rows) {
    const amount = toCents(row.amount);
    if (amount <= 0n) continue;
    const isReceipt = row.flow === CashflowDirection.IN;
    const kind = `${isReceipt ? 'Thu' : 'Chi'} ngoài${row.form === 'COMMERCIAL' ? ' (thương mại)' : ''}`;
    const payee = row.cost_payee || null;
    const cost =
      !isReceipt && row.cost_description && row.cost_description !== row.title
        ? `${row.cost_description} — `
        : '';
    const description = `${kind} — ${cost}${row.title} — ${payee ?? row.partner_name}`;
    lines.push({
      key: `OTHER_CASHFLOW:${row.entry_id}`,
      postingDate: row.entry_date,
      documentDate: row.entry_date,
      documentNo: contractCode(row.contract_id),
      invoiceNo: null,
      description: clean(description),
      accountCode: row.cash_account_code,
      receipt: isReceipt ? amount : 0n,
      payment: isReceipt ? 0n : amount,
      partnerCode: !payee && row.school_id ? `TR${row.school_id}` : null,
      partnerName: payee ?? row.partner_name,
      isInternalTransfer: false,
      source: { type: 'OTHER_CASHFLOW', otherCashflowId: row.contract_id },
    });
  }

  return { lines, issues: [] };
}
