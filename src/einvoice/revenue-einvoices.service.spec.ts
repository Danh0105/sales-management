import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In } from 'typeorm';
import { RevenueEInvoiceStatus } from './revenue-einvoice.entity';
import { RevenueEInvoicesService } from './revenue-einvoices.service';
import { ViettelSinvoiceError } from './viettel-sinvoice.client';

describe('RevenueEInvoicesService.exportDrafts', () => {
  const user = { id: 9, name: 'Kế toán A' };
  let schoolExpense: any;
  let subject: any;
  let revenues: any[];
  let schoolRows: any[];
  let store: Map<number, any>;
  let nextId: number;
  let viettel: {
    createOrUpdateInvoiceDraft: jest.Mock;
    searchIssuedInvoices: jest.Mock;
  };
  let revenueUpdate: jest.Mock;
  let lockQuery: jest.Mock;
  let env: Record<string, string>;

  const revenueRow = (
    rowIndex: number,
    content: string,
    studentCount: string,
    invoiceType: string,
  ) => ({
    id: 101 + rowIndex,
    rowIndex,
    content,
    studentCount,
    unitPrice: '150000.00',
    invoiceType,
    invoiceUnit: null,
  });
  const schoolRow = (rowIndex: number) => ({
    rowIndex,
    giaovien: '50000.00',
    thue: '10000.00',
    csvc: '20000.00',
    paymentType: 'in_contract',
  });

  beforeEach(() => {
    schoolExpense = {
      id: 5,
      finalized: false,
      school: {
        id: 12,
        name: 'Trường TH Nguyễn Huệ',
        taxCode: '0312345678',
        budgetCode: '1012345',
        address: '1 Lê Lợi, Q1',
        phone: null,
        representative: 'Nguyễn Thị Ánh Mai',
      },
    };
    subject = { id: 7, schoolId: 12, name: 'Tiếng Anh', catalog: null };
    // Đơn giá công ty = 150.000 − (50.000 + 10.000 + 20.000) = 70.000.
    revenues = [
      revenueRow(0, 'Tháng 9', '30.00', 'company'),
      revenueRow(1, 'Tháng 10', '30.00', 'student'),
      revenueRow(2, 'Tháng 11', '0.00', 'company'),
      revenueRow(3, 'Tháng 12', '20.00', 'company'),
    ];
    schoolRows = [0, 1, 2, 3].map(schoolRow);
    store = new Map();
    nextId = 1;
    viettel = {
      createOrUpdateInvoiceDraft: jest
        .fn()
        .mockResolvedValue({ transactionID: 'TX-1' }),
      searchIssuedInvoices: jest.fn().mockResolvedValue([]),
    };
    revenueUpdate = jest.fn().mockResolvedValue(undefined);
    lockQuery = jest.fn().mockResolvedValue(undefined);
    env = {
      VIETTEL_SINVOICE_ENABLED: 'true',
      VIETTEL_SINVOICE_USERNAME: 'kido',
      VIETTEL_SINVOICE_PASSWORD: 'secret',
      VIETTEL_SINVOICE_TAX_CODE: '0109999999',
      VIETTEL_SINVOICE_TEMPLATE_CODE: '1/001',
      VIETTEL_SINVOICE_SERIES: 'C26TKD',
    };
  });

  const service = () => {
    const einvoices = {
      find: async () =>
        [...store.values()]
          .sort((a, b) => a.id - b.id)
          .map((r) => structuredClone(r)),
      create: (value: any) => ({ ...value }),
      save: async (record: any) => {
        record.id ??= nextId++;
        store.set(record.id, structuredClone(record));
        return record;
      },
      findOneBy: async (where: Record<string, unknown>) => {
        const found = [...store.values()].find((r) =>
          Object.entries(where).every(([key, value]) => r[key] === value),
        );
        return found ? structuredClone(found) : null;
      },
      delete: async ({ id }: { id: number }) => {
        store.delete(id);
      },
    };
    return new RevenueEInvoicesService(
      einvoices as never,
      { findOne: async () => schoolExpense } as never,
      { findOne: async () => subject } as never,
      {
        // Chỉ mô phỏng điều kiện rowIndex In(...) của unlink.
        find: async (options?: any) =>
          options?.where?.rowIndex
            ? revenues.filter((r) =>
                options.where.rowIndex.value.includes(r.rowIndex),
              )
            : revenues,
        update: revenueUpdate,
      } as never,
      { find: async () => schoolRows } as never,
      viettel as never,
      new ConfigService(env),
      {
        transaction: (run: (manager: unknown) => unknown) =>
          run({ query: lockQuery }),
      } as never,
    );
  };

  const records = () => [...store.values()];
  const sentPayloads = () =>
    viettel.createOrUpdateInvoiceDraft.mock.calls.map((c) => c[0]);

  it('gộp mọi dòng "Xuất HĐ Cty" vào 1 hóa đơn nháp, bỏ dòng thành tiền 0, khóa dòng đã xuất', async () => {
    const summary = await service().exportDrafts(5, 7, user);

    expect(summary).toEqual({
      draft: {
        rowIndexes: [0, 3],
        amount: 3500000,
        status: 'created',
        message: undefined,
      },
      existing: [],
      skipped: [
        expect.objectContaining({
          rowIndex: 2,
          itemName: 'Tiếng Anh: Tháng 11',
        }),
      ],
    });
    expect(lockQuery).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['revenue_einvoices_5_7'],
    );

    expect(viettel.createOrUpdateInvoiceDraft).toHaveBeenCalledTimes(1);
    const [payload] = sentPayloads();
    expect(payload.generalInvoiceInfo).toMatchObject({
      templateCode: '1/001',
      invoiceSeries: 'C26TKD',
    });
    expect(payload.buyerInfo).toMatchObject({
      buyerLegalName: 'Trường TH Nguyễn Huệ',
      buyerTaxCode: '0312345678',
      buyerBudgetCode: '1012345',
    });
    // Không in "Họ tên người mua hàng" (người đại diện) — bên mua là trường.
    expect(payload.buyerInfo).not.toHaveProperty('buyerName');
    expect(payload.itemInfo).toEqual([
      expect.objectContaining({
        lineNumber: 1,
        itemName: 'Tiếng Anh: Tháng 9',
        unitName: 'Học sinh',
        quantity: 30,
        unitPrice: 70000,
        itemTotalAmountWithTax: 2100000,
      }),
      expect.objectContaining({
        lineNumber: 2,
        itemName: 'Tiếng Anh: Tháng 12',
        quantity: 20,
        itemTotalAmountWithTax: 1400000,
      }),
    ]);
    expect(payload.summarizeInfo.totalAmountWithTax).toBe(3500000);
    expect(revenueUpdate).toHaveBeenCalledWith(
      { id: In([101, 104]) },
      { invoiceLocked: true },
    );

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      status: RevenueEInvoiceStatus.DraftCreated,
      legacyRowIndex: null,
      viettelTransactionId: 'TX-1',
      amount: '3500000',
      exportedByName: 'Kế toán A',
      transactionUuid: payload.generalInvoiceInfo.transactionUuid,
      lines: [
        expect.objectContaining({ rowIndex: 0, amount: 2100000 }),
        expect.objectContaining({ rowIndex: 3, amount: 1400000 }),
      ],
    });
  });

  it('bấm lại khi dữ liệu không đổi → không gửi Viettel lần nữa', async () => {
    await service().exportDrafts(5, 7, user);
    const again = await service().exportDrafts(5, 7, user);

    expect(again.draft).toBeNull();
    expect(again.existing).toEqual([
      expect.objectContaining({ rowIndexes: [0, 3], status: 'unchanged' }),
    ]);
    expect(viettel.createOrUpdateInvoiceDraft).toHaveBeenCalledTimes(1);
  });

  it('dữ liệu dòng đổi sau khi đã có nháp → không gửi lại (tránh nháp trùng), báo sửa trên portal', async () => {
    await service().exportDrafts(5, 7, user);
    revenues[3].studentCount = '21.00';
    const again = await service().exportDrafts(5, 7, user);

    expect(again.draft).toBeNull();
    expect(again.existing[0]).toMatchObject({ status: 'changed' });
    expect(again.existing[0].message).toContain('portal Viettel');
    expect(viettel.createOrUpdateInvoiceDraft).toHaveBeenCalledTimes(1);
    expect(records()[0]).toMatchObject({ amount: '3500000' });
  });

  it('dòng trên nháp không còn "Xuất HĐ Cty" → báo đã đổi', async () => {
    await service().exportDrafts(5, 7, user);
    revenues[0].invoiceType = 'none';
    const again = await service().exportDrafts(5, 7, user);

    expect(again.existing[0]).toMatchObject({ status: 'changed' });
    expect(viettel.createOrUpdateInvoiceDraft).toHaveBeenCalledTimes(1);
  });

  it('thêm dòng sau khi đã có nháp → dòng mới lên 1 hóa đơn nháp riêng', async () => {
    await service().exportDrafts(5, 7, user);
    revenues.push(revenueRow(4, 'Bổ sung', '10.00', 'company'));
    schoolRows.push(schoolRow(4));
    const again = await service().exportDrafts(5, 7, user);

    expect(again.existing).toEqual([
      expect.objectContaining({ rowIndexes: [0, 3], status: 'unchanged' }),
    ]);
    expect(again.draft).toMatchObject({
      rowIndexes: [4],
      amount: 700000,
      status: 'created',
    });
    const [first, second] = sentPayloads();
    expect(second.itemInfo).toHaveLength(1);
    expect(second.generalInvoiceInfo.transactionUuid).not.toBe(
      first.generalInvoiceInfo.transactionUuid,
    );
    expect(records()).toHaveLength(2);
  });

  const uuidUsed = () =>
    new ViettelSinvoiceError(
      'TRANSACTION_UUID_INVALID',
      'Transaction Uuid đã được dùng để lập hóa đơn',
      400,
    );
  const timeout = () =>
    new ViettelSinvoiceError('TIMEOUT', 'Viettel S-Invoice không phản hồi');

  it('lần trước timeout nhưng Viettel đã tạo nháp → gửi lại bị báo uuid đã dùng → ghi nhận đã tạo, khóa dòng', async () => {
    viettel.createOrUpdateInvoiceDraft
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(uuidUsed());
    const first = await service().exportDrafts(5, 7, user);
    expect(first.draft).toMatchObject({ status: 'error' });
    expect(records()[0]).toMatchObject({
      status: RevenueEInvoiceStatus.Failed,
      errorCode: 'TIMEOUT',
    });
    expect(revenueUpdate).not.toHaveBeenCalled();

    const retried = await service().exportDrafts(5, 7, user);
    expect(retried.draft).toMatchObject({
      rowIndexes: [0, 3],
      status: 'created',
    });
    expect(records()).toHaveLength(1);
    expect(records()[0].status).toBe(RevenueEInvoiceStatus.DraftCreated);
    expect(revenueUpdate).toHaveBeenCalledWith(
      { id: In([101, 104]) },
      { invoiceLocked: true },
    );

    const third = await service().exportDrafts(5, 7, user);
    expect(third.draft).toBeNull();
    expect(third.existing[0]).toMatchObject({ status: 'unchanged' });
    expect(viettel.createOrUpdateInvoiceDraft).toHaveBeenCalledTimes(2);
  });

  it('timeout, số liệu đổi, rồi gửi lại bị báo uuid đã dùng → báo nháp trên Viettel là số liệu cũ', async () => {
    viettel.createOrUpdateInvoiceDraft
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(uuidUsed());
    await service().exportDrafts(5, 7, user);
    revenues[0].studentCount = '31.00';

    const retried = await service().exportDrafts(5, 7, user);
    expect(retried.draft).toMatchObject({ status: 'changed' });
    // Bản ghi giữ số liệu của nháp thật trên Viettel (30 HS), không phải số mới.
    expect(records()[0]).toMatchObject({
      status: RevenueEInvoiceStatus.DraftCreated,
      amount: '3500000',
      lines: [
        expect.objectContaining({ rowIndex: 0, quantity: 30 }),
        expect.objectContaining({ rowIndex: 3 }),
      ],
    });
  });

  it('Viettel lỗi → báo lỗi, không khóa dòng; bấm lại dùng lại transactionUuid', async () => {
    viettel.createOrUpdateInvoiceDraft.mockRejectedValueOnce(
      new ViettelSinvoiceError(
        'TEMPLATE_NOT_FOUND',
        'Mẫu hóa đơn không tồn tại',
      ),
    );
    const failed = await service().exportDrafts(5, 7, user);

    expect(failed.draft).toMatchObject({
      rowIndexes: [0, 3],
      status: 'error',
      message: 'Mẫu hóa đơn không tồn tại',
    });
    expect(records()[0]).toMatchObject({
      status: RevenueEInvoiceStatus.Failed,
      errorCode: 'TEMPLATE_NOT_FOUND',
    });
    expect(revenueUpdate).not.toHaveBeenCalled();

    const retried = await service().exportDrafts(5, 7, user);
    expect(retried.draft).toMatchObject({ status: 'created' });
    expect(records()).toHaveLength(1);
    const [first, second] = sentPayloads();
    expect(second.generalInvoiceInfo.transactionUuid).toBe(
      first.generalInvoiceInfo.transactionUuid,
    );
  });

  it('nháp cũ "mỗi dòng 1 hóa đơn" vẫn được nhận: dòng đó không gửi lại, dòng còn lại lên hóa đơn mới', async () => {
    revenues = revenues.filter((r) => r.rowIndex === 0);
    await service().exportDrafts(5, 7, user);
    // Đưa bản ghi về dạng cũ: row_index, chưa có lines.
    Object.assign(records()[0], { legacyRowIndex: 0, lines: [] });

    revenues.push(revenueRow(3, 'Tháng 12', '20.00', 'company'));
    const summary = await service().exportDrafts(5, 7, user);

    expect(summary.existing).toEqual([
      expect.objectContaining({ rowIndexes: [0], status: 'unchanged' }),
    ]);
    expect(summary.draft).toMatchObject({ rowIndexes: [3], status: 'created' });
  });

  it('nháp cũ ở tài khoản Viettel khác (test → chính thức) → tạo nháp mới ở tài khoản đang cấu hình', async () => {
    store.set(1, {
      id: 1,
      schoolExpenseId: 5,
      subjectId: 7,
      legacyRowIndex: null,
      supplierTaxCode: '0100109106-507',
      transactionUuid: 'uuid-tai-khoan-test',
      status: RevenueEInvoiceStatus.DraftCreated,
      lines: [{ rowIndex: 0 }, { rowIndex: 3 }],
      payloadHash: 'hash-cu',
      draftedAt: new Date(),
    });
    nextId = 2;

    const summary = await service().exportDrafts(5, 7, user);

    expect(summary.existing).toEqual([]);
    expect(summary.draft).toMatchObject({
      rowIndexes: [0, 3],
      status: 'created',
    });
    const [payload] = sentPayloads();
    expect(payload.generalInvoiceInfo.transactionUuid).not.toBe(
      'uuid-tai-khoan-test',
    );
    expect(store.get(2)).toMatchObject({
      supplierTaxCode: '0109999999',
      status: RevenueEInvoiceStatus.DraftCreated,
    });
  });

  it('dòng chưa có dữ liệu Chi Trường → báo lưu trước, không tách dòng ra hóa đơn khác', async () => {
    schoolRows = schoolRows.filter((r) => r.rowIndex !== 3);
    const summary = await service().exportDrafts(5, 7, user);
    expect(summary.draft).toMatchObject({ rowIndexes: [3], status: 'error' });
    expect(summary.draft?.message).toContain('Dòng 4');
    expect(summary.draft?.message).toContain('lưu');
    expect(viettel.createOrUpdateInvoiceDraft).not.toHaveBeenCalled();
  });

  describe('unlink — bỏ liên kết nháp đã xóa trên portal', () => {
    it('xóa bản ghi, mở khóa các dòng của hóa đơn; đẩy lại tạo nháp mới', async () => {
      await service().exportDrafts(5, 7, user);
      const [first] = records();
      revenueUpdate.mockClear();

      await expect(service().unlink(5, 7, first.id, user)).resolves.toEqual({
        rowIndexes: [0, 3],
      });
      expect(viettel.searchIssuedInvoices).toHaveBeenCalledWith(
        first.transactionUuid,
      );
      expect(records()).toHaveLength(0);
      expect(revenueUpdate).toHaveBeenCalledWith(
        { id: In([101, 104]) },
        { invoiceLocked: false },
      );

      const again = await service().exportDrafts(5, 7, user);
      expect(again.draft).toMatchObject({
        rowIndexes: [0, 3],
        status: 'created',
      });
      const [, second] = sentPayloads();
      expect(second.generalInvoiceInfo.transactionUuid).not.toBe(
        first.transactionUuid,
      );
    });

    it('hóa đơn đã phát hành trên Viettel → chặn, giữ liên kết', async () => {
      await service().exportDrafts(5, 7, user);
      viettel.searchIssuedInvoices.mockResolvedValue([
        { invoiceNo: 'C26TIS15' },
      ]);
      await expect(
        service().unlink(5, 7, records()[0].id, user),
      ).rejects.toThrow('C26TIS15');
      expect(records()).toHaveLength(1);
    });

    it('không tra cứu được Viettel → chặn, giữ liên kết', async () => {
      await service().exportDrafts(5, 7, user);
      viettel.searchIssuedInvoices.mockRejectedValue(
        new ViettelSinvoiceError('TIMEOUT', 'Viettel S-Invoice không phản hồi'),
      );
      await expect(
        service().unlink(5, 7, records()[0].id, user),
      ).rejects.toThrow(BadRequestException);
      expect(records()).toHaveLength(1);
    });

    it('kỳ đã kết thúc, hóa đơn không thuộc môn, lần đẩy lỗi → chặn', async () => {
      await service().exportDrafts(5, 7, user);
      const { id } = records()[0];

      schoolExpense.finalized = true;
      await expect(service().unlink(5, 7, id, user)).rejects.toThrow(
        'đã kết thúc',
      );
      schoolExpense.finalized = false;

      await expect(service().unlink(5, 8, id, user)).rejects.toThrow(
        NotFoundException,
      );

      records()[0].status = RevenueEInvoiceStatus.Failed;
      await expect(service().unlink(5, 7, id, user)).rejects.toThrow(
        NotFoundException,
      );
      expect(records()).toHaveLength(1);
      expect(viettel.searchIssuedInvoices).not.toHaveBeenCalled();
    });
  });

  it('chặn khi trường chưa có mã đơn vị quan hệ ngân sách 7 chữ số', async () => {
    for (const budgetCode of [null, '', '123456', '12345AB']) {
      schoolExpense.school.budgetCode = budgetCode;
      await expect(service().exportDrafts(5, 7, user)).rejects.toThrow(
        'mã đơn vị quan hệ ngân sách',
      );
    }
    expect(viettel.createOrUpdateInvoiceDraft).not.toHaveBeenCalled();
  });

  it('chặn khi chưa bật, kỳ đã kết thúc, trường thiếu MST, môn của trường khác', async () => {
    env.VIETTEL_SINVOICE_ENABLED = 'false';
    await expect(service().exportDrafts(5, 7, user)).rejects.toThrow(
      BadRequestException,
    );
    env.VIETTEL_SINVOICE_ENABLED = 'true';

    schoolExpense.finalized = true;
    await expect(service().exportDrafts(5, 7, user)).rejects.toThrow(
      'đã kết thúc',
    );
    schoolExpense.finalized = false;

    schoolExpense.school.taxCode = '';
    await expect(service().exportDrafts(5, 7, user)).rejects.toThrow(
      'mã số thuế',
    );
    schoolExpense.school.taxCode = '0312345678';

    subject.schoolId = 99;
    await expect(service().exportDrafts(5, 7, user)).rejects.toThrow(
      NotFoundException,
    );
    expect(viettel.createOrUpdateInvoiceDraft).not.toHaveBeenCalled();
  });
});
