/** Cấu trúc hóa đơn gửi Viettel S-Invoice (mục 7.2/7.8) — chỉ các trường hệ thống dùng. */
export interface ViettelInvoicePayload {
  generalInvoiceInfo: {
    templateCode: string;
    invoiceSeries: string;
    currencyCode: string;
    adjustmentType: string;
    paymentStatus: boolean;
    cusGetInvoiceRight: boolean;
    transactionUuid: string;
  };
  buyerInfo: {
    buyerCode?: string;
    buyerName?: string;
    buyerLegalName: string;
    buyerTaxCode: string;
    /** Mã đơn vị quan hệ ngân sách (7 ký tự) — bổ sung theo Nghị định 70, API v2.44. */
    buyerBudgetCode?: string;
    buyerAddressLine: string;
    buyerPhoneNumber?: string;
    buyerNotGetInvoice: number;
  };
  sellerInfo: Record<string, never>;
  payments: Array<{ paymentMethodName: string }>;
  itemInfo: Array<{
    lineNumber: number;
    selection: number;
    itemName: string;
    unitName: string;
    quantity: number;
    unitPrice: number;
    itemTotalAmountWithoutTax: number;
    taxPercentage: number;
    taxAmount: number;
    itemTotalAmountWithTax: number;
  }>;
  summarizeInfo: {
    totalAmountWithoutTax: number;
    totalTaxAmount: number;
    totalAmountWithTax: number;
    discountAmount: number;
    totalAmountAfterDiscount: number;
  };
  taxBreakdowns: Array<{
    taxPercentage: number;
    taxableAmount: number;
    taxAmount: number;
  }>;
}
