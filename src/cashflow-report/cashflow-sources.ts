import { Cents, toCents } from './cashflow-money';
import {
  CollectedLedger,
  LedgerIssue,
  LedgerIssueKind,
  LedgerLine,
  LedgerSourceRef,
} from './cashflow.types';

/**
 * Bút toán thu chi lấy từ nghiệp vụ đang có — không có bảng sổ quỹ riêng:
 * - Hóa Đơn (revenue_items): "Thu/Chi" + "Số tiền" + "Ngày chi" + "Khoản thu/chi".
 * - Chi Trường (school_expense_items): "Đã chi" + "Ngày chi" + "Nguồn chi".
 * - Chi Ngoài (management_expense_items): "Đã chi" + "Ngày chi" + "Nguồn chi".
 * - Đề nghị chi (suggest_history): mỗi lần thủ quỹ xác nhận xuất tiền là một
 *   bút toán chi, mỗi lần nhận lại quỹ là một bút toán thu cùng tài khoản.
 * - Đề nghị tài chính nội bộ: phiếu chi đã ghi nhận là bút toán chi, phiếu
 *   hoàn trả đã ghi nhận là bút toán thu; phiếu đã huỷ không được tính.
 * Ngày lấy theo giờ Việt Nam (timezone của DB). Thiếu thông tin thì thành lỗi
 * trong danh sách "Chưa phân loại" — không đoán tài khoản.
 */

/** Số tiền ≥ 10 tỷ đồng trên một bút toán: vẫn tính, nhưng cảnh báo để kế toán xác nhận. */
export const SUSPICIOUS_AMOUNT_CENTS: Cents = 10_000_000_000n * 100n;

export interface SchoolRowContext {
  school_expense_id: number;
  school_id: number | null;
  school_name: string | null;
  subject_id: number | null;
  subject_name: string | null;
  period_month: number | null;
  period_year: number | null;
  /** id của dòng trong bảng nguồn (revenue_items / school_expense_items / management_expense_items). */
  item_id: number;
  row_index: number;
}

export interface InvoiceRow extends SchoolRowContext {
  content: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  cash_date: string | null;
  cash_account: string | null;
  cash_direction: string | null;
  cash_amount: string | null;
  paid_amount: string | null;
}

export interface ExpenseRow extends SchoolRowContext {
  paid_amount: string | null;
  expense_date: string | null;
  cash_account: string | null;
  payer?: string | null;
}

/** Phần `suggest_history.data` báo cáo đọc tới. */
export interface SuggestEventData {
  paymentOrder?: { code?: string; amount?: number | string | null };
  cashAccount?: string | null;
  fundSource?: string | null;
}

export interface SuggestEventRow {
  history_id: number;
  suggest_id: number;
  action: string;
  event_date: string;
  data: SuggestEventData | null;
  suggest_code: string | null;
  content: string | null;
  requester_id: number | null;
  requester_name: string | null;
  po_code: string | null;
  po_amount: string | null;
  po_cash_account: string | null;
  po_created_date: string | null;
}

export interface FinancialMovementRow {
  direction: 'PAYMENT' | 'REFUND';
  movement_id: number;
  request_id: number;
  request_code: string;
  request_type: string;
  title: string;
  posting_date: string | null;
  cash_account: string | null;
  amount: string | null;
  transaction_ref: string | null;
  requester_id: number;
  requester_code: string | null;
  requester_name: string;
}

const ROW_CONTEXT_SELECT = `
  se.id AS school_expense_id,
  s.id AS school_id,
  s.name AS school_name,
  sub.id AS subject_id,
  sub.name AS subject_name,
  ep.month AS period_month,
  ep.year AS period_year`;

const ROW_CONTEXT_JOINS = `
  JOIN school_expenses se ON se.id = t.school_expense_id
  LEFT JOIN schools s ON s.id = se.school_id
  LEFT JOIN subjects sub ON sub.id = t.subject_id
  LEFT JOIN expense_periods ep ON ep.id = se.period_id`;

