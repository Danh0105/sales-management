import {
  buildDraftPayload,
  companyUnitPrice,
  invoiceItemName,
  invoiceLine,
  TAX_EXEMPT,
} from './revenue-einvoice.calculator';

describe('revenue-einvoice.calculator', () => {
  // Giá trị DB decimal trả về dạng chuỗi.
  const revenue = {
    content: 'Tháng 9',
    studentCount: '30.00',
    unitPrice: '150000.00',
  };
  const schoolRow = {
    giaovien: '50000.00',
    thue: '10000.00',
    csvc: '20000.00',
  };

  describe('companyUnitPrice — cùng công thức cột "Đơn giá" bảng Hóa Đơn', () => {
    it('trong hợp đồng: đơn giá doanh thu − (giáo viên + thuế + CSVC)', () => {
      expect(
        companyUnitPrice(revenue, { ...schoolRow, paymentType: 'in_contract' }),
      ).toBe(70000);
      expect(
        companyUnitPrice(revenue, { ...schoolRow, paymentType: null }),
      ).toBe(70000);
    });

    it('không có trong HĐ: giữ nguyên đơn giá doanh thu', () => {
      expect(
        companyUnitPrice(revenue, {
          ...schoolRow,
          paymentType: 'not_in_contract',
        }),
      ).toBe(150000);
    });
  });

  it('invoiceLine: số lượng = số HS, thành tiền = số HS × đơn giá, làm tròn tới đồng', () => {
    expect(invoiceLine(revenue, schoolRow)).toEqual({
      quantity: 30,
      unitPrice: 70000,
      amount: 2100000,
    });
    expect(
      invoiceLine(
        { studentCount: 3, unitPrice: 100000 },
        { giaovien: 33333.335, thue: 0, csvc: 0 },
      ),
    ).toEqual({ quantity: 3, unitPrice: 66666.67, amount: 200000 });
  });

  it('invoiceLine: không có số HS thì dùng số tiết × số tháng', () => {
    expect(
      invoiceLine(
        {
          studentCount: 0,
          totalPeriods: 60,
          monthsCount: 2,
          unitPrice: 530_000,
        },
        { giaovien: 0, thue: 0, csvc: 0 },
      ),
    ).toEqual({
      quantity: 120,
      unitPrice: 530_000,
      amount: 63_600_000,
    });
  });

  it('invoiceItemName: thêm tên môn nếu nội dung chưa có', () => {
    expect(invoiceItemName('Tiếng Anh', 'Tháng 9')).toBe('Tiếng Anh: Tháng 9');
    expect(invoiceItemName('Tiếng Anh', 'Học phí tiếng anh tháng 9')).toBe(
      'Học phí tiếng anh tháng 9',
    );
    expect(invoiceItemName('Tiếng Anh', '  ')).toBe('Tiếng Anh');
  });

  it('buildDraftPayload: bên mua là trường, không chịu thuế, tổng tiền khớp dòng', () => {
    const payload = buildDraftPayload({
      transactionUuid: '7d3c1f4e-6a5b-4c2d-9e8f-0a1b2c3d4e5f',
      templateCode: '1/001',
      invoiceSeries: 'C26TKD',
      school: {
        id: 12,
        name: 'Trường TH Nguyễn Huệ',
        taxCode: ' 0312345678 ',
        budgetCode: ' 1012345 ',
        address: '1 Lê Lợi, Q1',
        phone: '028 3822-1234',
      },
      items: [
        {
          rowIndex: 0,
          itemName: 'Tiếng Anh: Tháng 9',
          unitName: 'Học sinh',
          quantity: 30,
          unitPrice: 70000,
          amount: 2100000,
        },
      ],
    });

    expect(payload.generalInvoiceInfo).toEqual({
      templateCode: '1/001',
      invoiceSeries: 'C26TKD',
      currencyCode: 'VND',
      adjustmentType: '1',
      paymentStatus: false,
      cusGetInvoiceRight: true,
      transactionUuid: '7d3c1f4e-6a5b-4c2d-9e8f-0a1b2c3d4e5f',
    });
    expect(payload.buyerInfo).toEqual({
      buyerCode: 'TRUONG-12',
      buyerLegalName: 'Trường TH Nguyễn Huệ',
      buyerTaxCode: '0312345678',
      buyerBudgetCode: '1012345',
      buyerAddressLine: '1 Lê Lợi, Q1',
      buyerPhoneNumber: '02838221234',
      buyerNotGetInvoice: 0,
    });
    expect(payload.itemInfo).toEqual([
      expect.objectContaining({
        lineNumber: 1,
        itemName: 'Tiếng Anh: Tháng 9',
        unitName: 'Học sinh',
        quantity: 30,
        unitPrice: 70000,
        itemTotalAmountWithoutTax: 2100000,
        taxPercentage: TAX_EXEMPT,
        taxAmount: 0,
        itemTotalAmountWithTax: 2100000,
      }),
    ]);
    expect(payload.summarizeInfo).toMatchObject({
      totalAmountWithoutTax: 2100000,
      totalTaxAmount: 0,
      totalAmountWithTax: 2100000,
    });
    expect(payload.taxBreakdowns).toEqual([
      { taxPercentage: -2, taxableAmount: 2100000, taxAmount: 0 },
    ]);
  });

  it('buildDraftPayload: bỏ số điện thoại quá 15 ký tự và người đại diện trống', () => {
    const payload = buildDraftPayload({
      transactionUuid: 'u',
      templateCode: 't',
      invoiceSeries: 's',
      school: {
        id: 1,
        name: 'Trường A',
        taxCode: '0312345678',
        address: 'Địa chỉ',
        phone: '0901234567 / 0281234567',
      },
      items: [
        {
          rowIndex: 0,
          itemName: 'x',
          unitName: 'Học sinh',
          quantity: 1,
          unitPrice: 1,
          amount: 1,
        },
      ],
    });
    expect(payload.buyerInfo).not.toHaveProperty('buyerPhoneNumber');
    expect(payload.buyerInfo).not.toHaveProperty('buyerName');
    expect(payload.buyerInfo).not.toHaveProperty('buyerBudgetCode');
  });

  it('buildDraftPayload: nhiều dòng trên 1 hóa đơn — đánh số dòng, cộng tổng tiền', () => {
    const payload = buildDraftPayload({
      transactionUuid: 'u',
      templateCode: 't',
      invoiceSeries: 's',
      school: {
        id: 1,
        name: 'Trường A',
        taxCode: '0312345678',
        address: 'Địa chỉ',
      },
      items: [
        {
          rowIndex: 0,
          itemName: 'ICDL: tháng 10',
          unitName: 'Học sinh',
          quantity: 5,
          unitPrice: 630000,
          amount: 3150000,
        },
        {
          rowIndex: 1,
          itemName: 'ICDL: T11',
          unitName: 'Học sinh',
          quantity: 150,
          unitPrice: 630000,
          amount: 94500000,
        },
      ],
    });
    expect(
      payload.itemInfo.map((i) => [
        i.lineNumber,
        i.itemName,
        i.itemTotalAmountWithTax,
      ]),
    ).toEqual([
      [1, 'ICDL: tháng 10', 3150000],
      [2, 'ICDL: T11', 94500000],
    ]);
    expect(payload.summarizeInfo).toMatchObject({
      totalAmountWithoutTax: 97650000,
      totalAmountWithTax: 97650000,
      totalAmountAfterDiscount: 97650000,
    });
    expect(payload.taxBreakdowns).toEqual([
      { taxPercentage: -2, taxableAmount: 97650000, taxAmount: 0 },
    ]);
  });
});
