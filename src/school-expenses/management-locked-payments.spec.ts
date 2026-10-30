import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ManagementExpenseItem } from '../management-expense-item/management-expense-item.entity';
import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import {
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
    } = {},
  ) {
    const manager = {
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((_entity: any, data: any) => data),
      save: jest.fn(async (entity: any, data?: any) => data ?? entity),
      update: jest.fn().mockResolvedValue(undefined),
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
      repo({ id: 3, schoolId: 5 }) as any,
      repo(null) as any,
      { createQueryRunner: () => queryRunner } as any,
    );
    jest.spyOn(service, 'getItems').mockResolvedValue({} as any);

    const save = () =>
      service.saveAll(
        9,
        {
          subjectId: 3,
          revenueItems: [{ rowIndex: 0, content: 'đổi', unitPrice: 1 }],
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
