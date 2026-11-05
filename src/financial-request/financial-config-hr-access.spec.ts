import { ForbiddenException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { Employee } from '../employee/employee.entity';
import { AuthUser } from '../type/auth-user.type';
import { FinancialApprovalDelegation } from './entities/financial-approval-delegation.entity';
import { FinancialRoleAssignment } from './entities/financial-role-assignment.entity';
import { FinancialAccessService } from './financial-access.service';
import { FinancialConfigService } from './financial-config.service';
import { FinanceRole } from './financial-request.constants';

const HR_ID = 158;
const OTHER_ID = 200;

const hr = { id: HR_ID, name: 'HR', roles: ['nhansu'] } as AuthUser;
const director = { id: 1, name: 'GĐ', roles: ['director'] } as AuthUser;
const staff = { id: 5, name: 'NV', roles: ['employee'] } as AuthUser;

/** Repo rỗng đủ để đi qua `context()`: không có gán vai trò hay uỷ quyền nào. */
const emptyAccessRepos = () => {
  const assignmentRepo = { find: jest.fn().mockResolvedValue([]) };
  const delegationRepo = {
    createQueryBuilder: () => ({
      where: function () {
        return this;
      },
      andWhere: function () {
        return this;
      },
      getMany: () => Promise.resolve([]),
    }),
  };
  return new FinancialAccessService(
    assignmentRepo as unknown as Repository<FinancialRoleAssignment>,
    delegationRepo as unknown as Repository<FinancialApprovalDelegation>,
    {} as Repository<Employee>,
  );
};

describe('Nhân sự dùng Cấu hình quy trình nhưng không tự nâng quyền', () => {
  let access: FinancialAccessService;
  let manager: { getRepository: jest.Mock };
  let assignmentRow: Partial<FinancialRoleAssignment> | null;
  let service: FinancialConfigService;

  beforeEach(() => {
    access = emptyAccessRepos();
    assignmentRow = null;
    const assignmentTxRepo = {
      createQueryBuilder: () => ({
        where: function () {
          return this;
        },
        andWhere: function () {
          return this;
        },
        getOne: () => Promise.resolve(null),
      }),
      create: (value: object) => value,
      save: (value: object) => Promise.resolve({ id: 9, ...value }),
      findOne: () => Promise.resolve(assignmentRow),
    };
    const delegationTxRepo = {
      create: (value: object) => value,
      save: (value: object) => Promise.resolve({ id: 7, ...value }),
      findOne: () =>
        Promise.resolve({ id: 7, delegatorId: OTHER_ID, revokedAt: null }),
    };
    const employeeTxRepo = {
      findOne: () => Promise.resolve({ id: OTHER_ID, name: 'Khác' }),
    };
    manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === FinancialRoleAssignment) return assignmentTxRepo;
        if (entity === FinancialApprovalDelegation) return delegationTxRepo;
        if (entity === Employee) return employeeTxRepo;
        // Nhật ký kiểm toán.
        return { insert: jest.fn(), save: jest.fn(), create: (v: object) => v };
      }),
    };
    const dataSource = {
      transaction: (run: (m: unknown) => unknown) => run(manager),
    } as unknown as DataSource;
    const noRepo = {} as never;
    service = new FinancialConfigService(
      dataSource,
      access,
      noRepo,
      noRepo,
      noRepo,
      noRepo,
      noRepo,
      noRepo,
      noRepo,
    );
    jest
      .spyOn(service, 'refreshPendingCandidates')
      .mockResolvedValue(undefined as never);
  });

  const assign = (user: AuthUser, employeeId: number, role: FinanceRole) =>
    service.createAssignment(user, { employeeId, role });

  it('nhân sự có quyền cấu hình nhưng không thành quản trị phân hệ', async () => {
    const ctx = await access.context(hr);
    expect(access.canConfigure(ctx)).toBe(true);
    expect(ctx.isAdmin).toBe(false);
    expect(() => access.assertAdmin(ctx)).toThrow(ForbiddenException);
    const request = {
      companyId: 1,
      departmentId: 2,
      requesterId: 100,
      createdById: 100,
    };
    expect(access.canView(ctx, request)).toBe(false);
    expect(access.canRecordMoney(ctx, request)).toBe(false);
    expect(access.canVoidMoney(ctx, request)).toBe(false);
    expect(access.canSeeBank(ctx, request)).toBe(false);
  });

  it('nhân viên thường không vào được cấu hình', async () => {
    const ctx = await access.context(staff);
    expect(access.canConfigure(ctx)).toBe(false);
    await expect(
      assign(staff, OTHER_ID, FinanceRole.MANAGER),
    ).rejects.toThrow(ForbiddenException);
  });

  it('nhân sự gán được vai trò thường cho người khác', async () => {
    await expect(
      assign(hr, OTHER_ID, FinanceRole.MANAGER),
    ).resolves.toMatchObject({ employeeId: OTHER_ID });
  });

  it('nhân sự không gán được vai trò quản trị, kể cả cho người khác', async () => {
    await expect(assign(hr, OTHER_ID, FinanceRole.ADMIN)).rejects.toThrow(
      'vai trò quản trị',
    );
  });

  it('nhân sự không tự gán vai trò tài chính cho chính mình', async () => {
    await expect(assign(hr, HR_ID, FinanceRole.ACCOUNTANT)).rejects.toThrow(
      'của chính mình',
    );
  });

  it('giám đốc vẫn gán được vai trò quản trị', async () => {
    await expect(
      assign(director, OTHER_ID, FinanceRole.ADMIN),
    ).resolves.toMatchObject({ role: FinanceRole.ADMIN });
  });

  it('nhân sự không thu hồi được vai trò quản trị hay vai trò của mình', async () => {
    assignmentRow = {
      id: 3,
      employeeId: OTHER_ID,
      role: FinanceRole.ADMIN,
      isActive: true,
    };
    await expect(service.removeAssignment(hr, 3)).rejects.toThrow(
      'vai trò quản trị',
    );
    assignmentRow = {
      id: 4,
      employeeId: HR_ID,
      role: FinanceRole.VIEWER,
      isActive: true,
    };
    await expect(service.removeAssignment(hr, 4)).rejects.toThrow(
      'của chính mình',
    );
  });

  it('nhân sự thu hồi được vai trò thường của người khác', async () => {
    assignmentRow = {
      id: 5,
      employeeId: OTHER_ID,
      role: FinanceRole.MANAGER,
      isActive: true,
    };
    await expect(service.removeAssignment(hr, 5)).resolves.toEqual({
      success: true,
    });
    expect(assignmentRow.isActive).toBe(false);
  });

  const delegation = (delegatorId: number, delegateId: number) => ({
    delegatorId,
    delegateId,
    startsAt: '2026-11-05T00:00:00.000Z',
    endsAt: '2026-11-08T00:00:00.000Z',
  });

  it('nhân sự uỷ quyền thay được, nhưng không tự nhận uỷ quyền của người khác', async () => {
    await expect(
      service.createDelegation(hr, delegation(OTHER_ID, 300)),
    ).resolves.toMatchObject({ delegatorId: OTHER_ID, delegateId: 300 });
    await expect(
      service.createDelegation(hr, delegation(OTHER_ID, HR_ID)),
    ).rejects.toThrow('Không được tự nhận');
  });

  it('nhân viên thường không uỷ quyền thay và không thu hồi được của người khác', async () => {
    await expect(
      service.createDelegation(staff, delegation(OTHER_ID, 300)),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.revokeDelegation(staff, 7)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('nhân sự thu hồi được uỷ quyền của người khác', async () => {
    await expect(service.revokeDelegation(hr, 7)).resolves.toMatchObject({
      id: 7,
      revokedById: HR_ID,
    });
  });
});
