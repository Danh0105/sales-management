import { BadRequestException } from '@nestjs/common';

import {
  buildManagementExpenseItemData,
  computeOtherCostRows,
} from './expense-calculations';

describe('computeOtherCostRows', () => {
  const shared = { studentCount: 100, monthsCount: 3 };

  it('tính amount = unitPrice * studentCount * monthsCount', () => {
    const { rows, totalOtherCostAmount } = computeOtherCostRows(
      [
        { policyOtherCostId: 15, name: 'KT', unitPrice: 500 },
        { policyOtherCostId: 16, name: 'TQ', unitPrice: 700 },
      ],
      shared,
    );

    expect(rows[0].amount).toBe(500 * 100 * 3); // 150000
    expect(rows[1].amount).toBe(700 * 100 * 3); // 210000
    expect(totalOtherCostAmount).toBe(150000 + 210000); // 360000
  });

  it('nhận alias `id` → policyOtherCostId', () => {
    const { rows } = computeOtherCostRows(
      [{ id: 15, name: 'KT', unitPrice: 500 }],
      shared,
    );
    expect(rows[0].policyOtherCostId).toBe(15);
  });

  it('bỏ qua `id` tạm dạng timestamp của FE', () => {
    const { rows } = computeOtherCostRows(
      [{ id: 1785135894180, name: 'Chi tự nhập', unitPrice: 500 }],
      shared,
    );

    expect(rows[0].policyOtherCostId).toBeNull();
    expect(rows[0].name).toBe('Chi tự nhập');
  });

  it('từ chối policyOtherCostId tường minh vượt giới hạn PostgreSQL integer', () => {
    expect(() =>
      computeOtherCostRows(
        [
          {
            policyOtherCostId: 1785135894180,
            name: 'Sai ID',
            unitPrice: 500,
          },
        ],
        shared,
      ),
    ).toThrow(BadRequestException);
  });

  it('mảng rỗng → total = 0', () => {
    const { rows, totalOtherCostAmount, totalOtherTaxAmount } =
      computeOtherCostRows([], shared);
    expect(rows).toHaveLength(0);
    expect(totalOtherCostAmount).toBe(0);
    expect(totalOtherTaxAmount).toBe(0);
  });

  it('tính taxAmount = tax × studentCount × monthsCount (tách riêng amount)', () => {
    const { rows, totalOtherCostAmount, totalOtherTaxAmount } =
      computeOtherCostRows(
        [
          { id: 15, name: 'KT', unitPrice: 500, tax: 50 },
          { id: 16, name: 'TQ', unitPrice: 700, tax: 70 },
        ],
        shared,
      );
    expect(rows[0].amount).toBe(150000);
    expect(rows[0].taxAmount).toBe(50 * 100 * 3); // 15000
    expect(rows[1].taxAmount).toBe(70 * 100 * 3); // 21000
    expect(totalOtherCostAmount).toBe(360000);
    expect(totalOtherTaxAmount).toBe(15000 + 21000); // 36000
  });

  it('tax mặc định 0 khi không gửi', () => {
    const { rows, totalOtherTaxAmount } = computeOtherCostRows(
      [{ id: 1, unitPrice: 100 }],
      shared,
    );
    expect(rows[0].tax).toBe(0);
    expect(rows[0].taxAmount).toBe(0);
    expect(totalOtherTaxAmount).toBe(0);
  });

  it('từ chối tax âm', () => {
    expect(() =>
      computeOtherCostRows([{ id: 1, unitPrice: 100, tax: -1 }], shared),
    ).toThrow(BadRequestException);
  });

  it('chấp nhận unitPrice dạng string số', () => {
    const { rows } = computeOtherCostRows(
      [{ policyOtherCostId: 1, unitPrice: '500' }],
      shared,
    );
    expect(rows[0].unitPrice).toBe(500);
    expect(rows[0].amount).toBe(150000);
  });

  it('từ chối unitPrice âm', () => {
    expect(() =>
      computeOtherCostRows([{ policyOtherCostId: 1, unitPrice: -1 }], shared),
    ).toThrow(BadRequestException);
  });

  it('từ chối NaN / không phải số', () => {
    expect(() =>
      computeOtherCostRows(
        [{ policyOtherCostId: 1, unitPrice: 'abc' }],
        shared,
      ),
    ).toThrow(BadRequestException);
  });

  it('từ chối Infinity', () => {
    expect(() =>
      computeOtherCostRows(
        [{ policyOtherCostId: 1, unitPrice: Infinity }],
        shared,
      ),
    ).toThrow(BadRequestException);
  });

  it('từ chối tên trống khi không có policyOtherCostId', () => {
    expect(() =>
      computeOtherCostRows([{ name: '  ', unitPrice: 500 }], shared),
    ).toThrow(BadRequestException);
  });

  it('cho phép tên trống nếu có policyOtherCostId', () => {
    const { rows } = computeOtherCostRows(
      [{ policyOtherCostId: 9, unitPrice: 100 }],
      shared,
    );
    expect(rows[0].policyOtherCostId).toBe(9);
    expect(rows[0].name).toBeNull();
  });

  it('từ chối trùng policyOtherCostId trong cùng 1 dòng', () => {
    expect(() =>
      computeOtherCostRows(
        [
          { policyOtherCostId: 5, unitPrice: 100 },
          { policyOtherCostId: 5, unitPrice: 200 },
        ],
        shared,
      ),
    ).toThrow(BadRequestException);
  });
});