/** Dòng doanh thu có khoản thu/chi ở Hóa Đơn, hoặc đã thu mà chưa ghi tài khoản. */
export const INVOICE_ROWS_SQL = `
SELECT ${ROW_CONTEXT_SELECT},
  t.id AS item_id,
  t."rowIndex" AS row_index,
  t.content,
  t."invoiceNumber" AS invoice_number,
  to_char(t."invoiceDate", 'YYYY-MM-DD') AS invoice_date,
  to_char(t."invoicePaymentDate", 'YYYY-MM-DD') AS cash_date,
  t."invoiceCashAccount" AS cash_account,
  t."invoiceCashDirection" AS cash_direction,
  t."invoiceCashAmount"::text AS cash_amount,
  t."paidAmount"::text AS paid_amount
FROM revenue_items t ${ROW_CONTEXT_JOINS}
WHERE t."invoiceCashDirection" IS NOT NULL
   OR t."invoiceCashAmount" IS NOT NULL
   OR t."invoiceCashAccount" IS NOT NULL
   OR t."paidAmount" > 0`;

export const SCHOOL_EXPENSE_ROWS_SQL = `
SELECT ${ROW_CONTEXT_SELECT},
  t.id AS item_id,
  t."rowIndex" AS row_index,
  t."paidAmount"::text AS paid_amount,
  to_char(t."expenseDate", 'YYYY-MM-DD') AS expense_date,
  t."cashAccount" AS cash_account
FROM school_expense_items t ${ROW_CONTEXT_JOINS}
WHERE t."paidAmount" > 0 OR t."cashAccount" IS NOT NULL`;

export const MANAGEMENT_EXPENSE_ROWS_SQL = `
SELECT ${ROW_CONTEXT_SELECT},
  t.id AS item_id,
  t."rowIndex" AS row_index,
  t."paidAmount"::text AS paid_amount,
  to_char(t."expenseDate", 'YYYY-MM-DD') AS expense_date,
  t."cashAccount" AS cash_account,
  t.payer
FROM management_expense_items t ${ROW_CONTEXT_JOINS}
WHERE t."paidAmount" > 0 OR t."cashAccount" IS NOT NULL`;

export const SUGGEST_EVENTS_SQL = `
SELECT h.id AS history_id,
  h."suggestId" AS suggest_id,
  h.action,
  to_char(h."snapshotAt", 'YYYY-MM-DD') AS event_date,
  h.data,
  s.code AS suggest_code,
  s.content,
  e.id AS requester_id,
  e.name AS requester_name,
  po.code AS po_code,
  po.amount::text AS po_amount,
  po."cashAccount" AS po_cash_account,
  to_char(po."createdAt", 'YYYY-MM-DD') AS po_created_date
FROM suggest_history h
JOIN suggest s ON s.id = h."suggestId"
LEFT JOIN employee e ON e.id = s."createdBy"
LEFT JOIN suggest_payment_order po ON po."suggestId" = s.id
WHERE h.action IN (
  'CREATE_PAYMENT_ORDER', 'EDIT_PAYMENT_ORDER',
  'CREATE_MONTHLY_PAYMENT_ORDER', 'EDIT_MONTHLY_PAYMENT_ORDER',
  'CONFIRM_CASH_RELEASED', 'CONFIRM_FUND_RETURNED'
)
ORDER BY h."suggestId", h."snapshotAt", h.id`;

/**
 * Phiếu chi/thu thực tế của Đề nghị tài chính; không lấy giao dịch đã huỷ.
 * Phiếu chi cũ chưa chụp mã tài khoản thì dùng lựa chọn của Bộ phận kiểm soát.
 */
export const FINANCIAL_MOVEMENTS_SQL = `
SELECT 'PAYMENT' AS direction,
  p.id AS movement_id,
  r.id AS request_id,
  r.code AS request_code,
  r.type AS request_type,
  r.title,
  to_char(p.paid_at, 'YYYY-MM-DD') AS posting_date,
  COALESCE(p.cash_account_code, r.control_cash_account_code) AS cash_account,
  p.amount::text AS amount,
  p.transaction_ref,
  r.requester_id,
  r.requester_code,
  r.requester_name
FROM financial_payments p
JOIN financial_requests r ON r.id = p.request_id
WHERE p.status = 'RECORDED'
UNION ALL
SELECT 'REFUND' AS direction,
  f.id AS movement_id,
  r.id AS request_id,
  r.code AS request_code,
  r.type AS request_type,
  r.title,
  to_char(f.received_at, 'YYYY-MM-DD') AS posting_date,
  f.cash_account_code AS cash_account,
  f.amount::text AS amount,
  f.transaction_ref,
  r.requester_id,
  r.requester_code,
  r.requester_name
FROM financial_refunds f
JOIN financial_requests r ON r.id = f.request_id
WHERE f.status = 'RECORDED'
ORDER BY posting_date, movement_id`;

