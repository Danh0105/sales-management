import type { ViettelInvoicePayload } from './viettel-invoice-payload';

/** Mã thuế suất "Không chịu thuế GTGT" theo quy ước Viettel S-Invoice. */
export const TAX_EXEMPT = -2;

export const DEFAULT_INVOICE_UNIT = 'Học sinh';

export interface RevenueRowInput {
  content?: string | null;
  studentCount: number | string;
  unitPrice: number | string;
  invoiceUnit?: string | null;
}

export interface SchoolRowInput {
  giaovien: number | string;
  thue: number | string;
  csvc: number | string;
  paymentType?: string | null;
}

export interface InvoiceLine {
  quantity: number;
  unitPrice: number;
  amount: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Đơn giá trên hóa đơn công ty của 1 dòng — cùng công thức với cột "Đơn giá"
 * của bảng Hóa Đơn (InvoiceTable.companyPaymentOf ở kido-app):
 * - 'not_in_contract': đơn giá doanh thu;
 * - còn lại: đơn giá doanh thu − (giáo viên + thuế + CSVC) của dòng Chi Trường.
 */
export function companyUnitPrice(
  revenue: RevenueRowInput,
  school: SchoolRowInput,
): number {
  const revenueUnitPrice = Number(revenue.unitPrice || 0);
  if (school.paymentType === 'not_in_contract') return revenueUnitPrice;
  return (
    revenueUnitPrice -
    (Number(school.giaovien || 0) +
      Number(school.thue || 0) +
      Number(school.csvc || 0))
  );
}

/** Số lượng = số học sinh; Thành tiền làm tròn tới đồng. */
export function invoiceLine(
  revenue: RevenueRowInput,
  school: SchoolRowInput,
): InvoiceLine {
  const quantity = Number(revenue.studentCount || 0);
  const unitPrice = round2(companyUnitPrice(revenue, school));
  return { quantity, unitPrice, amount: Math.round(quantity * unitPrice) };
}

export function invoiceItemName(
  subjectName: string,
  content?: string | null,
): string {
  const text = (content ?? '').trim();
  const name = !text
    ? subjectName
    : text
          .toLocaleLowerCase('vi-VN')
          .includes(subjectName.toLocaleLowerCase('vi-VN'))
      ? text
      : `${subjectName}: ${text}`;
  return name.slice(0, 500);
}

export interface BuyerSchool {
  id: number;
  name: string;
  taxCode: string;
  /** Mã đơn vị quan hệ ngân sách. */
  budgetCode?: string | null;
  address: string;
  phone?: string | null;
  representative?: string | null;
}

/** 1 dòng hàng trên hóa đơn — ứng với 1 dòng doanh thu "Xuất HĐ Cty". */
export interface InvoiceItem extends InvoiceLine {
  /** Vị trí dòng doanh thu (cùng index ở bảng Hóa Đơn) — không gửi Viettel. */
  rowIndex: number;
  itemName: string;
  unitName: string;
}

/** Hóa đơn nháp gộp nhiều dòng hàng; 1 dòng thì giống hệt bản cũ (mỗi dòng 1 hóa đơn). */
export function buildDraftPayload(input: {
  transactionUuid: string;
  templateCode: string;
  invoiceSeries: string;
  school: BuyerSchool;
  items: InvoiceItem[];
}): ViettelInvoicePayload {
  const { school, items } = input;
  const phone = (school.phone ?? '').replace(/[^\d+]/g, '');
  const budgetCode = (school.budgetCode ?? '').trim();
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  return {
    generalInvoiceInfo: {
      templateCode: input.templateCode,
      invoiceSeries: input.invoiceSeries,
      currencyCode: 'VND',
      adjustmentType: '1',
      // Hóa đơn xuất cho phần trường phải thanh toán — chưa ghi nhận đã thu.
      paymentStatus: false,
      cusGetInvoiceRight: true,
      transactionUuid: input.transactionUuid,
    },
    buyerInfo: {
      buyerCode: `TRUONG-${school.id}`,
      ...(school.representative
        ? { buyerName: school.representative.slice(0, 800) }
        : {}),
      buyerLegalName: school.name.slice(0, 1200),
      buyerTaxCode: school.taxCode.trim(),
      ...(budgetCode ? { buyerBudgetCode: budgetCode } : {}),
      buyerAddressLine: school.address.slice(0, 1200),
      ...(phone && phone.length <= 15 ? { buyerPhoneNumber: phone } : {}),
      buyerNotGetInvoice: 0,
    },
    sellerInfo: {},
    payments: [{ paymentMethodName: 'TM/CK' }],
    itemInfo: items.map((item, index) => ({
      lineNumber: index + 1,
      selection: 1,
      itemName: item.itemName,
      unitName: item.unitName.slice(0, 300),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      itemTotalAmountWithoutTax: item.amount,
      taxPercentage: TAX_EXEMPT,
      taxAmount: 0,
      itemTotalAmountWithTax: item.amount,
    })),
    summarizeInfo: {
      totalAmountWithoutTax: total,
      totalTaxAmount: 0,
      totalAmountWithTax: total,
      discountAmount: 0,
      totalAmountAfterDiscount: total,
    },
    taxBreakdowns: [
      { taxPercentage: TAX_EXEMPT, taxableAmount: total, taxAmount: 0 },
    ],
  };
}