describe('buildManagementExpenseItemData (fold Chi khác vào totalOutside/remaining)', () => {
  it('totalOutside = QL1 + QL2 + tổng Chi khác; remaining = totalOutside - paidAmount', () => {
    const item = {
      rowIndex: 0,
      studentCount: 100,
      monthsCount: 3,
      ql1UnitPrice: 1000,
      ql2UnitPrice: 2000,
      paidAmount: 100000,
    };
    const totalOtherCostAmount = 360000;

    const data = buildManagementExpenseItemData(
      item,
      0,
      item,
      totalOtherCostAmount,
    );

    expect(data.ql1Amount).toBe(1000 * 100 * 3); // 300000
    expect(data.ql2Amount).toBe(2000 * 100 * 3); // 600000
    expect(data.totalOutside).toBe(300000 + 600000 + 360000); // 1260000
    expect(data.remaining).toBe(1260000 - 100000); // 1160000
  });

  it('mặc định totalOtherCostAmount = 0 (không truyền) → chỉ QL1 + QL2', () => {
    const item = {
      studentCount: 10,
      monthsCount: 2,
      ql1UnitPrice: 100,
      ql2UnitPrice: 0,
      paidAmount: 0,
    };
    const data = buildManagementExpenseItemData(item);
    expect(data.totalOutside).toBe(100 * 10 * 2); // 2000
  });

  it('thuế QL1/QL2 tách riêng: KHÔNG cộng vào totalOutside/remaining', () => {
    const item = {
      studentCount: 100,
      monthsCount: 3,
      ql1UnitPrice: 1000,
      ql1Tax: 100,
      ql2UnitPrice: 2000,
      ql2Tax: 200,
      paidAmount: 100000,
    };
    const totalOtherCostAmount = 360000; // KT+TQ chưa thuế
    const totalOtherTaxAmount = 36000; // thuế KT+TQ

    const data = buildManagementExpenseItemData(
      item,
      0,
      item,
      totalOtherCostAmount,
      totalOtherTaxAmount,
    );

    expect(data.ql1TaxAmount).toBe(100 * 100 * 3); // 30000
    expect(data.ql2TaxAmount).toBe(200 * 100 * 3); // 60000
    // totalOutside CHƯA thuế
    expect(data.totalOutside).toBe(300000 + 600000 + 360000); // 1260000
    expect(data.remaining).toBe(1260000 - 100000); // 1160000
    // totalTaxAmount = 30000 + 60000 + 36000
    expect(data.totalTaxAmount).toBe(30000 + 60000 + 36000); // 126000
  });
});