/** Gom khoảng trắng (tab/xuống dòng nhập kèm nội dung) cho cột Diễn giải. */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function periodLabel(row: SchoolRowContext): string {
  return row.period_month && row.period_year
    ? ` (T${row.period_month}/${row.period_year})`
    : '';
}

function schoolPartner(row: SchoolRowContext) {
  return {
    partnerCode: row.school_id ? `TR${row.school_id}` : null,
    partnerName: row.school_name ?? null,
  };
}

function rowSource(
  type: LedgerSourceRef['type'],
  row: SchoolRowContext,
): LedgerSourceRef {
  return {
    type,
    schoolExpenseId: row.school_expense_id,
    subjectId: row.subject_id,
    rowIndex: row.row_index,
    itemId: row.item_id,
  };
}

function rowDocumentNo(prefix: string, row: SchoolRowContext): string {
  return `${prefix}-${row.school_expense_id}-${row.subject_id ?? 0}-${row.row_index + 1}`;
}

function issue(
  kind: LedgerIssueKind,
  message: string,
  fields: Omit<LedgerIssue, 'kind' | 'message' | 'warningOnly'>,
  warningOnly = false,
): LedgerIssue {
  return { kind, message, warningOnly, ...fields };
}

export function mapInvoiceRows(rows: InvoiceRow[]): CollectedLedger {
  const lines: LedgerLine[] = [];
  const issues: LedgerIssue[] = [];

  for (const row of rows) {
    const key = `INVOICE:${row.school_expense_id}:${row.subject_id}:${row.row_index}`;
    const documentNo = rowDocumentNo('HD', row);
    const source = rowSource('INVOICE', row);
    const what = row.content || row.subject_name || 'Doanh thu';
    const school = row.school_name ? ` — ${row.school_name}` : '';
    const paid = toCents(row.paid_amount);
    const hasCashEntry =
      row.cash_direction !== null ||
      row.cash_amount !== null ||
      row.cash_account !== null;
    const base = {
      key,
      date: row.cash_date,
      accountCode: row.cash_account,
      documentNo,
      source,
    };

    if (hasCashEntry) {
      const amount = row.cash_amount === null ? null : toCents(row.cash_amount);
      const description = clean(
        `${row.cash_direction === 'OUT' ? 'Chi' : 'Thu'} ${what}${school}${periodLabel(row)}`,
      );
      const missing: [LedgerIssueKind, string][] = [];

      if (row.cash_direction !== 'IN' && row.cash_direction !== 'OUT') {
        missing.push(['MISSING_DIRECTION', 'Hóa Đơn chưa chọn Thu/Chi']);
      }
      if (amount === null || amount === 0n) {
        missing.push(['MISSING_AMOUNT', 'Hóa Đơn chưa nhập số tiền thu/chi']);
      }
      if (!row.cash_account) {
        missing.push(['MISSING_ACCOUNT', 'Hóa Đơn chưa chọn Khoản thu/chi']);
      }
      if (!row.cash_date) {
        missing.push(['MISSING_DATE', 'Hóa Đơn chưa nhập Ngày chi']);
      }

      if (missing.length > 0) {
        for (const [kind, message] of missing) {
          issues.push(issue(kind, message, { ...base, amount, description }));
        }
      } else {
        lines.push({
          key,
          postingDate: row.cash_date!,
          documentDate: row.invoice_date ?? row.cash_date,
          documentNo,
          invoiceNo: row.invoice_number,
          description,
          accountCode: row.cash_account!,
          receipt: row.cash_direction === 'IN' ? amount! : 0n,
          payment: row.cash_direction === 'OUT' ? amount! : 0n,
          ...schoolPartner(row),
          isInternalTransfer: false,
          source,
        });
      }
    }

    if (paid > 0n && row.cash_direction !== 'IN') {
      issues.push(
        issue(
          'RECEIPT_NOT_POSTED',
          'Doanh thu có Đã thu nhưng chưa ghi khoản thu vào tài khoản (Hóa Đơn)',
          {
            ...base,
            key: `${key}:paid`,
            date: null,
            accountCode: null,
            amount: paid,
            description: clean(`Thu ${what}${school}${periodLabel(row)}`),
          },
          true,
        ),
      );
    }
  }

  return { lines, issues };
}

