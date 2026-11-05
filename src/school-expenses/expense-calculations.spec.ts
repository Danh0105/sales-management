import { BadRequestException, ForbiddenException } from '@nestjs/common';

import {
  assertNotFinalized,
  buildManagementExpenseItemData,
  buildRevenueItemData,
  buildSchoolExpenseItemData,
  computeOtherCostRows,
  normalizeCashDirection,
  normalizeCashAmount,
} from './expense-calculations';

describe('computeOtherCostRows', () => {
  const shared = { totalPeriods: 0, studentCount: 100, monthsCount: 3 };

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

  it('không có số học sinh: tính Chi khác theo số tiết × số tháng', () => {
    const { rows, totalOtherCostAmount, totalOtherTaxAmount } =
      computeOtherCostRows(
        [{ id: 15, name: 'KT', unitPrice: 500, tax: 50 }],
        { totalPeriods: 60, studentCount: 0, monthsCount: 2 },
      );

    expect(rows[0].amount).toBe(60 * 2 * 500);
    expect(rows[0].taxAmount).toBe(60 * 2 * 50);
    expect(totalOtherCostAmount).toBe(60 * 2 * 500);
    expect(totalOtherTaxAmount).toBe(60 * 2 * 50);
  });

  it('có cả số học sinh và số tiết: Chi khác ưu tiên số học sinh', () => {
    const { rows } = computeOtherCostRows(
      [{ id: 15, name: 'KT', unitPrice: 500, tax: 50 }],
      { totalPeriods: 60, studentCount: 30, monthsCount: 2 },
    );

    expect(rows[0].amount).toBe(30 * 2 * 500);
    expect(rows[0].taxAmount).toBe(30 * 2 * 50);
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

  it('thuế QL1/QL2/Chi khác được TRỪ khỏi totalOutside/remaining (tiền thực chi)', () => {
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
    // totalOutside = (300000 - 30000) + (600000 - 60000) + (360000 - 36000)
    expect(data.totalOutside).toBe(270000 + 540000 + 324000); // 1134000
    expect(data.remaining).toBe(1134000 - 100000); // 1034000
    // totalTaxAmount = 30000 + 60000 + 36000
    expect(data.totalTaxAmount).toBe(30000 + 60000 + 36000); // 126000
  });

  it('trường hợp thực tế: 73 HS, QL1 70.000, QL2 49.000 thuế 4.900, đã chi đủ', () => {
    const item = {
      studentCount: 73,
      monthsCount: 1,
      ql1UnitPrice: 70000,
      ql2UnitPrice: 49000,
      ql2Tax: 4900,
      paidAmount: 8329300,
    };
    const data = buildManagementExpenseItemData(item);
    expect(data.totalOutside).toBe(5110000 + 3219300); // 8329300
    expect(data.remaining).toBe(0);
  });

  it('lưu Nguồn chi (số hiệu tài khoản trong danh mục Nguồn thu chi)', () => {
    expect(
      buildManagementExpenseItemData({ cashAccount: ' 1112 ' }).cashAccount,
    ).toBe('1112');
    expect(
      buildManagementExpenseItemData({ cashAccount: '' }).cashAccount,
    ).toBeNull();
    expect(buildManagementExpenseItemData({}).cashAccount).toBeNull();
  });

  it('Nguồn chi không có trong danh mục Nguồn thu chi thì báo lỗi', () => {
    expect(() =>
      buildManagementExpenseItemData({ cashAccount: '111' }),
    ).toThrow(BadRequestException);
  });

  it('không có số học sinh: Chi QL tính theo số tiết × số tháng', () => {
    const item = {
      totalPeriods: 163,
      studentCount: 0,
      monthsCount: 1,
      ql1UnitPrice: 54000,
      ql2UnitPrice: 10000,
      ql2Tax: 1000,
    };
    const data = buildManagementExpenseItemData(item);
    expect(data.ql1Amount).toBe(54000 * 163); // 8802000
    expect(data.ql2Amount).toBe(10000 * 163);
    expect(data.ql2TaxAmount).toBe(1000 * 163);
    expect(data.totalOutside).toBe(8802000 + 9000 * 163);
  });

  it('có cả số học sinh và số tiết: ưu tiên số học sinh', () => {
    const item = {
      totalPeriods: 163,
      studentCount: 30,
      monthsCount: 2,
      ql1UnitPrice: 1000,
    };
    const data = buildManagementExpenseItemData(item);
    expect(data.ql1Amount).toBe(1000 * 30 * 2);
  });

  it('Chi khác theo số tiết có tổng thực chi = số tiết × tháng × (đơn giá - thuế)', () => {
    const item = {
      totalPeriods: 60,
      studentCount: 0,
      monthsCount: 2,
    };
    const { totalOtherCostAmount, totalOtherTaxAmount } =
      computeOtherCostRows(
        [{ id: 15, name: 'KT', unitPrice: 500, tax: 50 }],
        item,
      );

    const data = buildManagementExpenseItemData(
      item,
      0,
      item,
      totalOtherCostAmount,
      totalOtherTaxAmount,
    );

    expect(data.totalOutside).toBe(60 * 2 * (500 - 50));
    expect(data.remaining).toBe(60 * 2 * (500 - 50));
  });
});

describe('buildSchoolExpenseItemData — Hình thức chi (paymentType)', () => {
  const base = { studentCount: 73, monthsCount: 1, csvc: 70000 };

  it('lưu in_contract / not_in_contract', () => {
    expect(
      buildSchoolExpenseItemData({ ...base, paymentType: 'in_contract' })
        .paymentType,
    ).toBe('in_contract');
    expect(
      buildSchoolExpenseItemData({ ...base, paymentType: 'not_in_contract' })
        .paymentType,
    ).toBe('not_in_contract');
  });

  it('rỗng/không gửi → null', () => {
    expect(buildSchoolExpenseItemData(base).paymentType).toBeNull();
    expect(
      buildSchoolExpenseItemData({ ...base, paymentType: '' }).paymentType,
    ).toBeNull();
  });

  it('từ chối giá trị lạ', () => {
    expect(() =>
      buildSchoolExpenseItemData({ ...base, paymentType: 'abc' }),
    ).toThrow(BadRequestException);
  });
});

describe('buildRevenueItemData — tính doanh thu', () => {
  const base = { studentCount: 73, monthsCount: 1, unitPrice: 700000 };

  it('có số học sinh: thành tiền = số học sinh × số tháng × đơn giá', () => {
    const data = buildRevenueItemData({
      studentCount: 30,
      totalPeriods: 60,
      monthsCount: 2,
      unitPrice: 120_000,
      paidAmount: 1_000_000,
    });

    expect(data.invoiceAmount).toBe(30 * 2 * 120_000);
    expect(data.remainingAmount).toBe(30 * 2 * 120_000 - 1_000_000);
  });

  it('không có số học sinh: thành tiền = số tiết × số tháng × đơn giá', () => {
    const data = buildRevenueItemData({
      studentCount: 0,
      totalPeriods: 60,
      monthsCount: 1,
      unitPrice: 530_000,
    });

    expect(data.invoiceAmount).toBe(60 * 1 * 530_000);
    expect(data.remainingAmount).toBe(60 * 1 * 530_000);
  });

  it('không có số học sinh lẫn số tiết thì thành tiền bằng 0', () => {
    expect(
      buildRevenueItemData({ monthsCount: 3, unitPrice: 530_000 })
        .invoiceAmount,
    ).toBe(0);
  });

  it('chỉ true khi gửi đúng boolean true', () => {
    const locked = (value: unknown) =>
      buildRevenueItemData({ ...base, invoiceLocked: value }).invoiceLocked;
    expect(locked(true)).toBe(true);
    expect(locked(false)).toBe(false);
    expect(locked('false')).toBe(false);
    expect(buildRevenueItemData(base).invoiceLocked).toBe(false);
  });

  it('lưu Ngày chi và Khoản thu/chi của bảng Hóa Đơn', () => {
    const data = buildRevenueItemData({
      ...base,
      invoicePaymentDate: '2026-10-20',
      invoiceCashAccount: ' 11210 ',
    });

    expect(data.invoicePaymentDate).toBe('2026-10-20');
    expect(data.invoiceCashAccount).toBe('11210');
  });

  it('Ngày chi / Khoản thu/chi để trống thì lưu null', () => {
    const data = buildRevenueItemData({
      ...base,
      invoicePaymentDate: '',
      invoiceCashAccount: '',
    });

    expect(data.invoicePaymentDate).toBeNull();
    expect(data.invoiceCashAccount).toBeNull();
    expect(buildRevenueItemData(base).invoiceCashAccount).toBeNull();
  });

  it('Khoản thu/chi không có trong danh mục Nguồn thu chi thì báo lỗi', () => {
    expect(() =>
      buildRevenueItemData({ ...base, invoiceCashAccount: '9999' }),
    ).toThrow(BadRequestException);
    // Nhóm 111/112 chỉ là tiêu đề, không chọn được.
    expect(() =>
      buildRevenueItemData({ ...base, invoiceCashAccount: '112' }),
    ).toThrow(BadRequestException);
  });

  it('lưu Ghi chú của bảng Hóa Đơn (bỏ khoảng trắng đầu/cuối, tối đa 500 ký tự)', () => {
    expect(
      buildRevenueItemData({ ...base, invoiceNote: '  Thu tiền mặt  ' })
        .invoiceNote,
    ).toBe('Thu tiền mặt');
    expect(
      buildRevenueItemData({ ...base, invoiceNote: 'a'.repeat(600) })
        .invoiceNote,
    ).toBe('a'.repeat(500));
  });

  it('Ghi chú để trống hoặc không gửi thì lưu null (bản ghi cũ)', () => {
    expect(
      buildRevenueItemData({ ...base, invoiceNote: '   ' }).invoiceNote,
    ).toBeNull();
    expect(buildRevenueItemData(base).invoiceNote).toBeNull();
  });
});

describe('assertNotFinalized — kỳ thu chi đã "Kết thúc"', () => {
  it('chặn mọi chỉnh sửa khi finalized', () => {
    expect(() => assertNotFinalized({ finalized: true })).toThrow(
      ForbiddenException,
    );
  });

  it('cho qua khi chưa kết thúc', () => {
    expect(() => assertNotFinalized({ finalized: false })).not.toThrow();
    expect(() => assertNotFinalized(null)).not.toThrow();
  });
});

describe('khoản thu/chi trên Hóa Đơn + Nguồn chi của Chi Trường', () => {
  it('Thu/Chi chỉ nhận IN | OUT; để trống là null', () => {
    expect(normalizeCashDirection('IN')).toBe('IN');
    expect(normalizeCashDirection('OUT')).toBe('OUT');
    expect(normalizeCashDirection('')).toBeNull();
    expect(() => normalizeCashDirection('in')).toThrow(BadRequestException);
  });

  it('số tiền: trống → null (chưa nhập), không âm, tối đa 2 số lẻ, nhận chuỗi numeric của DB', () => {
    expect(normalizeCashAmount(undefined, 'x')).toBeNull();
    expect(normalizeCashAmount('', 'x')).toBeNull();
    expect(normalizeCashAmount('87100000.00', 'x')).toBe(87100000);
    expect(normalizeCashAmount(0.1, 'x')).toBe(0.1);
    expect(normalizeCashAmount(0, 'x')).toBe(0);
    expect(() => normalizeCashAmount(-1, 'x')).toThrow(BadRequestException);
    expect(() => normalizeCashAmount(1.005, 'x')).toThrow(BadRequestException);
    expect(() => normalizeCashAmount('abc', 'x')).toThrow(BadRequestException);
  });

  it('dòng doanh thu giữ Thu/Chi + Số tiền; dòng Chi Trường giữ Nguồn chi và từ chối mã lạ', () => {
    const revenue = buildRevenueItemData({
      invoiceCashDirection: 'OUT',
      invoiceCashAmount: '5000000',
      invoiceCashAccount: '1111',
    });
    expect(revenue.invoiceCashDirection).toBe('OUT');
    expect(revenue.invoiceCashAmount).toBe(5000000);
    expect(
      buildSchoolExpenseItemData({ cashAccount: '1121' }).cashAccount,
    ).toBe('1121');
    expect(buildSchoolExpenseItemData({}).cashAccount).toBeNull();
    expect(() => buildSchoolExpenseItemData({ cashAccount: '9999' })).toThrow(
      BadRequestException,
    );
  });
});
