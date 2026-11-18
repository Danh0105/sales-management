import { ManualEntryKind } from './cash-manual-entry.entity';
import { toCents } from './cashflow-money';
import { CollectedLedger, LedgerLine } from './cashflow.types';

/** Bút toán nhập tay còn hiệu lực. */
export interface ManualEntryRow {
  id: number;
  kind: ManualEntryKind;
  entry_date: string;
  account_code: string;
  counter_account_code: string | null;
  amount: string;
  document_no: string | null;
  description: string;
  partner_name: string | null;
}

/** Dòng đã xoá (xoá mềm) không vào sổ. */
export const MANUAL_ENTRIES_SQL = `
SELECT id,
  kind,
  to_char(entry_date, 'YYYY-MM-DD') AS entry_date,
  account_code,
  counter_account_code,
  amount::text AS amount,
  document_no,
  description,
  partner_name
FROM cash_manual_entries
WHERE deleted_at IS NULL
ORDER BY entry_date, id`;

const DOCUMENT_PREFIX: Record<ManualEntryKind, string> = {
  IN: 'PT',
  OUT: 'PC',
  TRANSFER: 'CK',
};

/** Số chứng từ người nhập; trống thì PT-/PC-/CK-<id>. */
export function manualDocumentNo(
  row: Pick<ManualEntryRow, 'id' | 'kind' | 'document_no'>,
): string {
  return row.document_no || `${DOCUMENT_PREFIX[row.kind]}-${row.id}`;
}

/**
 * Thu / Chi: một bút toán trên tài khoản đã chọn. Chuyển nội bộ: hai bút toán
 * (chi ở tài khoản chuyển đi, thu ở tài khoản nhận), đánh dấu nội bộ để tổng
 * thu chi có thể loại trừ. Mã lạ do validateLines xử lý.
 */
export function mapManualEntries(rows: ManualEntryRow[]): CollectedLedger {
  const lines: LedgerLine[] = [];

  for (const row of rows) {
    const amount = toCents(row.amount);
    if (amount <= 0n) continue;
    const base = {
      postingDate: row.entry_date,
      documentDate: row.entry_date,
      documentNo: manualDocumentNo(row),
      invoiceNo: null,
      description: row.description,
      partnerCode: null,
      partnerName: row.partner_name,
      source: { type: 'MANUAL_ENTRY' as const, manualEntryId: row.id },
    };
    if (row.kind === 'TRANSFER' && row.counter_account_code) {
      lines.push(
        {
          ...base,
          key: `MANUAL_ENTRY:${row.id}:OUT`,
          accountCode: row.account_code,
          receipt: 0n,
          payment: amount,
          isInternalTransfer: true,
        },
        {
          ...base,
          key: `MANUAL_ENTRY:${row.id}:IN`,
          accountCode: row.counter_account_code,
          receipt: amount,
          payment: 0n,
          isInternalTransfer: true,
        },
      );
      continue;
    }
    const isReceipt = row.kind === 'IN';
    lines.push({
      ...base,
      key: `MANUAL_ENTRY:${row.id}`,
      accountCode: row.account_code,
      receipt: isReceipt ? amount : 0n,
      payment: isReceipt ? 0n : amount,
      isInternalTransfer: false,
    });
  }

  return { lines, issues: [] };
}
