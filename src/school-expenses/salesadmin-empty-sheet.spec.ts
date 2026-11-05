import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/role-guard';
import { ExpensePeriodsController } from '../expense-periods/expense-periods.controller';
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
 * xem, ngoài ra chỉ còn quyền xác nhận đúng BBCS.
 */
describe('Quản lý thu chi — sales admin tạo bảng chi phí rỗng', () => {
  it.each(SALES_ADMINS)('%s gọi được POST /school-expenses', (role) => {
    expect(allows('create', [role])).toBe(true);
  });

  it.each(SALES_ADMINS)('%s vẫn không sửa / xoá được bảng', (role) => {
    expect(allows('update', [role])).toBe(false);
    expect(allows('remove', [role])).toBe(false);
    expect(allows('saveAll', [role])).toBe(false);
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

});

describe('Kỳ chi phí — sales admin tạo kỳ để mở bảng rỗng', () => {
  const makeController = () => {
    const service = { create: jest.fn().mockResolvedValue({ id: 77 }) };
    return { controller: new ExpensePeriodsController(service as any), service };
  };
  const reqOf = (roles: string[]) => ({ user: { roles } });

  it('tạo được kỳ theo tháng thật', async () => {
    const { controller, service } = makeController();
    await controller.create({ month: 11, year: 2026, schoolId: 5 }, reqOf(['saleadmin']));
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it.each([[undefined], [13], [0]])('không thêm được dòng tuỳ chỉnh (month=%s)', (month) => {
    const { controller, service } = makeController();
    expect(() =>
      controller.create({ month, year: 2026, schoolId: 5 }, reqOf(['saleadmin'])),
    ).toThrow(ForbiddenException);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('kế toán vẫn thêm được dòng tuỳ chỉnh', async () => {
    const { controller, service } = makeController();
    await controller.create({ year: 2026, schoolId: 5 }, reqOf(['accountant']));
    expect(service.create).toHaveBeenCalledTimes(1);
  });
});
