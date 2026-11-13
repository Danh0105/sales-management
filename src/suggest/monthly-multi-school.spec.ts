import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { ExpenseRole } from './constants/expense-roles';
import { CreateExpenseRequestDto } from './dto/expense/create-expense-request.dto';
import { SuggestMonthlyItem } from './entities/suggest-monthly-item.entity';
import { SuggestPaymentOrder } from './entities/suggest-payment-order.entity';
import { PaymentMethod } from './enums/expense-payment-method.enum';
import { SuggestType } from './enums/suggest-type.enum';
import {
  monthlyItemsFromColumns,
  monthlyRemainingTotal,
} from './monthly-expense-items';
import { SuggestStatus } from './SuggestStatus.enum';
import { SuggestService } from './suggest.service';

const sales = { id: 7, roles: [ExpenseRole.SALES] } as never;
const director = { id: 1, roles: [ExpenseRole.DIRECTOR] } as never;

const schoolA = { id: 445, name: 'TH A' };
const schoolB = { id: 446, name: 'TH B' };
const subjectA = { id: 901, schoolId: 445, schoolYear: '2099-2100' };
const subjectB = { id: 902, schoolId: 446, schoolYear: '2099-2100' };
const periodA = { id: 77, school: schoolA };
const periodB = { id: 78, school: schoolB };

const itemA = {
  schoolId: 445,
  schoolYear: '2099-2100',
  subjectId: 901,
  expensePeriodId: 77,
};
const itemB = {
  schoolId: 446,
  schoolYear: '2099-2100',
  subjectId: 902,
  expensePeriodId: 78,
};

const section = (schoolId: number, remaining: number) =>
  ({
    schoolId,
    subjectId: schoolId === 446 ? 902 : 901,
    periodId: schoolId === 446 ? 78 : 77,
    totals: { remaining },
  }) as never;

