import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/role-guard';
import { CashPolicyItemsController } from '../cash-policy-item/cash-policy-items.controller';
import { RevenueEInvoicesController } from '../einvoice/revenue-einvoices.controller';
import { ExpenseItemsController } from '../expense-item/expense-items.controller';
import { ExpensePeriodsController } from '../expense-periods/expense-periods.controller';
import { ManagementExpenseItemsController } from '../management-expense-item/management-expense-items.controller';
import { PolicyYearController } from '../policy-year/policy-year.controller';
import { RevenueItemsController } from '../revenue-item/revenue-items.controller';
import { SchoolExpenseItemsController } from '../school-expense-item/school-expense-items.controller';
import { RealExpensesController } from './real-expenses.controller';

type ControllerClass = { prototype: Record<string, unknown> };

function canAccess(
  controller: ControllerClass,
  methodName: string,
  roles: string[],
) {
  const guard = new RolesGuard(new Reflector());
  const context = {
    getHandler: () => controller.prototype[methodName],
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({ user: { roles } }),
    }),
  } as unknown as ExecutionContext;

  return guard.canActivate(context);
}

describe('Quản lý thu chi — quyền Sales Admin', () => {
  const salesAdminRoles = ['saleadmin', 'salesadmin', 'salesadmin_la'];

  const readEndpoints: Array<[ControllerClass, string]> = [
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
    [ExpensePeriodsController, 'findAll'],
    [ExpensePeriodsController, 'findOne'],
    [ExpenseItemsController, 'findAll'],
    [ExpenseItemsController, 'findOne'],
    [CashPolicyItemsController, 'findAll'],
    [CashPolicyItemsController, 'findOne'],
    [PolicyYearController, 'find'],
    [PolicyYearController, 'findOne'],
  ];

  const forbiddenWriteEndpoints: Array<[ControllerClass, string]> = [
    [RealExpensesController, 'update'],
    [RealExpensesController, 'remove'],
    [RealExpensesController, 'saveAll'],
    [RealExpensesController, 'unconfirmManagementExpense'],
    [RealExpensesController, 'finalize'],
    [RealExpensesController, 'reopen'],
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
    [RevenueEInvoicesController, 'unlink'],
    [ExpensePeriodsController, 'duplicate'],
    [ExpensePeriodsController, 'update'],
    [ExpensePeriodsController, 'remove'],
    [ExpensePeriodsController, 'lock'],
    [ExpensePeriodsController, 'open'],
    [ExpenseItemsController, 'create'],
    [ExpenseItemsController, 'update'],
    [ExpenseItemsController, 'remove'],
    [CashPolicyItemsController, 'create'],
    [CashPolicyItemsController, 'update'],
    [CashPolicyItemsController, 'remove'],
    [PolicyYearController, 'upsert'],
  ];

  it.each(salesAdminRoles)('%s xem được toàn bộ dữ liệu thu chi', (role) => {
    for (const [controller, method] of readEndpoints) {
      expect(canAccess(controller, method, [role])).toBe(true);
    }
  });

  it.each(salesAdminRoles)(
    '%s chỉ được xác nhận đúng BBCS và tạo bảng rỗng',
    (role) => {
      expect(
        canAccess(RealExpensesController, 'confirmManagementExpense', [role]),
      ).toBe(true);
      expect(canAccess(RealExpensesController, 'create', [role])).toBe(true);
      expect(canAccess(ExpensePeriodsController, 'create', [role])).toBe(true);

      for (const [controller, method] of forbiddenWriteEndpoints) {
        expect(canAccess(controller, method, [role])).toBe(false);
      }
    },
  );

  it('giữ nguyên quyền ghi của kế toán và quyền xác nhận của kế toán trưởng', () => {
    expect(canAccess(RealExpensesController, 'saveAll', ['accountant'])).toBe(
      true,
    );
    expect(
      canAccess(ManagementExpenseItemsController, 'update', ['ketoan_congno']),
    ).toBe(true);
    expect(
      canAccess(RealExpensesController, 'confirmManagementExpense', [
        'ketoan_truong',
      ]),
    ).toBe(true);
  });
});
