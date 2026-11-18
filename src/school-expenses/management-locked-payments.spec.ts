import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ManagementExpenseItem } from '../management-expense-item/management-expense-item.entity';
import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import { PolicyStatus } from '../policy/policy.enum';
import {
  assertManagementPaidWithinOutside,
  buildManagementPaymentData,
  buildPaymentDateSourceData,
  canEditLockedDateSource,
  canEditLockedManagementPayments,
} from './expense-calculations';
import { RealExpensesService } from './real-expenses.service';

/**
 * Bảng "Chi Ngoài" đã xác nhận BBCS: kế toán trưởng sửa toàn bộ; kế toán /
 * KT công nợ / thủ quỹ chỉ nhập cột chi (Ngày chi, Nguồn chi, Đã chi, Người
 * chi, Ghi chú) của dòng đã có; trợ lý GĐ / giám đốc chỉ Ngày chi + Nguồn chi.
 * Kỳ đã "Kết thúc": mọi role ghi thu chi (trừ sales admin) chỉ còn Ngày chi +
 * Nguồn chi của Chi Trường và Chi Ngoài.
 */
describe('Chi Ngoài đã khoá / kỳ đã kết thúc — cột chi còn sửa được', () => {
  const oldRows = [
    { id: 71, rowIndex: 0, totalOutside: '21165300.00' },
    { id: 72, rowIndex: 1, totalOutside: '18225.00' },
  ].map((row) => ({
    ...row,
    ql1UnitPrice: '27000.00',
    ql1Tax: '2700.00',
    studentCount: '871',
    monthsCount: '1',
    paidAmount: '0.00',
    expenseDate: null,
    cashAccount: null,
    payer: null,
    note: null,
    otherCosts: [],
  }));

  const oldSchoolRows = [
    { id: 81, rowIndex: 0 },
    { id: 82, rowIndex: 1 },
  ].map((row) => ({
    ...row,
    teacherUnitPrice: '20000.00',
    paidAmount: '0.00',
    expenseDate: null,
    cashAccount: null,
    payer: null,
    note: null,
  }));

  const bodyRow = (id: number | undefined, rowIndex: number) => ({
    id,
    rowIndex,
    totalPeriods: 0,
    studentCount: 871,
    monthsCount: 1,
    // Đơn giá / thuế bị sửa ở client — phải bị bỏ qua khi bảng đã khoá.
    ql1UnitPrice: 99999,
    ql1Tax: 0,
    otherCosts: [],
    paidAmount: 18225,
    expenseDate: '2026-10-27',
    cashAccount: '1111',
    payer: 'Thủ quỹ',
    note: 'Đã chi đủ',
  });

  const schoolBodyRow = (id: number | undefined, rowIndex: number) => ({
    id,
    rowIndex,
    studentCount: 871,
    monthsCount: 1,
    teacherUnitPrice: 99999,
    paidAmount: 500,
    expenseDate: '2026-10-25',
    cashAccount: '1112',
    payer: 'X',
    note: 'Y',
  });

  const payment = {
    expenseDate: '2026-10-27',
    paidAmount: 18225,
    payer: 'Thủ quỹ',
    cashAccount: '1111',
    note: 'Đã chi đủ',
  };
  const dateSource = { expenseDate: '2026-10-27', cashAccount: '1111' };

  function setup(
    roles: string[],
    managementExpenseItems: any[],
    {
      confirmed = true,
      finalized = false,
      schoolExpenseItems = [] as any[],
      // Dòng 72 có Đã chi 10.000 do đề xuất chi DX-5 ghi vào.
      linked = false,
    } = {},
  ) {
    const manager = {
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((_entity: any, data: any) => data),
      save: jest.fn(async (entity: any, data?: any) => data ?? entity),
      update: jest.fn().mockResolvedValue(undefined),
      // Xác nhận BBCS theo môn (bảng school_expense_management_confirmations).
      getRepository: () => ({ exists: jest.fn().mockResolvedValue(confirmed) }),
      // Khoá bảng + đọc dòng có tiền từ đề xuất chi: mặc định chưa có.
      query: jest.fn(async (text: string) => {
        if (!linked) return [];
        if (text.includes('FROM management_expense_suggest_payments')) {
          return [
            { item_id: 72, suggest_id: 5, code: 'DX-5', amount: '10000.00', paid_date: '2026-11-12', cash_account: '1121' },
          ];
        }
        if (text.includes('FROM management_expense_items')) {
          return [
            { id: 71, paid: '0.00', expense_date: null, cash_account: null },
            { id: 72, paid: '10000.00', expense_date: null, cash_account: null },
          ];
        }
        return [];
      }),
    };
    const queryRunner = {
      manager,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
    };
    const repo = (value: any) => ({
      find: jest.fn().mockResolvedValue(value),
      findOne: jest.fn().mockResolvedValue(value),
    });

    const service = new RealExpensesService(
      repo({
        id: 9,
        school: { id: 5 },
        managementExpenseConfirmed: confirmed,
        finalized,
      }) as any,
      repo(null) as any,
      repo(null) as any,
      repo([{ id: 61, rowIndex: 0 }]) as any,
      repo(oldSchoolRows) as any,
      repo(oldRows) as any,
      repo({
        id: 3,
        schoolId: 5,
        policies: [
          {
            status: PolicyStatus.DIRECTOR_APPROVED,
            createdAt: new Date('2026-11-01T00:00:00Z'),
            data: { ttcs: [{ teacher: 70000 }] },
          },
        ],
      }) as any,
      repo(null) as any,
      { createQueryRunner: () => queryRunner, manager } as any,
    );
    jest.spyOn(service, 'getItems').mockResolvedValue({} as any);

    const save = () =>
      service.saveAll(
        9,
        {
          subjectId: 3,
          revenueItems: [
            {
              rowIndex: 0,
              content: 'đổi',
              unitPrice: 1,
              studentCount: 871,
              monthsCount: 1,
            },
          ],
          schoolExpenseItems,
          managementExpenseItems,
        },
        { id: 1, name: 'KT', roles } as any,
      );

    const calls = (fn: jest.Mock, entity: any = ManagementExpenseItem) =>
      fn.mock.calls.filter(([target]) => target === entity);

    return { save, manager, calls };
  }

  it.each([['accountant'], ['ketoan_congno'], ['thuquy']])(
    '%s: chỉ cập nhật cột chi của dòng cũ, giữ nguyên chính sách',
    async (role) => {
      const { save, manager, calls } = setup(
        [role],
        [bodyRow(71, 0), bodyRow(72, 1)],
      );

      await save();

      expect(calls(manager.delete)).toHaveLength(0);
      expect(calls(manager.create)).toHaveLength(0);
      expect(calls(manager.update)).toEqual([
        [
          ManagementExpenseItem,
          { id: 71 },
          { ...payment, remaining: 21165300 - 18225 },
        ],
        [ManagementExpenseItem, { id: 72 }, { ...payment, remaining: 0 }],
      ]);
    },
  );

  it('Chi Trường luôn lấy đơn giá giáo viên từ Thông tin cơ sở vật chất', async () => {
    const { save, manager, calls } = setup(
      ['ketoan_truong'],
      [],
      {
        confirmed: false,
        schoolExpenseItems: [schoolBodyRow(undefined, 0)],
      },
    );

    await save();

    expect(calls(manager.create, SchoolExpenseItem)).toEqual([
      [
        SchoolExpenseItem,
        expect.objectContaining({ giaovien: 70000 }),
      ],
    ]);
  });

  it('khớp theo id: dòng đầu bị xoá ở client → không ghi nhầm sang dòng 71', async () => {
    const { save, manager, calls } = setup(['accountant'], [bodyRow(72, 0)]);

    await save();

    expect(calls(manager.update)).toEqual([
      [ManagementExpenseItem, { id: 72 }, { ...payment, remaining: 0 }],
    ]);
  });

  it('client cũ không gửi id / id lạ → không đụng dòng nào', async () => {
    const { save, manager, calls } = setup(
      ['accountant'],
      [bodyRow(undefined, 0), bodyRow(999, 1)],
    );

    await save();

    expect(calls(manager.update)).toHaveLength(0);
    expect(calls(manager.delete)).toHaveLength(0);
  });

  it.each([['troly_gd'], ['director']])(
    '%s: bảng đã khoá → chỉ ghi Ngày chi + Nguồn chi',
    async (role) => {
      const { save, manager, calls } = setup(
        [role],
        [bodyRow(71, 0), bodyRow(72, 1)],
      );

      await save();

      expect(calls(manager.delete)).toHaveLength(0);
      expect(calls(manager.create)).toHaveLength(0);
      expect(calls(manager.update)).toEqual([
        [ManagementExpenseItem, { id: 71 }, dateSource],
        [ManagementExpenseItem, { id: 72 }, dateSource],
      ]);
    },
  );

  it('sales admin: bảng đã khoá thì không đụng tới Chi Ngoài', async () => {
    const { save, manager, calls } = setup(['salesadmin'], [bodyRow(71, 0)]);

    await save();

    expect(calls(manager.delete)).toHaveLength(0);
    expect(calls(manager.create)).toHaveLength(0);
    expect(calls(manager.update)).toHaveLength(0);
  });

  it('kế toán trưởng vẫn ghi lại toàn bộ dòng (kể cả đơn giá)', async () => {
    const { save, manager, calls } = setup(['ketoan_truong'], [bodyRow(71, 0)]);

    await save();

    expect(calls(manager.delete)).toHaveLength(1);
    expect(calls(manager.update)).toHaveLength(0);
    const [[, created]] = calls(manager.create);
    expect(created.ql1UnitPrice).toBe(99999);
  });

  it('chưa khoá: kế toán ghi lại toàn bộ dòng như trước', async () => {
    const { save, manager, calls } = setup(['accountant'], [bodyRow(71, 0)], {
      confirmed: false,
    });

    await save();

    expect(calls(manager.delete)).toHaveLength(1);
    expect(calls(manager.update)).toHaveLength(0);
    expect(calls(manager.create)).toHaveLength(1);
  });

  it('kiêm nhiệm KTT + kế toán → quyền KTT', async () => {
    const { save, manager, calls } = setup(
      ['accountant', 'ketoan_truong'],
      [bodyRow(71, 0)],
    );

    await save();

    expect(calls(manager.delete)).toHaveLength(1);
    expect(calls(manager.update)).toHaveLength(0);
  });

  describe('dòng có Đã chi từ đề xuất chi', () => {
    const kept = { paidAmount: 10000, expenseDate: null, cashAccount: null };

    it('bảng chưa khoá: thiếu dòng liên kết khi lưu → báo lỗi kèm mã đề xuất, không xoá gì', async () => {
      const { save, manager } = setup(['accountant'], [bodyRow(71, 0)], {
        confirmed: false,
        linked: true,
      });

      await expect(save()).rejects.toThrow('DX-5');
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('bảng chưa khoá: dòng liên kết cập nhật tại chỗ, giữ Ngày chi / Nguồn chi / Đã chi', async () => {
      const { save, manager, calls } = setup(
        ['accountant'],
        [bodyRow(71, 0), bodyRow(72, 1)],
        { confirmed: false, linked: true },
      );

      await save();

      // Không xoá dòng 72 (giữ id), xoá + tạo lại các dòng khác như cũ.
      const [[, criteria]] = calls(manager.delete);
      expect(criteria.id._value._value).toEqual([72]);
      expect(calls(manager.create)).toHaveLength(1);
      const [[, where, data]] = calls(manager.update);
      expect(where).toEqual({ id: 72 });
      // Đơn giá vẫn theo client (bảng chưa khoá), cột chi theo server.
      expect(data).toMatchObject({ ...kept, ql1UnitPrice: 99999 });
      expect(data.remaining).toBe(data.totalOutside - 10000);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE'),
        [9],
      );
    });

    it('bảng đã khoá (kế toán): dòng liên kết chỉ đổi Người chi / Ghi chú', async () => {
      const { save, manager, calls } = setup(
        ['accountant'],
        [bodyRow(71, 0), bodyRow(72, 1)],
        { linked: true },
      );

      await save();

      expect(calls(manager.update)).toEqual([
        [ManagementExpenseItem, { id: 71 }, { ...payment, remaining: 21165300 - 18225 }],
        [ManagementExpenseItem, { id: 72 }, { ...payment, ...kept, remaining: 18225 - 10000 }],
      ]);
    });

    it.each([['troly_gd'], ['director']])(
      '%s, bảng đã khoá: không ghi Ngày chi / Nguồn chi lên dòng liên kết',
      async (role) => {
        const { save, manager, calls } = setup(
          [role],
          [bodyRow(71, 0), bodyRow(72, 1)],
          { linked: true },
        );

        await save();

        expect(calls(manager.update)).toEqual([
          [ManagementExpenseItem, { id: 71 }, dateSource],
        ]);
      },
    );

    it('kỳ đã kết thúc: không ghi Ngày chi / Nguồn chi lên dòng liên kết', async () => {
      const { save, manager, calls } = setup(
        ['accountant'],
        [bodyRow(71, 0), bodyRow(72, 1)],
        { finalized: true, linked: true },
      );

      await save();

      expect(calls(manager.update)).toEqual([
        [ManagementExpenseItem, { id: 71 }, dateSource],
      ]);
    });

    it('Đã chi client gửi cho dòng liên kết không tính vào giới hạn tổng Đã chi', async () => {
      const { save } = setup(
        ['accountant'],
        [bodyRow(71, 0), { ...bodyRow(72, 1), paidAmount: 999_999_999 }],
        { linked: true },
      );

      await expect(save()).resolves.toBeDefined();
    });
  });

  describe('kỳ đã "Kết thúc"', () => {
    it.each([
      ['ketoan_truong'],
      ['accountant'],
      ['ketoan_congno'],
      ['thuquy'],
      ['troly_gd'],
      ['director'],
    ])(
      '%s: chỉ ghi Ngày chi + Nguồn chi của Chi Trường và Chi Ngoài',
      async (role) => {
        const { save, manager, calls } = setup([role], [bodyRow(72, 1)], {
          finalized: true,
          schoolExpenseItems: [schoolBodyRow(81, 0)],
        });

        await save();

        for (const entity of [
          RevenueItem,
          SchoolExpenseItem,
          ManagementExpenseItem,
        ]) {
          expect(calls(manager.delete, entity)).toHaveLength(0);
          expect(calls(manager.create, entity)).toHaveLength(0);
        }
        expect(calls(manager.update, RevenueItem)).toHaveLength(0);
        expect(calls(manager.update, SchoolExpenseItem)).toEqual([
          [
            SchoolExpenseItem,
            { id: 81 },
            { expenseDate: '2026-10-25', cashAccount: '1112' },
          ],
        ]);
        expect(calls(manager.update)).toEqual([
          [ManagementExpenseItem, { id: 72 }, dateSource],
        ]);
      },
    );

    it('chưa khoá BBCS cũng chỉ ghi Ngày chi + Nguồn chi', async () => {
      const { save, manager, calls } = setup(['accountant'], [bodyRow(71, 0)], {
        confirmed: false,
        finalized: true,
      });

      await save();

      expect(calls(manager.delete)).toHaveLength(0);
      expect(calls(manager.update)).toEqual([
        [ManagementExpenseItem, { id: 71 }, dateSource],
      ]);
    });

    it('sales admin vẫn bị chặn hẳn (403)', async () => {
      const { save, manager } = setup(['salesadmin'], [bodyRow(71, 0)], {
        finalized: true,
      });

      await expect(save()).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('Nguồn chi lạ → 400', async () => {
      const { save } = setup(['accountant'], [], {
        finalized: true,
        schoolExpenseItems: [{ ...schoolBodyRow(81, 0), cashAccount: '9999' }],
      });

      await expect(save()).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('thêm dòng, sửa Nội dung và giới hạn Đã chi', () => {
    // Tổng Chi ngoài của 2 dòng cũ: (27000 - 2700) × 871 × 2 = 42.331.... tính từ đơn giá.
    const totalOutside = (27000 - 2700) * 871 * 2;
    const added = (extra: Record<string, unknown> = {}) => ({
      rowIndex: 2,
      addedWhileLocked: true,
      content: ' Thanh toán đợt 1 ',
      paidAmount: 500000,
      expenseDate: '2026-11-05',
      cashAccount: '1111',
      payer: 'Thủ quỹ',
      note: 'Ghi chú',
      // Client cố gửi số tiền chính sách — phải bị bỏ qua.
      ql1UnitPrice: 99999,
      ql1Tax: 0,
      totalPeriods: 100,
      studentCount: 100,
      monthsCount: 3,
      otherCosts: [{ id: 1, name: 'X', unitPrice: 1000, tax: 0 }],
      ...extra,
    });
    const saved = (manager: any) =>
      manager.create.mock.calls
        .filter(([entity]: any[]) => entity === ManagementExpenseItem)
        .map(([, data]: any[]) => data);

    it.each([['accountant'], ['ketoan_congno'], ['thuquy']])(
      '%s thêm được dòng: chỉ có Nội dung + cột chi, Chi ngoài = 0',
      async (role) => {
        const { save, manager, calls } = setup([role], [added()]);

        await save();

        expect(calls(manager.delete)).toHaveLength(0);
        const [row] = saved(manager);
        expect(row).toMatchObject({
          rowIndex: 2,
          content: 'Thanh toán đợt 1',
          paidAmount: 500000,
          remaining: -500000,
          totalOutside: 0,
          ql1UnitPrice: 0,
          ql1Amount: 0,
          totalPeriods: 0,
          studentCount: 0,
          monthsCount: 0,
          payer: 'Thủ quỹ',
          note: 'Ghi chú',
        });
      },
    );

    it('dòng chưa lưu không đánh dấu (dòng mặc định) vẫn bị bỏ qua', async () => {
      const { save, manager } = setup(['accountant'], [bodyRow(undefined, 0)]);
      await save();
      expect(saved(manager)).toHaveLength(0);
    });

    it('dòng trống không tạo bản ghi', async () => {
      const { save, manager } = setup(
        ['accountant'],
        [added({ content: '   ', paidAmount: 0 })],
      );
      await save();
      expect(saved(manager)).toHaveLength(0);
    });

    it.each([['troly_gd'], ['director']])(
      '%s chỉ có Ngày chi + Nguồn chi nên không thêm được dòng',
      async (role) => {
        const { save, manager } = setup([role], [added()]);
        await save();
        expect(saved(manager)).toHaveLength(0);
      },
    );

    it('kỳ đã kết thúc không thêm được dòng', async () => {
      const { save, manager } = setup(['accountant'], [added()], {
        finalized: true,
      });
      await save();
      expect(saved(manager)).toHaveLength(0);
    });

    it('Đã chi của dòng mới bằng đúng tổng Còn chi thì lưu được', async () => {
      const { save, manager } = setup(
        ['accountant'],
        [added({ paidAmount: totalOutside })],
      );
      await save();
      expect(saved(manager)).toHaveLength(1);
    });

    it('Đã chi của dòng mới vượt tổng Còn chi → 400, không ghi gì', async () => {
      const { save, manager } = setup(
        ['accountant'],
        [added({ paidAmount: totalOutside + 1 })],
      );
      await expect(save()).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.create).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('sửa Đã chi dòng cũ làm tổng vượt → 400', async () => {
      const { save } = setup(
        ['accountant'],
        [{ ...bodyRow(71, 0), paidAmount: totalOutside + 1 }],
      );
      await expect(save()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cộng cả dòng cũ và dòng mới khi kiểm giới hạn', async () => {
      const { save } = setup(
        ['accountant'],
        [
          { ...bodyRow(71, 0), paidAmount: totalOutside - 10 },
          added({ paidAmount: 11 }),
        ],
      );
      await expect(save()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('kế toán trưởng cũng bị giới hạn, tính theo số vừa gửi lên', async () => {
      const { save } = setup(
        ['ketoan_truong'],
        // bodyRow gửi đơn giá 99999 × 871 HS.
        [{ ...bodyRow(71, 0), paidAmount: 99999 * 871 + 1 }],
      );
      await expect(save()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bảng chưa khoá cũng bị giới hạn theo số vừa gửi lên', async () => {
      const { save } = setup(
        ['accountant'],
        [
          {
            ...bodyRow(undefined, 0),
            ql1UnitPrice: 1000,
            ql1Tax: 0,
            paidAmount: 1000 * 871 + 1,
          },
        ],
        { confirmed: false },
      );
      await expect(save()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bảng chưa khoá: tăng đơn giá và Đã chi cùng lúc trong hạn thì lưu được', async () => {
      const { save } = setup(
        ['accountant'],
        [
          {
            ...bodyRow(undefined, 0),
            ql1UnitPrice: 1000,
            ql1Tax: 0,
            paidAmount: 1000 * 871,
          },
        ],
        { confirmed: false },
      );
      await expect(save()).resolves.toBeDefined();
    });

    it('sửa Nội dung dòng thêm riêng đã lưu: chỉ ghi Nội dung của dòng đó', async () => {
      const { save, manager, calls } = setup(
        ['accountant'],
        [
          { ...bodyRow(71, 0), content: 'không được đổi' },
          { ...bodyRow(72, 1), content: ' Đã sửa ' },
        ],
      );
      await save();
      const [[, , row71], [, , row72]] = calls(manager.update);
      expect(row71).not.toHaveProperty('content');
      expect(row72).toMatchObject({ content: 'Đã sửa' });
    });

    it('client không gửi Nội dung thì giữ nguyên', async () => {
      const { save, manager, calls } = setup(['accountant'], [bodyRow(72, 1)]);
      await save();
      expect(calls(manager.update)[0][2]).not.toHaveProperty('content');
    });

    it.each([['troly_gd'], ['director']])(
      '%s không sửa được Nội dung dòng thêm riêng khi đã khoá',
      async (role) => {
        const { save, manager, calls } = setup(
          [role],
          [{ ...bodyRow(72, 1), content: 'không được đổi' }],
        );
        await save();
        expect(calls(manager.update)[0][2]).not.toHaveProperty('content');
      },
    );

    it('kỳ đã kết thúc không sửa được Nội dung', async () => {
      const { save, manager } = setup(
        ['accountant'],
        [{ ...bodyRow(72, 1), content: 'không được đổi' }],
        { finalized: true },
      );
      await save();
      const updates = manager.update.mock.calls.filter(
        ([entity]: any[]) => entity === ManagementExpenseItem,
      );
      expect(updates[0][2]).not.toHaveProperty('content');
    });

    it('giữ Nội dung dòng thêm riêng khi kế toán trưởng lưu toàn bộ', async () => {
      const { save, manager } = setup(
        ['ketoan_truong'],
        [added({ paidAmount: 10 })],
      );
      await save();
      expect(saved(manager)[0].content).toBe('Thanh toán đợt 1');
    });
  });

  describe('assertManagementPaidWithinOutside', () => {
    it('bảng cũ đã vượt: giữ nguyên hoặc giảm thì lưu được, tăng thì chặn', () => {
      const totals = (newPaid: number) => ({
        oldPaid: 1000,
        newPaid,
        totalOutside: 800,
      });
      expect(() => assertManagementPaidWithinOutside(totals(1000))).not.toThrow();
      expect(() => assertManagementPaidWithinOutside(totals(900))).not.toThrow();
      expect(() => assertManagementPaidWithinOutside(totals(1001))).toThrow(
        BadRequestException,
      );
    });
  });

  it('canEditLockedManagementPayments chỉ nhận kế toán / KT công nợ / thủ quỹ', () => {
    expect(canEditLockedManagementPayments(['accountant'])).toBe(true);
    expect(canEditLockedManagementPayments(['ketoan_congno'])).toBe(true);
    expect(canEditLockedManagementPayments(['thuquy'])).toBe(true);
    expect(canEditLockedManagementPayments(['troly_gd', 'director'])).toBe(
      false,
    );
    expect(canEditLockedManagementPayments(['salesadmin'])).toBe(false);
    expect(canEditLockedManagementPayments(undefined)).toBe(false);
  });

  it('canEditLockedDateSource: mọi role ghi thu chi, trừ sales admin', () => {
    for (const role of [
      'ketoan_truong',
      'accountant',
      'ketoan_congno',
      'thuquy',
      'troly_gd',
      'director',
    ]) {
      expect(canEditLockedDateSource([role])).toBe(true);
    }
    expect(canEditLockedDateSource(['salesadmin', 'saleadmin'])).toBe(false);
    expect(canEditLockedDateSource(undefined)).toBe(false);
  });

  it('buildManagementPaymentData kiểm Đã chi âm và Nguồn chi lạ', () => {
    expect(() => buildManagementPaymentData({ paidAmount: -1 }, 100)).toThrow(
      BadRequestException,
    );
    expect(() =>
      buildManagementPaymentData({ cashAccount: '9999' }, 100),
    ).toThrow(BadRequestException);
    expect(buildManagementPaymentData({}, 100)).toEqual({
      expenseDate: null,
      paidAmount: 0,
      remaining: 100,
      payer: null,
      cashAccount: null,
      note: null,
    });
    expect(buildPaymentDateSourceData({ payer: 'X', paidAmount: 5 })).toEqual({
      expenseDate: null,
      cashAccount: null,
    });
  });
});
