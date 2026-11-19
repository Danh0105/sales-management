import { BadRequestException } from '@nestjs/common';

import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import { PolicyStatus } from '../policy/policy.enum';
import { SchoolExpenseHistory } from './entities/school-expense-history.entity';
import { RealExpensesService } from './real-expenses.service';

/**
 * 19/11/2026: đã "Xuất hóa đơn tất cả" (mọi dòng Doanh Thu khoá hóa đơn) →
 * khoá toàn bộ các bảng, chỉ còn "Tổng thanh toán công ty"; kế toán trưởng
 * vẫn sửa như cũ.
 */
describe('Đã xuất hóa đơn tất cả — chỉ sửa Tổng thanh toán công ty', () => {
  function setup({
    locked = [true, true],
    finalized = false,
  }: { locked?: boolean[]; finalized?: boolean } = {}) {
    const oldRevenue = locked.map((invoiceLocked, rowIndex) => ({
      id: 61 + rowIndex,
      rowIndex,
      invoiceLocked,
      companyPaymentTotal: rowIndex === 1 ? 500 : null,
    }));
    const manager = {
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((_entity: any, data: any) => data),
      save: jest.fn(async (entity: any, data?: any) => data ?? entity),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
      find: jest.fn(async (entity: any) => (entity === RevenueItem ? oldRevenue : [])),
      getRepository: () => ({
        exists: jest.fn().mockResolvedValue(false),
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
      }),
      query: jest.fn().mockResolvedValue([]),
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
      repo({ id: 9, school: { id: 5 }, finalized }) as any,
      repo(null) as any,
      repo(null) as any,
      repo(oldRevenue) as any,
      repo([]) as any,
      repo([]) as any,
      repo({
        id: 3,
        schoolId: 5,
        policies: [
          {
            status: PolicyStatus.DIRECTOR_APPROVED,
            createdAt: new Date('2026-11-01T00:00:00Z'),
            data: { ttcs: [{ teacher: 0 }] },
          },
        ],
      }) as any,
      repo(null) as any,
      { createQueryRunner: () => queryRunner, manager } as any,
    );
    jest.spyOn(service, 'getItems').mockResolvedValue({} as any);
    const save = (roles: string[]) =>
      service.saveAll(
        9,
        {
          subjectId: 3,
          revenueItems: [
            { rowIndex: 0, content: 'đổi', unitPrice: 1, studentCount: 1, monthsCount: 1, invoiceLocked: true, companyPaymentTotal: 1234567 },
            { rowIndex: 1, content: 'đổi', unitPrice: 1, studentCount: 1, monthsCount: 1, invoiceLocked: true, companyPaymentTotal: '' },
          ],
          schoolExpenseItems: [{ rowIndex: 0, teacherUnitPrice: 9 }],
          managementExpenseItems: [],
        },
        { id: 1, name: 'KT', roles } as any,
      );
    return { save, manager };
  }

  it('kế toán: chỉ ghi Tổng thanh toán công ty, không xoá/ghi lại bảng nào', async () => {
    const { save, manager } = setup();
    await save(['accountant']);
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.create).not.toHaveBeenCalled();
    expect(manager.update.mock.calls).toEqual([
      [RevenueItem, { id: 61 }, { companyPaymentTotal: 1234567 }],
      [RevenueItem, { id: 62 }, { companyPaymentTotal: null }],
    ]);
    const history = manager.save.mock.calls.find(([entity]) => entity === SchoolExpenseHistory);
    expect(history?.[1].newData.revenueItems).toEqual([
      { rowIndex: 0, companyPaymentTotal: 1234567 },
      { rowIndex: 1, companyPaymentTotal: null },
    ]);
  });

  it('kỳ đã kết thúc + đã xuất hóa đơn tất cả: không sửa được', async () => {
    const { save } = setup({ finalized: true });
    await expect(save(['accountant'])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('còn dòng chưa khoá hóa đơn: lưu bình thường', async () => {
    const { save, manager } = setup({ locked: [true, false] });
    await save(['accountant']);
    expect(manager.delete).toHaveBeenCalledWith(RevenueItem, expect.anything());
    expect(manager.delete).toHaveBeenCalledWith(SchoolExpenseItem, expect.anything());
  });

  it('kế toán trưởng: lưu bình thường', async () => {
    const { save, manager } = setup();
    await save(['ketoan_truong']);
    expect(manager.delete).toHaveBeenCalledWith(RevenueItem, expect.anything());
  });
});
