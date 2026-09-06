export enum SuggestStatus {
  // ===== luồng đề xuất thường (SUGGESTION) =====
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  REVIEWED = 'REVIEWED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',

  // ===== luồng đề xuất chi (EXPENSE_REQUEST) =====
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  PAYMENT_ORDERED = 'PAYMENT_ORDERED',
  CASH_RELEASED = 'CASH_RELEASED',
  CASH_RECEIVED = 'CASH_RECEIVED',
  SPENT = 'SPENT',
  NOT_SPENT = 'NOT_SPENT',
  FUND_RETURNED = 'FUND_RETURNED',
  /** Người tạo tự rút đơn — tách khỏi REJECTED để không lẫn với việc bị giám đốc từ chối. */
  WITHDRAWN = 'WITHDRAWN',
}

/** Trạng thái kết thúc của luồng đề xuất chi — không nhắc/cảnh báo nữa */
export const EXPENSE_TERMINAL_STATUSES: SuggestStatus[] = [
  SuggestStatus.SPENT,
  SuggestStatus.REJECTED,
  SuggestStatus.WITHDRAWN,
];