export function mapExpenseRows(
  rows: ExpenseRow[],
  type: 'SCHOOL_EXPENSE' | 'MANAGEMENT_EXPENSE',
): CollectedLedger {
  const lines: LedgerLine[] = [];
  const issues: LedgerIssue[] = [];
  const isSchool = type === 'SCHOOL_EXPENSE';
  const label = isSchool ? 'Chi trường' : 'Chi ngoài';
  const tableName = isSchool ? 'Chi Trường' : 'Chi Ngoài';

  for (const row of rows) {
    const amount = toCents(row.paid_amount);
    const key = `${type}:${row.school_expense_id}:${row.subject_id}:${row.row_index}`;
    const documentNo = rowDocumentNo(isSchool ? 'CT' : 'CN', row);
    const source = rowSource(type, row);
    const payer = row.payer ? ` — Người chi: ${row.payer}` : '';
    const description = clean(
      `${label} ${row.subject_name ?? ''}` +
        (row.school_name ? ` — ${row.school_name}` : '') +
        periodLabel(row) +
        payer,
    );
    const base = {
      key,
      date: row.expense_date,
      accountCode: row.cash_account,
      documentNo,
      description,
      source,
      amount,
    };

    if (amount <= 0n) {
      // Đã chọn Nguồn chi nhưng chưa có Đã chi — chưa phải bút toán, bỏ qua.
      continue;
    }
    if (!row.cash_account) {
      issues.push(
        issue(
          'MISSING_ACCOUNT',
          `${tableName} có Đã chi nhưng chưa chọn Nguồn chi`,
          base,
        ),
      );
      continue;
    }
    if (!row.expense_date) {
      issues.push(
        issue(
          'MISSING_DATE',
          `${tableName} có Đã chi nhưng chưa nhập Ngày chi`,
          base,
        ),
      );
      continue;
    }

    lines.push({
      key,
      postingDate: row.expense_date,
      documentDate: row.expense_date,
      documentNo,
      invoiceNo: null,
      description,
      accountCode: row.cash_account,
      receipt: 0n,
      payment: amount,
      ...schoolPartner(row),
      isInternalTransfer: false,
      source,
    });
  }

  return { lines, issues };
}

interface ReleaseState {
  event: SuggestEventRow;
  amount: Cents;
  accountCode: string | null;
  fundSource: string | null;
  /** Đã bị một lần xác nhận xuất tiền sau thay thế. */
  superseded: boolean;
  returned: SuggestEventRow | null;
}

const FUND_SOURCE_LABEL: Record<string, string> = {
  COMPANY_CASH: 'Tiền mặt',
  BANK_ACCOUNT: 'Ngân hàng',
};

/**
 * Dựng các lần xuất tiền / nhận lại quỹ của từng đề nghị chi theo thứ tự thời gian:
 * - số tiền = snapshot lệnh chi gần nhất trước lần xuất (CREATE_PAYMENT_ORDER),
 *   không có thì lấy số tiền lệnh chi hiện tại;
 * - tài khoản = tài khoản thủ quỹ chọn lúc xuất (data.cashAccount); lần xuất
 *   cuối cùng lấy thêm từ lệnh chi hiện tại. Bản ghi cũ chỉ có nhóm nguồn tiền
 *   → GROUP_ONLY;
 * - xuất tiền lần nữa khi chưa nhận lại quỹ (sau khi sửa lệnh chi) là đính
 *   chính: chỉ tính lần cuối, lần trước thành cảnh báo SUPERSEDED_RELEASE;
 * - nhận lại quỹ = bút toán thu, cùng số tiền và tài khoản với lần xuất đang mở.
 */
