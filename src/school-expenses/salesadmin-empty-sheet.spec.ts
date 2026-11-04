import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/role-guard';
import { ManagementExpenseItem } from '../management-expense-item/management-expense-item.entity';
import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import { RealExpensesController } from './real-expenses.controller';
import { RealExpensesService } from './real-expenses.service';

const guard = new RolesGuard(new Reflector());

const allows = (method: string, roles: string[]) =>
  guard.canActivate({
    getHandler: () => (RealExpensesController.prototype as any)[method],
    getClass: () => RealExpensesController,
    switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
  } as unknown as ExecutionContext);

const SALES_ADMINS = ['saleadmin', 'salesadmin', 'salesadmin_la'];

const repo = (value: any) => ({
  find: jest.fn().mockResolvedValue(value),
  findOne: jest.fn().mockResolvedValue(value),
  create: jest.fn((data: any) => data),
  save: jest.fn(async (data: any) => ({ id: 9, ...data })),
});

/**
 * Sales admin mở trường chưa có bảng chi phí trong kỳ: tạo được bảng rỗng để
 * nhập Chi Ngoài, ngoài ra không có thêm quyền ghi nào.
 */
describe('Quản lý thu chi — sales admin tạo bảng chi phí rỗng', () => {
  it.each(SALES_ADMINS)('%s gọi được POST /school-expenses', (role) => {
    expect(allows('create', [role])).toBe(true);
  });

  it.each(SALES_ADMINS)('%s vẫn không sửa / xoá được bảng', (role) => {
    expect(allows('update', [role])).toBe(false);
    expect(allows('remove', [role])).toBe(false);
  });

  it('role khác (sales) vẫn bị chặn', () => {
    expect(allows('create', ['sales'])).toBe(false);
  });

  it('body gửi kèm số liệu thì bị bỏ qua: tổng tiền 0 và có ghi lịch sử', async () => {
    const expenses = repo(null);
    const history = repo(null);
    const service = new RealExpensesService(
      expenses as any,
      repo({ id: 5 }) as any,
      repo({ id: 7 }) as any,
      repo(null) as any,
      repo(null) as any,
      repo(null) as any,
      repo(null) as any,
      history as any,
      {} as any,
    );

    await service.create(
      { schoolId: 5, periodId: 7, totalRevenue: 999, finalized: true },
      { id: 16, name: 'Sales admin', roles: ['saleadmin'] } as any,
    );

    expect(expenses.create).toHaveBeenCalledWith({
      school: { id: 5 },
      period: { id: 7 },
      totalRevenue: 0,
      totalExpense: 0,
      totalCashPolicy: 0,
    });
    expect(history.save).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolExpenseId: 9,
        updatedById: 16,
        action: 'CREATE',
        newData: { schoolId: 5, periodId: 7 },
      }),
    );
  });

  it('lưu trên bảng mới chỉ chèn Chi Ngoài, không đụng doanh thu / chi trường', async () => {
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
    const service = new RealExpensesService(
      repo({ id: 9, school: { id: 5 }, finalized: false }) as any,
      repo(null) as any,
      repo(null) as any,
      repo([]) as any,
      repo([]) as any,
      repo([]) as any,
      repo({ id: 3, schoolId: 5 }) as any,
      repo(null) as any,
      { createQueryRunner: () => queryRunner } as any,
    );
    jest.spyOn(service, 'getItems').mockResolvedValue({} as any);

    await service.saveAll(
      9,
      {
        subjectId: 3,
        revenueItems: [{ rowIndex: 0, unitPrice: 100 }],
        schoolExpenseItems: [{ rowIndex: 0, paidAmount: 100 }],
        managementExpenseItems: [{ rowIndex: 0, ql1UnitPrice: 50 }],
      },
      { id: 16, name: 'Sales admin', roles: ['saleadmin'] } as any,
    );

    const entitiesCreated = manager.create.mock.calls.map(([entity]) => entity);
    expect(entitiesCreated).toContain(ManagementExpenseItem);
    expect(entitiesCreated).not.toContain(RevenueItem);
    expect(entitiesCreated).not.toContain(SchoolExpenseItem);

    const entitiesDeleted = manager.delete.mock.calls.map(([entity]) => entity);
    expect(entitiesDeleted).toEqual([ManagementExpenseItem]);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });
});
