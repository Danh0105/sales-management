import { MovementStatus } from './financial-request.constants';
import {
  recipientTotals,
  sameAccount,
  supplierSubmitErrors,
} from './financial-suppliers';

const supplier = (id: number, lineNo: number, overrides = {}) => ({
  id,
  lineNo,
  name: `NCC ${id}`,
  bankAccountHolder: null,
  bankName: 'VCB',
  bankAccountNumber: `00${id}1234`,
  ...overrides,
});

describe('recipientTotals', () => {
  it('cộng dòng chi tiết theo người nhận, dùng số được duyệt nếu có', () => {
    const totals = recipientTotals(
      [supplier(20, 2), supplier(10, 1)],
      [
        { supplierId: 10, amount: 1_000_000, approvedAmount: null },
        { supplierId: 10, amount: 500_000, approvedAmount: 300_000 },
        { supplierId: 20, amount: 2_000_000, approvedAmount: null },
        { supplierId: null, amount: 150_000, approvedAmount: null },
      ],
      [
        { supplierId: 10, amount: 1_000_000, status: MovementStatus.RECORDED },
        { supplierId: 10, amount: 300_000, status: MovementStatus.VOIDED },
        { supplierId: null, amount: 150_000, status: MovementStatus.RECORDED },
      ],
    );
    // Người đề nghị trước, NCC theo lineNo.
    expect(totals).toEqual([
      { supplierId: null, amount: 150_000, paidAmount: 150_000, remaining: 0 },
      { supplierId: 10, amount: 1_300_000, paidAmount: 1_000_000, remaining: 300_000 },
      { supplierId: 20, amount: 2_000_000, paidAmount: 0, remaining: 2_000_000 },
    ]);
  });

  it('phiếu không có NCC: toàn bộ là của người đề nghị', () => {
    expect(
      recipientTotals(
        [],
        [
          { supplierId: null, amount: 700_000, approvedAmount: null },
          { supplierId: null, amount: 300_000, approvedAmount: 0 },
        ],
        [{ supplierId: null, amount: 200_000, status: MovementStatus.RECORDED }],
      ),
    ).toEqual([
      { supplierId: null, amount: 700_000, paidAmount: 200_000, remaining: 500_000 },
    ]);
  });

  it('dòng/lần chi trỏ tới NCC đã xoá tính cho người đề nghị', () => {
    const [requester] = recipientTotals(
      [],
      [{ supplierId: 99, amount: 400_000, approvedAmount: null }],
      [{ supplierId: 99, amount: 100_000, status: MovementStatus.RECORDED }],
    );
    expect(requester).toEqual({
      supplierId: null,
      amount: 400_000,
      paidAmount: 100_000,
      remaining: 300_000,
    });
  });

  it('chi vượt không ra số còn lại âm', () => {
    const [, ncc] = recipientTotals(
      [supplier(1, 1)],
      [{ supplierId: 1, amount: 100, approvedAmount: null }],
      [{ supplierId: 1, amount: 150, status: MovementStatus.RECORDED }],
    );
    expect(ncc.remaining).toBe(0);
  });
});

describe('supplierSubmitErrors', () => {
  it('đủ thông tin và có dòng → không lỗi', () => {
    expect(
      supplierSubmitErrors(
        [supplier(1, 1)],
        [{ supplierId: 1, amount: 1, approvedAmount: null }],
      ),
    ).toEqual([]);
  });

  it('thiếu ngân hàng / số tài khoản / chưa gán dòng', () => {
    expect(
      supplierSubmitErrors(
        [
          supplier(1, 1, { bankName: ' ', bankAccountNumber: null }),
          supplier(2, 2),
        ],
        [{ supplierId: 1, amount: 1, approvedAmount: null }],
      ),
    ).toEqual([
      'NCC 1 (NCC 1): thiếu ngân hàng, số tài khoản',
      'NCC 2 (NCC 2): chưa gán dòng chi tiết nào',
    ]);
  });

  it('phiếu không có NCC → không lỗi', () => {
    expect(supplierSubmitErrors([], [])).toEqual([]);
  });
});

describe('sameAccount', () => {
  it('bỏ qua khoảng trắng, gạch nối; rỗng không trùng', () => {
    expect(sameAccount('0071 000-123', '0071000123')).toBe(true);
    expect(sameAccount('0071000123', '0071000124')).toBe(false);
    expect(sameAccount('', '')).toBe(false);
    expect(sameAccount(null, null)).toBe(false);
  });
});