export function mapSuggestEvents(events: SuggestEventRow[]): CollectedLedger {
  const lines: LedgerLine[] = [];
  const issues: LedgerIssue[] = [];
  const bySuggest = new Map<number, SuggestEventRow[]>();

  for (const event of events) {
    const list = bySuggest.get(event.suggest_id) ?? [];
    list.push(event);
    bySuggest.set(event.suggest_id, list);
  }

  for (const [suggestId, list] of bySuggest) {
    let orderAmount: Cents | null = null;
    let orderCode: string | null = null;
    const releases: ReleaseState[] = [];
    let open: ReleaseState | null = null;
    const lastReleaseId = [...list]
      .reverse()
      .find((event) => event.action === 'CONFIRM_CASH_RELEASED')?.history_id;

    for (const event of list) {
      if (
        event.action === 'CREATE_PAYMENT_ORDER' ||
        event.action === 'CREATE_MONTHLY_PAYMENT_ORDER'
      ) {
        const snapshot = event.data?.paymentOrder;
        orderAmount =
          snapshot?.amount !== undefined && snapshot?.amount !== null
            ? toCents(snapshot.amount)
            : null;
        orderCode = snapshot?.code ?? orderCode;
      } else if (
        event.action === 'EDIT_PAYMENT_ORDER' ||
        event.action === 'EDIT_MONTHLY_PAYMENT_ORDER'
      ) {
        // Không có snapshot số tiền sau khi sửa → dùng lệnh chi hiện tại.
        orderAmount = null;
      } else if (event.action === 'CONFIRM_CASH_RELEASED') {
        if (open) open.superseded = true;
        const accountCode =
          event.data?.cashAccount ??
          (event.history_id === lastReleaseId ? event.po_cash_account : null);
        open = {
          event,
          amount: orderAmount ?? toCents(event.po_amount),
          accountCode: accountCode || null,
          fundSource: event.data?.fundSource ?? null,
          superseded: false,
          returned: null,
        };
        releases.push(open);
      } else if (event.action === 'CONFIRM_FUND_RETURNED' && open) {
        open.returned = event;
        open = null;
      }
    }

    for (const release of releases) {
      const event = release.event;
      const documentNo =
        event.po_code ?? orderCode ?? event.suggest_code ?? `DX${suggestId}`;
      const subject = event.content ? `: ${event.content}` : '';
      const suggestLabel = event.suggest_code ?? `#${suggestId}`;
      const source: LedgerSourceRef = { type: 'EXPENSE_REQUEST', suggestId };
      const partner = {
        partnerCode: event.requester_id ? `NV${event.requester_id}` : null,
        partnerName: event.requester_name ?? null,
      };
      const releaseKey = `EXPENSE_REQUEST:${suggestId}:release:${event.history_id}`;
      const releaseDescription = clean(`Chi đề xuất ${suggestLabel}${subject}`);
      const base = {
        key: releaseKey,
        date: event.event_date,
        amount: release.amount,
        accountCode: release.accountCode,
        documentNo,
        description: releaseDescription,
        source,
      };

      if (release.superseded) {
        issues.push(
          issue(
            'SUPERSEDED_RELEASE',
            'Lệnh chi bị sửa và xác nhận xuất tiền lại — chỉ tính lần xuất tiền sau',
            base,
            true,
          ),
        );
        continue;
      }

      if (!release.accountCode) {
        const group = release.fundSource
          ? FUND_SOURCE_LABEL[release.fundSource]
          : null;
        issues.push(
          group
            ? issue(
                'GROUP_ONLY',
                `Chỉ biết nguồn tiền "${group}", chưa có tài khoản cụ thể`,
                base,
              )
            : issue('MISSING_ACCOUNT', 'Xuất tiền chưa có nguồn chi', base),
        );
        continue;
      }

      lines.push({
        key: releaseKey,
        postingDate: event.event_date,
        documentDate: event.po_created_date ?? event.event_date,
        documentNo,
        invoiceNo: null,
        description: releaseDescription,
        accountCode: release.accountCode,
        receipt: 0n,
        payment: release.amount,
        ...partner,
        isInternalTransfer: false,
        source,
      });

      if (release.returned) {
        lines.push({
          key: `EXPENSE_REQUEST:${suggestId}:return:${release.returned.history_id}`,
          postingDate: release.returned.event_date,
          documentDate: release.returned.event_date,
          documentNo,
          invoiceNo: null,
          description: clean(`Hoàn quỹ đề xuất ${suggestLabel}${subject}`),
          accountCode: release.accountCode,
          receipt: release.amount,
          payment: 0n,
          ...partner,
          isInternalTransfer: false,
          source,
        });
      }
    }
  }

  return { lines, issues };
}

