/**
 * Danh mục "Nguồn thu chi" — tài khoản tiền chọn ở cột "Khoản thu/chi" của
 * bảng Hóa Đơn, cột "Nguồn chi" của bảng Chi Ngoài và "Nguồn chi" thủ quỹ chọn
 * khi xuất tiền cho đề xuất chi, lưu theo số hiệu tài khoản. FE (kido-app InvoiceTable) giữ bản
 * sao danh mục này — thêm/bớt tài khoản phải sửa cả hai nơi.
 */
export const INVOICE_CASH_ACCOUNTS = [
  // 111 - Tiền mặt
  { code: '1111', name: 'Tiền mặt tại quỹ' },
  { code: '1112', name: 'Tiền TK Sếp Khôi' },
  { code: '1113', name: 'Tiền mặt - Anh Trung' },
  { code: '1114', name: 'Tiền mặt - Cầm' },
  // 112 - Tiền gửi ngân hàng
  { code: '1121', name: 'TK Techcombank - ICHI' },
  { code: '1125', name: 'TK MB Bank - ICHI' },
  { code: '1126', name: 'TK Vietcombank - ICHI' },
  { code: '1127', name: 'TK Vietinbank - ICHI' },
  { code: '1128', name: 'TK Techcombank - Chuyển đổi số' },
  { code: '1129', name: 'TK Techcombank - Kido' },
  { code: '11210', name: 'TK Vietinbank - Kido' },
  { code: '11211', name: 'TK Techcombank - Anh Việt' },
  { code: '11212', name: 'TK MB Bank - ST' },
] as const;

export const INVOICE_CASH_ACCOUNT_CODES: string[] = INVOICE_CASH_ACCOUNTS.map(
  (account) => account.code,
);

/** "1121 - TK Techcombank - ICHI"; mã không có trong danh mục thì trả nguyên mã. */
export function cashAccountLabel(code: string): string {
  const account = INVOICE_CASH_ACCOUNTS.find((item) => item.code === code);
  return account ? `${account.code} - ${account.name}` : code;
}
