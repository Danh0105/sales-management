import { Repository } from 'typeorm';

import { ROLES_KEY } from './roles.decorator';
import { WarehouseController } from '../warehouse/warehouse.controller';
import { EmployeeController } from '../employee/employee.controller';
import {
  PAYROLL_MANAGE_ROLES,
  canViewAllPayrolls,
} from '../payroll/payroll.roles';
import { FinancialAccessService } from '../financial-request/financial-access.service';
import {
  FinanceRole,
  FinancialRequestType,
} from '../financial-request/financial-request.constants';
import { Employee } from '../employee/employee.entity';
import { FinancialApprovalDelegation } from '../financial-request/entities/financial-approval-delegation.entity';
import { FinancialRequest } from '../financial-request/entities/financial-request.entity';
import { FinancialRoleAssignment } from '../financial-request/entities/financial-role-assignment.entity';

/**
 * Trợ lý giám đốc (`troly_gd`) xem được các chức năng của Giám đốc nhưng chỉ
 * đọc ở những phần mở thêm: kho, danh mục chức vụ, phiếu lương, đề nghị tài
 * chính nội bộ.
 */
const ASSISTANT = 'troly_gd';

const rolesOf = (controller: any, method: string) =>
  Reflect.getMetadata(ROLES_KEY, controller.prototype[method]) as
    | string[]
    | undefined;

describe('Trợ lý GĐ — chỉ xem ở các phần mở thêm', () => {
  it('kho: xem tồn kho, chi tiết và phiếu nhập/xuất; không tạo/sửa/lập phiếu', () => {
    const controller = WarehouseController as any;
    for (const method of ['listItems', 'getItem', 'listReceipts']) {
      expect(rolesOf(controller, method)).toContain(ASSISTANT);
    }
    const writeMethods = Object.getOwnPropertyNames(controller.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        !['listItems', 'getItem', 'listReceipts'].includes(name),
    );
    expect(writeMethods.length).toBeGreaterThan(0);
    for (const method of writeMethods) {
      expect(rolesOf(controller, method) ?? []).not.toContain(ASSISTANT);
    }
  });

  it('nhân viên: đọc danh mục chức vụ nhưng không tạo / xoá nhân viên', () => {
    const controller = EmployeeController as any;
    expect(rolesOf(controller, 'positions')).toContain(ASSISTANT);
    expect(rolesOf(controller, 'create')).not.toContain(ASSISTANT);
    expect(rolesOf(controller, 'remove')).not.toContain(ASSISTANT);
  });

  it('phiếu lương: xem tất cả, không lập/sửa/xoá', () => {
    expect(canViewAllPayrolls([ASSISTANT])).toBe(true);
    expect(PAYROLL_MANAGE_ROLES).not.toContain(ASSISTANT);
  });

  describe('đề nghị tài chính nội bộ', () => {
    const access = new FinancialAccessService(
      { find: async () => [] } as unknown as Repository<FinancialRoleAssignment>,
      {
        createQueryBuilder: () => {
          const qb: any = {
            where: () => qb,
            andWhere: () => qb,
            getMany: async () => [],
          };
          return qb;
        },
      } as unknown as Repository<FinancialApprovalDelegation>,
      {} as Repository<Employee>,
    );
    const user = { id: 77, name: 'Trợ lý', roles: [ASSISTANT] } as any;
    const request = {
      id: 9,
      companyId: 3,
      departmentId: 4,
      requesterId: 100,
      createdById: 100,
      directManagerId: 200,
      type: FinancialRequestType.EXPENSE_PAYMENT,
    } as FinancialRequest;

    it('được gán ngầm vai trò Xem báo cáo (VIEWER) trên mọi công ty', async () => {
      const ctx = await access.context(user);
      expect(ctx.scopes).toEqual([
        expect.objectContaining({
          role: FinanceRole.VIEWER,
          companyId: null,
          departmentId: null,
        }),
      ]);
      expect(ctx.isAdmin).toBe(false);
    });

    it('xem được phiếu của người khác nhưng không có vai trò duyệt / chi tiền', async () => {
      const ctx = await access.context(user);
      expect(access.canView(ctx, request, [])).toBe(true);
      expect(
        access.hasAnyRole(ctx, [
          FinanceRole.MANAGER,
          FinanceRole.CONTROLLER,
          FinanceRole.ACCOUNTANT,
          FinanceRole.CASHIER,
          FinanceRole.DIRECTOR,
          FinanceRole.ADMIN,
        ]),
      ).toBe(false);
    });
  });
});