/** Chuyển các lần chi/hoàn trả của Đề nghị tài chính thành bút toán quỹ. */
export function mapFinancialMovements(
  rows: FinancialMovementRow[],
): CollectedLedger {
  const lines: LedgerLine[] = [];
  const issues: LedgerIssue[] = [];

  for (const row of rows) {
    const amount = toCents(row.amount);
    const isReceipt = row.direction === 'REFUND';
    const key = `FINANCIAL_REQUEST:${row.direction}:${row.movement_id}`;
    const source: LedgerSourceRef = {
      type: 'FINANCIAL_REQUEST',
      requestId: row.request_id,
    };
    const description = clean(
      `${isReceipt ? 'Thu hoàn trả' : 'Chi đề nghị tài chính'} ${row.request_code}: ${row.title}`,
    );
    const base = {
      key,
      date: row.posting_date,
      amount,
      accountCode: row.cash_account,
      documentNo: row.request_code,
      description,
      source,
    };

    if (amount <= 0n) continue;
    if (!row.cash_account) {
      issues.push(
        issue(
          'MISSING_ACCOUNT',
          `${isReceipt ? 'Phiếu hoàn trả' : 'Phiếu chi'} chưa có tài khoản tiền`,
          base,
        ),
      );
      continue;
    }
    if (!row.posting_date) {
      issues.push(
        issue(
          'MISSING_DATE',
          `${isReceipt ? 'Phiếu hoàn trả' : 'Phiếu chi'} chưa có ngày hạch toán`,
          base,
        ),
      );
      continue;
    }

    lines.push({
      key,
      postingDate: row.posting_date,
      documentDate: row.posting_date,
      documentNo: row.request_code,
      invoiceNo: row.transaction_ref,
      description,
      accountCode: row.cash_account,
      receipt: isReceipt ? amount : 0n,
      payment: isReceipt ? 0n : amount,
      partnerCode: row.requester_code ?? `NV${row.requester_id}`,
      partnerName: row.requester_name,
      isInternalTransfer: false,
      source,
    });
  }

  return { lines, issues };
}

/** Cảnh báo (không loại) các bút toán / mục chưa phân loại có số tiền lớn bất thường. */
export function flagSuspiciousAmounts(
  collected: CollectedLedger,
): CollectedLedger {
  const flagged: LedgerIssue[] = [];

  for (const line of collected.lines) {
    const amount = line.receipt > 0n ? line.receipt : line.payment;
    if (amount >= SUSPICIOUS_AMOUNT_CENTS) {
      flagged.push(
        issue(
          'SUSPICIOUS_AMOUNT',
          'Số tiền lớn bất thường (≥ 10 tỷ) — cần kiểm tra',
          {
            key: `${line.key}:suspicious`,
            date: line.postingDate,
            amount,
            accountCode: line.accountCode,
            documentNo: line.documentNo,
            description: line.description,
            source: line.source,
          },
          true,
        ),
      );
    }
  }
  for (const item of collected.issues) {
    if (item.amount !== null && item.amount >= SUSPICIOUS_AMOUNT_CENTS) {
      flagged.push(
        issue(
          'SUSPICIOUS_AMOUNT',
          'Số tiền lớn bất thường (≥ 10 tỷ) — cần kiểm tra',
          {
            key: `${item.key}:suspicious`,
            date: item.date,
            amount: item.amount,
            accountCode: item.accountCode,
            documentNo: item.documentNo,
            description: item.description,
            source: item.source,
          },
          true,
        ),
      );
    }
  }

  return { lines: collected.lines, issues: [...collected.issues, ...flagged] };
}
