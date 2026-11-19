import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Phần "Đã chi" của dòng Chi Ngoài do đề xuất chi tháng ghi vào (bảng
 * `management_expense_suggest_payments`). Cột `paidAmount` của dòng là tổng nhập
 * tay + đề xuất; phần đề xuất được khoá ở mọi đường lưu và không vào sổ thu chi
 * lần nữa vì đề xuất đã có bút toán xuất tiền riêng.
 */

export interface SuggestPaymentInfo {
  suggestId: number;
  suggestCode: string | null;
  amount: number;
  /** YYYY-MM-DD */
  paidDate: string;
  cashAccount: string | null;
}

export interface ItemSuggestPayments {
  /** Tổng Đã chi do đề xuất ghi vào dòng. */
  total: number;
  /** Lần ghi gần nhất — hiện ở ô Ngày chi / Nguồn chi. */
  latest: SuggestPaymentInfo;
  payments: SuggestPaymentInfo[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Bảng dòng chi của QL thu chi mà đề xuất chi ghi tiền vào, kèm bảng liên kết.
 * Chi Ngoài (đề xuất chi tháng) có từ 12/11/2026; Chi Trường và Giáo viên
 * trường từ 13/11/2026. Chi Ngoài và Chi Trường cùng tên cột tiền
 * (`paidAmount`, `expenseDate`, `cashAccount`).
 */
export const SUGGEST_PAYMENT_TABLES = {
  MANAGEMENT: {
    items: 'management_expense_items',
    payments: 'management_expense_suggest_payments',
    fk: 'management_expense_item_id',
    label: 'Chi Ngoài',
  },
  SCHOOL_EXPENSE: {
    items: 'school_expense_items',
    payments: 'school_expense_suggest_payments',
    fk: 'school_expense_item_id',
    label: 'Chi Trường',
  },
  SCHOOL_TEACHER: {
    items: 'school_teacher_expense_items',
    payments: 'school_teacher_suggest_payments',
    fk: 'school_teacher_expense_item_id',
    label: 'Giáo viên trường',
  },
} as const;

export type SuggestPaymentTable = keyof typeof SUGGEST_PAYMENT_TABLES;
/** Bảng có cột Đã chi (`paidAmount`) — Giáo viên trường không có. */
export type PaidSheetTable = Exclude<SuggestPaymentTable, 'SCHOOL_TEACHER'>;

/** SQL: tổng Đã chi do đề xuất ghi vào dòng `alias` (mặc định bảng Chi Ngoài). */
export const suggestPaidOfRowSql = (
  alias: string,
  table: SuggestPaymentTable = 'MANAGEMENT',
) => {
  const { payments, fk } = SUGGEST_PAYMENT_TABLES[table];
  return `(SELECT COALESCE(SUM(sp.amount), 0) FROM ${payments} sp
    WHERE sp.${fk} = ${alias}.id)`;
};

export async function loadSuggestPayments(
  manager: EntityManager,
  itemIds: number[],
  table: SuggestPaymentTable = 'MANAGEMENT',
): Promise<Map<number, ItemSuggestPayments>> {
  const ids = [...new Set(itemIds.filter((id) => Number.isInteger(id) && id > 0))];
  const result = new Map<number, ItemSuggestPayments>();
  if (!ids.length) return result;
  const { payments, fk } = SUGGEST_PAYMENT_TABLES[table];

  const rows = await manager.query<
    {
      item_id: number;
      suggest_id: number;
      code: string | null;
      amount: string;
      paid_date: string;
      cash_account: string | null;
    }[]
  >(
    `SELECT p.${fk} AS item_id, p.suggest_id, s.code,
       p.amount::text AS amount, to_char(p.paid_date, 'YYYY-MM-DD') AS paid_date,
       p.cash_account
     FROM ${payments} p
     JOIN suggest s ON s.id = p.suggest_id
     WHERE p.${fk} = ANY($1)
     ORDER BY p.paid_date, p.id`,
    [ids],
  );

  for (const row of rows) {
    const itemId = Number(row.item_id);
    const payment: SuggestPaymentInfo = {
      suggestId: Number(row.suggest_id),
      suggestCode: row.code,
      amount: Number(row.amount),
      paidDate: row.paid_date,
      cashAccount: row.cash_account,
    };
    const current = result.get(itemId);
    if (current) {
      current.payments.push(payment);
      current.total = round2(current.total + payment.amount);
      current.latest = payment;
    } else {
      result.set(itemId, {
        total: payment.amount,
        latest: payment,
        payments: [payment],
      });
    }
  }
  return result;
}

/**
 * Dòng trả về cho màn hình: dòng có tiền từ đề xuất chi thì ô Ngày chi / Nguồn
 * chi hiện lần ghi gần nhất, kèm mã đề xuất để màn hình khoá 3 ô (server cũng
 * bỏ qua 3 ô này khi lưu). Cột của dòng trong DB vẫn là phần nhập tay.
 */
export function withSuggestPayments<T extends { id: number }>(
  row: T,
  payments: Map<number, ItemSuggestPayments>,
) {
  const found = payments.get(row.id);
  if (!found) return row;
  return {
    ...row,
    expenseDate: found.latest.paidDate,
    cashAccount: found.latest.cashAccount,
    suggestPaidAmount: found.total,
    suggestCodes: suggestCodesLabel(found),
    suggestPayments: found.payments,
    ...suggestSourcesOf(found),
  };
}

/**
 * Đã chi theo đề xuất từ nhiều nguồn chi (19/11/2026): số tiền theo từng tài
 * khoản để màn hình thống kê riêng. Một nguồn thì không trả.
 */
export function suggestSourcesOf(payments: ItemSuggestPayments | undefined) {
  if (!payments) return {};
  const sources: { cashAccount: string | null; amount: number }[] = [];
  for (const payment of payments.payments) {
    const found = sources.find((source) => source.cashAccount === payment.cashAccount);
    if (found) found.amount = round2(found.amount + payment.amount);
    else sources.push({ cashAccount: payment.cashAccount, amount: payment.amount });
  }
  return sources.length > 1 ? { suggestSources: sources } : {};
}

/** Hiện ở ô bị khoá và trong thông báo lỗi. */
export function suggestCodesLabel(payments: ItemSuggestPayments): string {
  const codes = [
    ...new Set(
      payments.payments.map((p) => p.suggestCode ?? `#${p.suggestId}`),
    ),
  ];
  return codes.join(', ');
}

/**
 * Chia số tiền một trường đã chi cho các dòng Chi Ngoài của trường đó, theo
 * thứ tự dòng: mỗi dòng nhận tối đa Còn chi của nó. Bảng đã giảm sau khi
 * Giám đốc duyệt thì phần dư cộng vào dòng cuối được chia (tiền đã chi thật,
 * Còn chi âm cho thấy chỗ lệch); bảng không còn dòng nào thì không chia được.
 */
export function allocateSuggestPayment(
  rows: { itemId: number; remaining: number }[],
  amount: number,
): { allocations: { itemId: number; amount: number }[]; unallocated: number } {
  let left = round2(Math.max(0, Number(amount) || 0));
  const allocations: { itemId: number; amount: number }[] = [];
  if (left <= 0) return { allocations, unallocated: 0 };

  for (const row of rows) {
    if (left <= 0) break;
    const share = round2(Math.min(Math.max(0, Number(row.remaining) || 0), left));
    if (share <= 0) continue;
    allocations.push({ itemId: row.itemId, amount: share });
    left = round2(left - share);
  }

  if (left > 0) {
    const last = allocations[allocations.length - 1];
    if (last) {
      last.amount = round2(last.amount + left);
    } else if (rows.length) {
      allocations.push({ itemId: rows[rows.length - 1].itemId, amount: left });
    } else {
      return { allocations, unallocated: left };
    }
  }
  return { allocations, unallocated: 0 };
}

/** Dòng Chi Ngoài có tiền từ đề xuất, đọc lại trong transaction để khoá ô. */
export interface LinkedManagementRow {
  /** Tổng Đã chi của dòng (nhập tay + đề xuất). */
  paidAmount: number;
  /** Ngày chi / Nguồn chi nhập tay của dòng (đề xuất có ngày + tài khoản riêng). */
  expenseDate: string | null;
  cashAccount: string | null;
  payments: ItemSuggestPayments;
}

/**
 * Ô Ngày chi / Nguồn chi / Đã chi của dòng có tiền từ đề xuất: giữ đúng giá trị
 * trên server, bỏ qua số client gửi (Còn lại tính lại theo Chi ngoài mới).
 */
export function keepLinkedPaymentFields<T extends Record<string, any>>(
  data: T,
  linked: LinkedManagementRow,
  totalOutside: number,
): T {
  return {
    ...data,
    paidAmount: linked.paidAmount,
    expenseDate: linked.expenseDate,
    cashAccount: linked.cashAccount,
    remaining: totalOutside - linked.paidAmount,
  };
}

export async function loadLinkedManagementRows(
  manager: EntityManager,
  where: { schoolExpenseId: number; subjectId?: number | null } | { itemIds: number[] },
  table: PaidSheetTable = 'MANAGEMENT',
): Promise<Map<number, LinkedManagementRow>> {
  const { items } = SUGGEST_PAYMENT_TABLES[table];
  const rows = await manager.query<
    { id: number; paid: string; expense_date: string | null; cash_account: string | null }[]
  >(
    `SELECT id, "paidAmount"::text AS paid,
       to_char("expenseDate", 'YYYY-MM-DD') AS expense_date,
       "cashAccount" AS cash_account
     FROM ${items}
     WHERE ${
       'itemIds' in where
         ? 'id = ANY($1)'
         : where.subjectId
           ? 'school_expense_id = $1 AND subject_id = $2'
           : 'school_expense_id = $1'
     }`,
    'itemIds' in where
      ? [where.itemIds]
      : where.subjectId
        ? [where.schoolExpenseId, where.subjectId]
        : [where.schoolExpenseId],
  );
  const payments = await loadSuggestPayments(
    manager,
    rows.map((row) => Number(row.id)),
    table,
  );
  const result = new Map<number, LinkedManagementRow>();
  for (const row of rows) {
    const found = payments.get(Number(row.id));
    if (!found) continue;
    result.set(Number(row.id), {
      paidAmount: Number(row.paid),
      expenseDate: row.expense_date,
      cashAccount: row.cash_account,
      payments: found,
    });
  }
  return result;
}

/**
 * Bảng Chi Ngoài chưa khoá được lưu bằng cách xoá rồi tạo lại dòng; dòng có tiền
 * từ đề xuất phải còn trong dữ liệu gửi lên (khớp id), không thì là bị xoá.
 */
export function assertLinkedRowsKept(
  linked: Map<number, { payments: ItemSuggestPayments }>,
  items: unknown,
  table: SuggestPaymentTable = 'MANAGEMENT',
) {
  const sent = new Set(
    (Array.isArray(items) ? items : [])
      .map((item: any) => Number(item?.id))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
  for (const [id, row] of linked) {
    if (!sent.has(id)) throw linkedRowDeleteError(row.payments, table);
  }
}

export function linkedRowDeleteError(
  payments: ItemSuggestPayments,
  table: SuggestPaymentTable = 'MANAGEMENT',
) {
  return new BadRequestException(
    `Có dòng ${SUGGEST_PAYMENT_TABLES[table].label} đã chi theo đề xuất ${suggestCodesLabel(payments)} nên không xoá được. ` +
      'Nếu bảng vừa được người khác cập nhật, hãy tải lại trang rồi lưu lại.',
  );
}

/** Dòng Giáo viên trường đã được đề xuất chi trả: Ngày chi / Nguồn chi là của đề xuất. */
export interface LinkedTeacherRow {
  expenseDate: string | null;
  cashAccount: string | null;
  payments: ItemSuggestPayments;
}

export async function loadLinkedTeacherRows(
  manager: EntityManager,
  where: { schoolExpenseId: number; subjectId?: number | null } | { itemIds: number[] },
): Promise<Map<number, LinkedTeacherRow>> {
  const rows = await manager.query<
    { id: number; expense_date: string | null; cash_account: string | null }[]
  >(
    `SELECT t.id, to_char(t.expense_date, 'YYYY-MM-DD') AS expense_date, t.cash_account
     FROM school_teacher_expense_items t
     WHERE ${
       'itemIds' in where
         ? 't.id = ANY($1)'
         : where.subjectId
           ? 't.school_expense_id = $1 AND t.subject_id = $2'
           : 't.school_expense_id = $1'
     }
       AND EXISTS (SELECT 1 FROM school_teacher_suggest_payments sp
                   WHERE sp.school_teacher_expense_item_id = t.id)`,
    'itemIds' in where
      ? [where.itemIds]
      : where.subjectId
        ? [where.schoolExpenseId, where.subjectId]
        : [where.schoolExpenseId],
  );
  const payments = await loadSuggestPayments(
    manager,
    rows.map((row) => Number(row.id)),
    'SCHOOL_TEACHER',
  );
  const result = new Map<number, LinkedTeacherRow>();
  for (const row of rows) {
    const found = payments.get(Number(row.id));
    if (!found) continue;
    result.set(Number(row.id), {
      expenseDate: row.expense_date,
      cashAccount: row.cash_account,
      payments: found,
    });
  }
  return result;
}
