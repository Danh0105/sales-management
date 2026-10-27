import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/role-guard';
import { RevenueEInvoicesController } from '../einvoice/revenue-einvoices.controller';
import { ManagementExpenseItemsController } from '../management-expense-item/management-expense-items.controller';
import { RevenueItemsController } from '../revenue-item/revenue-items.controller';
import { SchoolExpenseItemsController } from '../school-expense-item/school-expense-items.controller';
import { RealExpensesController } from './real-expenses.controller';

const guard = new RolesGuard(new Reflector());

/** Chạy RolesGuard thật cho route `controller.method` với user mang `roles`. */
const allows = (controller: any, method: string, roles: string[]) =>
  guard.canActivate({
    getHandler: () => controller.prototype[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
  } as unknown as ExecutionContext);

/**
 * Thủ quỹ dùng Quản lý thu chi như Kế toán: đọc, tạo bảng, nhập / sửa / xoá,
 * đẩy hóa đơn nháp — nhưng KHÔNG có các thao tác riêng của Kế toán trưởng
 * (xác nhận / mở khoá BBCS, kết thúc, mở lại, bỏ liên kết hóa đơn).
 */
describe('Quản lý thu chi — quyền của thủ quỹ', () => {
  const reads: [any, string][] = [
    [RealExpensesController, 'checkExisted'],
    [RealExpensesController, 'findAll'],
    [RealExpensesController, 'getItems'],
    [RealExpensesController, 'getHistory'],
    [RealExpensesController, 'findOne'],
    [RealExpensesController, 'getSummary'],
    [RevenueItemsController, 'findAll'],
    [RevenueItemsController, 'findOne'],
    [SchoolExpenseItemsController, 'findAll'],
    [SchoolExpenseItemsController, 'findOne'],
    [ManagementExpenseItemsController, 'findAll'],
    [ManagementExpenseItemsController, 'findOne'],
    [RevenueEInvoicesController, 'list'],
  ];

  const writes: [any, string][] = [
    [RealExpensesController, 'create'],
    [RealExpensesController, 'update'],
    [RealExpensesController, 'remove'],
    [RealExpensesController, 'saveAll'],
    [RevenueItemsController, 'create'],
    [RevenueItemsController, 'update'],
    [RevenueItemsController, 'remove'],
    [SchoolExpenseItemsController, 'create'],
    [SchoolExpenseItemsController, 'update'],
    [SchoolExpenseItemsController, 'remove'],
    [ManagementExpenseItemsController, 'create'],
    [ManagementExpenseItemsController, 'update'],
    [ManagementExpenseItemsController, 'remove'],
    [RevenueEInvoicesController, 'exportDrafts'],
  ];

  const chiefOnly: [any, string][] = [
    [RealExpensesController, 'confirmManagementExpense'],
    [RealExpensesController, 'unconfirmManagementExpense'],
    [RealExpensesController, 'finalize'],
    [RealExpensesController, 'reopen'],
    [RevenueEInvoicesController, 'unlink'],
  ];

  const named = (rows: [any, string][]) =>
    rows.map(([controller, method]) => [controller.name, method, controller]);

  it.each(named(reads))('%s.%s mở cho thuquy', (_, method, controller) => {
    expect(typeof controller.prototype[method]).toBe('function');
    expect(allows(controller, method, ['thuquy'])).toBe(true);
  });

  it.each(named(writes))('%s.%s mở cho thuquy (như accountant)', (_, method, controller) => {
    expect(typeof controller.prototype[method]).toBe('function');
    expect(allows(controller, method, ['thuquy'])).toBe(true);
    expect(allows(controller, method, ['accountant'])).toBe(true);
  });

  it.each(named(chiefOnly))('%s.%s KHÔNG mở cho thuquy', (_, method, controller) => {
    expect(typeof controller.prototype[method]).toBe('function');
    expect(allows(controller, method, ['thuquy'])).toBe(false);
    expect(allows(controller, method, ['ketoan_truong'])).toBe(true);
  });

  it('role khác (sales) vẫn bị chặn', () => {
    expect(allows(RealExpensesController, 'findAll', ['sales'])).toBe(false);
    expect(allows(RealExpensesController, 'saveAll', ['sales'])).toBe(false);
  });

  it('sales admin vẫn sửa được Chi Ngoài, kế toán vẫn đọc được', () => {
    for (const method of ['create', 'update', 'remove', 'findAll']) {
      for (const role of ['saleadmin', 'accountant', 'director']) {
        expect(allows(ManagementExpenseItemsController, method, [role])).toBe(
          true,
        );
      }
    }
  });
});