describe('DTO nhiều trường', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata = { type: 'body' as const, metatype: CreateExpenseRequestDto };
  const base = { content: 'Chi', expectedPaymentDate: '2099-09-15' };

  it('đọc danh sách trường gửi dạng chuỗi JSON từ multipart', async () => {
    const dto = await pipe.transform(
      {
        ...base,
        isMonthlyExpense: 'true',
        monthlyItems: JSON.stringify([
          { ...itemA, schoolId: '445' },
          itemB,
        ]),
      },
      metadata,
    );
    expect(dto.monthlyItems).toEqual([
      expect.objectContaining({ schoolId: 445, subjectId: 901 }),
      expect.objectContaining({ schoolId: 446, expensePeriodId: 78 }),
    ]);
  });

  it.each([
    ['danh sách rỗng', []],
    ['thiếu môn', [{ schoolId: 445, expensePeriodId: 77 }]],
    ['năm học sai', [{ ...itemA, schoolYear: '2099' }]],
  ])('từ chối %s', async (_name, items) => {
    await expect(
      pipe.transform(
        { ...base, monthlyItems: JSON.stringify(items) },
        metadata,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('Tạo đề xuất chi tháng nhiều trường', () => {
  const body = {
    content: 'Chi tháng 9',
    expectedPaymentDate: '2099-09-15',
    type: SuggestType.EXPENSE_REQUEST,
    isMonthlyExpense: true,
  };

  const makeService = (found: unknown[]) => {
    const findOne = jest.fn();
    found.forEach((row) => findOne.mockResolvedValueOnce(row));
    const manager = {
      findOne,
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn((_entity, data) => data),
      save: jest.fn(async (entityOrData, data) =>
        data ?? { ...entityOrData, id: 125 },
      ),
    };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      dataSource: { transaction: jest.fn((run) => run(manager)) },
      // Chống trùng + Còn phải chi: kiểm riêng ở cashflow-sources.spec.ts.
      prepareCashflowItems: jest.fn(async (_m: unknown, _s: unknown, items: unknown[]) =>
        items.map(() => 100_000),
      ),
      generateCode: jest.fn().mockResolvedValue('DX-1'),
      writeExpenseLog: jest.fn(),
      expenseNextStepDetails: jest.fn(),
      notifyExpense: jest.fn(),
      findOneExpense: jest.fn().mockResolvedValue({ id: 125 }),
    });
    return { service, manager };
  };

  it('lưu từng trường theo thứ tự, trường đầu chép lên đề xuất, gửi Giám đốc', async () => {
    const { service, manager } = makeService([
      schoolA,
      subjectA,
      periodA,
      schoolB,
      subjectB,
      periodB,
    ]);
    await service.create(
      { ...body, monthlyItems: [itemA, itemB] } as never,
      undefined,
      sales,
    );

    expect(manager.create.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        status: SuggestStatus.PENDING_APPROVAL,
        schoolId: 445,
        schoolYear: '2099-2100',
        subjectId: 901,
        expensePeriodId: 77,
        amount: null,
      }),
    );
    const itemsSave = manager.save.mock.calls.find(
      ([entity]) => entity === SuggestMonthlyItem,
    );
    expect(itemsSave?.[1]).toEqual([
      { suggestId: 125, ...itemA, position: 0, schoolTeacherId: null, requestedAmount: 100_000 },
      { suggestId: 125, ...itemB, position: 1, schoolTeacherId: null, requestedAmount: 100_000 },
    ]);
    expect(
      (service as never as { notifyExpense: jest.Mock }).notifyExpense,
    ).toHaveBeenCalledWith(expect.anything(), { roles: [ExpenseRole.DIRECTOR] });
  });

  it('chọn trùng môn + kỳ thì từ chối (không cộng tiền hai lần)', async () => {
    const { service, manager } = makeService([
      schoolA,
      subjectA,
      periodA,
      schoolA,
      subjectA,
      periodA,
    ]);
    await expect(
      service.create(
        { ...body, monthlyItems: [itemA, itemA] } as never,
        undefined,
        sales,
      ),
    ).rejects.toThrow('Chọn trùng môn và kỳ kế toán (TH A)');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('trường thứ hai sai kỳ thì báo đúng tên trường', async () => {
    const { service } = makeService([
      schoolA,
      subjectA,
      periodA,
      schoolB,
      subjectB,
      periodA,
    ]);
    await expect(
      service.create(
        { ...body, monthlyItems: [itemA, itemB] } as never,
        undefined,
        sales,
      ),
    ).rejects.toThrow('Kỳ kế toán không thuộc trường đã chọn (TH B)');
  });

  it('chi tháng không chọn trường nào thì từ chối', async () => {
    const { service } = makeService([]);
    await expect(
      service.create({ ...body } as never, undefined, sales),
    ).rejects.toThrow('Đề xuất chi tháng phải chọn trường');
  });
});

describe('Chủ đơn sửa đề xuất chi tháng nhiều trường', () => {
  const makeService = (stored: Record<string, unknown>, found: unknown[]) => {
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 5,
      type: SuggestType.EXPENSE_REQUEST,
      createdBy: 7,
      isMonthlyExpense: true,
      content: 'Chi',
      expectedPaymentDate: '2099-09-15',
      ...stored,
    });
    found.forEach((row) => findOne.mockResolvedValueOnce(row));
    const manager = {
      findOne,
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_entity, data) => data),
      save: jest.fn(async (entityOrData, data) => data ?? entityOrData),
      delete: jest.fn(),
    };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      dataSource: { transaction: jest.fn((run) => run(manager)) },
      // Chống trùng + Còn phải chi: kiểm riêng ở cashflow-sources.spec.ts.
      prepareCashflowItems: jest.fn(async (_m: unknown, _s: unknown, items: unknown[]) =>
        items.map(() => 100_000),
      ),
      writeExpenseLog: jest.fn(),
      expenseNextStepDetails: jest.fn(),
      notifyExpense: jest.fn(),
      findOneExpense: jest.fn().mockResolvedValue({ id: 5 }),
    });
    return { service, manager };
  };

  it('đề xuất cũ chờ Kế toán: thay danh sách trường, xoá lệnh chi, chuyển Giám đốc', async () => {
    const { service, manager } = makeService(
      {
        status: SuggestStatus.PENDING_ACCOUNTING,
        schoolId: 445,
        subjectId: 901,
        expensePeriodId: 77,
        schoolYear: '2099-2100',
      },
      [schoolA, subjectA, periodA, schoolB, subjectB, periodB],
    );
    await service.updateExpense(
      5,
      { monthlyItems: [itemA, itemB] } as never,
      undefined,
      sales,
    );

    const savedSuggest = manager.save.mock.calls[0][0];
    expect(savedSuggest).toMatchObject({
      status: SuggestStatus.PENDING_APPROVAL,
      amount: null,
      schoolId: 445,
      subjectId: 901,
      expensePeriodId: 77,
    });
    expect(manager.delete).toHaveBeenCalledWith(SuggestPaymentOrder, {
      suggestId: 5,
    });
    expect(manager.delete).toHaveBeenCalledWith(SuggestMonthlyItem, {
      suggestId: 5,
    });
    const itemsSave = manager.save.mock.calls.find(
      ([entity]) => entity === SuggestMonthlyItem,
    );
    expect(itemsSave?.[1]).toHaveLength(2);
    expect(
      (service as never as { notifyExpense: jest.Mock }).notifyExpense,
    ).toHaveBeenCalledWith(expect.anything(), { roles: [ExpenseRole.DIRECTOR] });
  });

  it('chỉ sửa tiêu đề thì giữ nguyên các trường đang có', async () => {
    const { service, manager } = makeService(
      {
        status: SuggestStatus.PENDING_APPROVAL,
        schoolId: 445,
        monthlyItems: [
          { id: 2, position: 1, ...itemB },
          { id: 1, position: 0, ...itemA },
        ],
      },
      [schoolA, subjectA, periodA, schoolB, subjectB, periodB],
    );
    await service.updateExpense(
      5,
      { content: 'Sửa tiêu đề' } as never,
      undefined,
      sales,
    );
    const itemsSave = manager.save.mock.calls.find(
      ([entity]) => entity === SuggestMonthlyItem,
    );
    expect(itemsSave?.[1]).toEqual([
      { suggestId: 5, ...itemA, position: 0, schoolTeacherId: null, requestedAmount: 100_000 },
      { suggestId: 5, ...itemB, position: 1, schoolTeacherId: null, requestedAmount: 100_000 },
    ]);
  });
});

