import { Cents } from './cashflow-money';

/** 111 = tiền mặt, 112 = tiền gửi ngân hàng. */
export type CashGroup = '111' | '112';

export interface CashAccountInfo {
  code: string;
  name: string;
  groupCode: CashGroup;
  sortOrder: number;
  isActive: boolean;
  /** Số dư tại ĐẦU ngày `openingBalanceDate` (trước mọi phát sinh của ngày đó). */
  openingBalance: Cents | null;
  /** YYYY-MM-DD; null khi chưa có số dư gốc đã xác minh. */
  openingBalanceDate: string | null;
}

export type LedgerSourceType =
  | 'INVOICE'
  | 'SCHOOL_EXPENSE'
  | 'MANAGEMENT_EXPENSE'
  | 'EXPENSE_REQUEST'
  | 'FINANCIAL_REQUEST'
  | 'OTHER_CASHFLOW';

/** Chỗ mở chứng từ gốc từ báo cáo. */
export interface LedgerSourceRef {
  type: LedgerSourceType;
  schoolExpenseId?: number;
  subjectId?: number | null;
  rowIndex?: number;
  suggestId?: number;
  requestId?: number;
  /** Hợp đồng Thu Chi ngoài. */
  otherCashflowId?: number;
}

/** Một bút toán ghi tăng (thu) hoặc ghi giảm (chi) đúng một tài khoản. */
export interface LedgerLine {
  /** Định danh ổn định, dùng để chống cộng trùng. */
  key: string;
  /** Ngày hạch toán, YYYY-MM-DD theo giờ Việt Nam. */
  postingDate: string;
  documentDate: string | null;
  documentNo: string;
  invoiceNo: string | null;
  description: string;
  accountCode: string;
  receipt: Cents;
  payment: Cents;
  partnerCode: string | null;
  partnerName: string | null;
  /** Chuyển tiền nội bộ — chưa có nguồn dữ liệu, luôn false ở đợt này. */
  isInternalTransfer: boolean;
  source: LedgerSourceRef;
}

export type LedgerIssueKind =
  /** Có tiền nhưng chưa chọn tài khoản. */
  | 'MISSING_ACCOUNT'
  /** Có tiền + tài khoản nhưng thiếu ngày. */
  | 'MISSING_DATE'
  /** Hóa Đơn: đã chọn tài khoản/hướng/ngày nhưng chưa nhập số tiền. */
  | 'MISSING_AMOUNT'
  /** Hóa Đơn: chưa chọn Thu/Chi. */
  | 'MISSING_DIRECTION'
  /** Mã tài khoản không có trong danh mục. */
  | 'UNKNOWN_ACCOUNT'
  /** Đề nghị chi trước khi có cột tài khoản: chỉ biết nhóm Tiền mặt / Ngân hàng. */
  | 'GROUP_ONLY'
  /** Doanh thu có Đã thu nhưng chưa ghi khoản thu vào tài khoản nào. */
  | 'RECEIPT_NOT_POSTED'
  /** Đề nghị chi: lần xuất tiền bị lần xác nhận sau (sau khi sửa lệnh chi) thay thế. */
  | 'SUPERSEDED_RELEASE'
  /** Hai bút toán cùng định danh — chỉ tính một. */
  | 'DUPLICATE'
  /** Số tiền lớn bất thường — vẫn tính, cần kế toán xác nhận. */
  | 'SUSPICIOUS_AMOUNT';

export interface LedgerIssue {
  key: string;
  kind: LedgerIssueKind;
  message: string;
  /** Chỉ cảnh báo (vẫn tính vào báo cáo) — ngược lại là bị loại khỏi báo cáo. */
  warningOnly: boolean;
  date: string | null;
  amount: Cents | null;
  accountCode: string | null;
  documentNo: string;
  description: string;
  source: LedgerSourceRef;
}

export interface CollectedLedger {
  lines: LedgerLine[];
  issues: LedgerIssue[];
}
