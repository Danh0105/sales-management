export enum RevenueInvoiceStatus {
  Select = 'Chọn',
  CompanyInvoice = 'Xuất HĐ Cty',
  StudentInvoice = 'Xuất HĐ HS',
  NoInvoice = 'Không xuất HĐ',
  Other = 'Khác',
}

export enum RevenueInvoiceType {
  Empty = '',
  Company = 'company',
  Student = 'student',
  None = 'none',
  Other = 'other',
}

export const REVENUE_INVOICE_STATUSES = Object.values(RevenueInvoiceStatus);

export const REVENUE_INVOICE_TYPES = Object.values(RevenueInvoiceType);

export function normalizeRevenueInvoiceStatus(
  value: unknown,
): RevenueInvoiceStatus {
  if (
    value === true ||
    value === 'true' ||
    value === '1' ||
    value === RevenueInvoiceType.Company
  ) {
    return RevenueInvoiceStatus.CompanyInvoice;
  }

  if (value === RevenueInvoiceType.Student) {
    return RevenueInvoiceStatus.StudentInvoice;
  }

  if (
    value === false ||
    value === 'false' ||
    value === '0' ||
    value === RevenueInvoiceType.None
  ) {
    return RevenueInvoiceStatus.NoInvoice;
  }

  if (value === RevenueInvoiceType.Other) {
    return RevenueInvoiceStatus.Other;
  }

  if (
    typeof value === 'string' &&
    REVENUE_INVOICE_STATUSES.includes(value as RevenueInvoiceStatus)
  ) {
    return value as RevenueInvoiceStatus;
  }

  return RevenueInvoiceStatus.Select;
}

export function normalizeRevenueInvoiceType(
  value: unknown,
  status?: unknown,
): RevenueInvoiceType {
  if (
    typeof value === 'string' &&
    REVENUE_INVOICE_TYPES.includes(value as RevenueInvoiceType)
  ) {
    return value as RevenueInvoiceType;
  }

  const normalizedStatus = normalizeRevenueInvoiceStatus(status);

  if (normalizedStatus === RevenueInvoiceStatus.CompanyInvoice) {
    return RevenueInvoiceType.Company;
  }

  if (normalizedStatus === RevenueInvoiceStatus.StudentInvoice) {
    return RevenueInvoiceType.Student;
  }

  if (normalizedStatus === RevenueInvoiceStatus.NoInvoice) {
    return RevenueInvoiceType.None;
  }

  if (normalizedStatus === RevenueInvoiceStatus.Other) {
    return RevenueInvoiceType.Other;
  }

  return RevenueInvoiceType.Empty;
}