describe('Giám đốc duyệt chi tháng không nhập số tiền', () => {
  const make = (opts: {
    sections?: unknown[] | Error;
    existingOrder?: unknown;
  }) => {
    const manager = {
      findOne: jest.fn().mockResolvedValue(opts.existingOrder ?? null),
      find: jest.fn().mockResolvedValue([
        { id: 11, ...itemA },
        { id: 12, ...itemB },
      ]),
      save: jest.fn(async (_entity, data) => ({ id: 31, ...data })),
      update: jest.fn(),
    };
    const transition = jest.fn(async (t) => {
      const row: Record<string, unknown> = {
        id: 5,
        code: 'DX-1',
        status: SuggestStatus.PAYMENT_ORDERED,
        createdBy: 7,
        isMonthlyExpense: true,
      };
      t.mutate?.(row);
      await t.extra?.(manager, row);
      row.data = t.logData ? await t.logData(manager, row) : {};
      return row;
    });
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      repo: {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 5, isMonthlyExpense: true, schoolId: 445 }),
      },
      loadManagementExpenseSections:
        opts.sections instanceof Error
          ? jest.fn().mockRejectedValue(opts.sections)
          : jest.fn().mockResolvedValue(opts.sections ?? []),
      expenseTransition: transition,
      generateCode: jest.fn().mockResolvedValue('LC-1'),
      notifyExpense: jest.fn(),
      logger: { error: jest.fn() },
    });
    return { service, manager };
  };

  it('lập lệnh chi bằng tổng Còn chi của mọi trường, ghi tạm Tiền mặt', async () => {
    const { service, manager } = make({
      sections: [section(445, 1_200_000), section(446, 800_000.5)],
    });
    const saved: any = await service.approveExpense(5, director, {} as never);

    expect(manager.save).toHaveBeenCalledWith(
      SuggestPaymentOrder,
      expect.objectContaining({
        code: 'LC-1',
        suggestId: 5,
        amount: 2_000_000.5,
        paymentMethod: PaymentMethod.CASH,
        createdBy: 1,
      }),
    );
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: 5 },
      { amount: 2_000_000.5 },
    );
    // Lưu phần của từng trường để chi một phần không phải nhập số.
    expect(manager.update).toHaveBeenCalledWith(
      SuggestMonthlyItem,
      { id: 11 },
      { approvedAmount: 1_200_000, spent: null, excluded: false },
    );
    expect(manager.update).toHaveBeenCalledWith(
      SuggestMonthlyItem,
      { id: 12 },
      { approvedAmount: 800_000.5, spent: null, excluded: false },
    );
    expect(saved.amount).toBe(2_000_000.5);
    expect(saved.data).toMatchObject({
      amount: 2_000_000.5,
      amountFromManagementExpense: true,
      paymentOrder: { code: 'LC-1', amount: 2_000_000.5 },
      managementExpense: { sections: expect.any(Array) },
    });
  });

  it('đã có lệnh chi (Kế toán lập lại sau hoàn quỹ) thì giữ số đó', async () => {
    const { service, manager } = make({
      sections: [section(445, 9_999)],
      existingOrder: { id: 9, code: 'LC-0', amount: 500_000, paymentMethod: 'CASH' },
    });
    const saved: any = await service.approveExpense(5, director, {} as never);
    expect(manager.save).not.toHaveBeenCalled();
    expect(saved.data).toMatchObject({
      amount: 500_000,
      amountFromManagementExpense: false,
    });
  });

  it('Còn chi bằng 0 thì không duyệt được', async () => {
    const { service, manager } = make({
      sections: [section(445, 0), section(446, -10)],
    });
    await expect(
      service.approveExpense(5, director, {} as never),
    ).rejects.toThrow('không còn khoản nào cần chi');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('không đọc được bảng mà cần tự lập số tiền thì dừng', async () => {
    const { service } = make({ sections: new Error('db') });
    await expect(
      service.approveExpense(5, director, {} as never),
    ).rejects.toThrow('Không đọc được bảng Chi Ngoài');
  });

  it('Giám đốc bỏ một trường: lệnh chi chỉ tính trường được duyệt', async () => {
    const { service, manager } = make({
      sections: [section(445, 1_200_000), section(446, 800_000)],
    });
    const saved: any = await service.approveExpense(5, director, {
      approvedItemIds: [11],
      note: 'TH B chưa xác nhận lớp',
    } as never);
    expect(manager.save).toHaveBeenCalledWith(
      SuggestPaymentOrder,
      expect.objectContaining({ amount: 1_200_000 }),
    );
    expect(manager.update).toHaveBeenCalledWith(
      SuggestMonthlyItem,
      { id: 12 },
      { approvedAmount: null, spent: null, excluded: true },
    );
    expect(saved.data.items).toEqual([
      expect.objectContaining({ id: 11, amount: 1_200_000, approved: true }),
      expect.objectContaining({ id: 12, amount: 800_000, approved: false }),
    ]);
    const notify = (service as never as { notifyExpense: jest.Mock }).notifyExpense;
    expect(notify.mock.calls[0][0].message).toContain('Không duyệt:');
  });

  it.each([
    ['bỏ trường mà không ghi lý do', { approvedItemIds: [11] }, 'Phải ghi lý do'],
    ['chọn trường của đề xuất khác', { approvedItemIds: [99], note: 'x' }, 'không thuộc đề xuất'],
    ['chọn trùng', { approvedItemIds: [11, 11], note: 'x' }, 'Chọn trùng'],
  ])('từ chối khi %s', async (_name, dto, message) => {
    const { service, manager } = make({
      sections: [section(445, 1_200_000), section(446, 800_000)],
    });
    await expect(
      service.approveExpense(5, director, dto as never),
    ).rejects.toThrow(message);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('trường được chọn hết tiền thì không duyệt được', async () => {
    const { service } = make({
      sections: [section(445, 0), section(446, 800_000)],
    });
    await expect(
      service.approveExpense(5, director, { approvedItemIds: [11], note: 'x' } as never),
    ).rejects.toThrow('Các trường được chọn không còn khoản nào cần chi');
  });

  it('lệnh chi do Kế toán lập thì không bỏ bớt trường được', async () => {
    const { service } = make({
      sections: [section(445, 1)],
      existingOrder: { id: 9, code: 'LC-0', amount: 500_000 },
    });
    await expect(
      service.approveExpense(5, director, { approvedItemIds: [11], note: 'x' } as never),
    ).rejects.toThrow('không bỏ bớt trường');
  });

  it('không đọc được bảng nhưng đã có lệnh chi thì vẫn duyệt', async () => {
    const { service } = make({
      sections: new Error('db'),
      existingOrder: { id: 9, code: 'LC-0', amount: 500_000 },
    });
    const saved: any = await service.approveExpense(5, director, {} as never);
    expect(saved.data.managementExpense).toBeUndefined();
    expect(saved.data.amount).toBe(500_000);
  });
});

describe('Bảng Chi Ngoài của đề xuất nhiều trường', () => {
  const make = (rows: unknown[]) => {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    const load = jest
      .fn()
      .mockImplementation(async (schoolId: number) => [section(schoolId, 1)]);
    Object.assign(service as object, {
      dataSource: { manager: { find: jest.fn().mockResolvedValue(rows) } },
      loadSchoolManagementSections: load,
    });
    return { service, load };
  };

  it('lấy đúng kỳ + môn của từng trường, theo thứ tự đã chọn', async () => {
    const { service, load } = make([
      { id: 2, position: 1, ...itemB },
      { id: 1, position: 0, ...itemA },
    ]);
    const sections = await (service as any).loadManagementExpenseSections({
      id: 5,
      isMonthlyExpense: true,
      schoolId: 445,
    });
    expect(load.mock.calls).toEqual([
      [445, 77, { schoolYear: '2099-2100', subjectId: 901 }],
      [446, 78, { schoolYear: '2099-2100', subjectId: 902 }],
    ]);
    expect(sections.map((s: any) => s.schoolId)).toEqual([445, 446]);
  });

  it('đề xuất cũ chưa có dòng trường thì đọc từ các cột cũ', async () => {
    const { service, load } = make([]);
    await (service as any).loadManagementExpenseSections({
      id: 5,
      isMonthlyExpense: true,
      ...itemA,
    });
    expect(load).toHaveBeenCalledWith(445, 77, {
      schoolYear: '2099-2100',
      subjectId: 901,
    });
  });

  it('đề xuất năm vẫn lấy mọi kỳ của năm học', async () => {
    const { service, load } = make([]);
    await (service as any).loadManagementExpenseSections({
      id: 5,
      isMonthlyExpense: false,
      schoolId: 445,
      schoolYear: '2099-2100',
    });
    expect(load).toHaveBeenCalledWith(445, null, {
      schoolYear: '2099-2100',
      subjectId: null,
    });
  });
});

describe('Thủ quỹ xuất tiền chi tháng', () => {
  const make = (isMonthlyExpense: boolean) => {
    const manager = { update: jest.fn() };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      expenseTransition: jest.fn(async (t) => {
        const row = { id: 5, code: 'DX-1', createdBy: 7, isMonthlyExpense };
        await t.extra?.(manager, row);
        return row;
      }),
      saveExpenseAttachments: jest.fn(),
      notifyExpense: jest.fn(),
    });
    return { service, manager };
  };
  const treasurer = { id: 3, roles: [ExpenseRole.TREASURER] } as never;

  it.each([
    ['1121', PaymentMethod.BANK_TRANSFER],
    ['1111', PaymentMethod.CASH],
  ])('tài khoản %s → hình thức %s', async (account, method) => {
    const { service, manager } = make(true);
    await service.confirmCashReleased(5, treasurer, undefined, [], undefined, account);
    expect(manager.update).toHaveBeenCalledWith(
      SuggestPaymentOrder,
      { suggestId: 5 },
      expect.objectContaining({ cashAccount: account, paymentMethod: method }),
    );
  });

  it('chi Năm giữ hình thức Kế toán đã chọn', async () => {
    const { service, manager } = make(false);
    await service.confirmCashReleased(5, treasurer, undefined, [], undefined, '1121');
    expect(manager.update.mock.calls[0][2]).not.toHaveProperty('paymentMethod');
  });
});

describe('Kế toán sửa lệnh chi', () => {
  it('chi tháng chờ Giám đốc chưa có lệnh chi thì không sửa được', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      repo: { findOne: jest.fn().mockResolvedValue({ id: 5, isMonthlyExpense: true }) },
      expenseTransition: jest.fn(async (t) => {
        const row = { id: 5, isMonthlyExpense: true };
        t.mutate?.(row);
        await t.extra?.(manager, row);
        return row;
      }),
      notifyExpense: jest.fn(),
    });
    await expect(
      service.editExpensePaymentOrder(
        5,
        { amount: 1000, paymentMethod: 'CASH' } as never,
        { id: 9, roles: [ExpenseRole.DEBT_ACCOUNTANT] } as never,
      ),
    ).rejects.toThrow('Đề xuất chưa có lệnh chi để sửa');
    expect(manager.save).not.toHaveBeenCalled();
  });
});

describe('Tiện ích chi tháng', () => {
  it('đề xuất một trường đọc từ các cột cũ', () => {
    expect(monthlyItemsFromColumns({ schoolId: null })).toEqual([]);
    expect(monthlyItemsFromColumns(itemA)).toEqual([itemA]);
  });

  it('cộng Còn chi, làm tròn đồng', () => {
    expect(
      monthlyRemainingTotal([section(1, 0.1), section(2, 0.2), section(3, 100)]),
    ).toBe(100.3);
  });
});
