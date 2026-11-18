import { Repository } from 'typeorm';

import { Employee } from '../employee/employee.entity';
import { FinancialApprovalDelegation } from './entities/financial-approval-delegation.entity';
import { FinancialApprovalStep } from './entities/financial-approval-step.entity';
import { FinancialRequest } from './entities/financial-request.entity';
import { FinancialRoleAssignment } from './entities/financial-role-assignment.entity';
import {
  FinanceContext,
  FinancialAccessService,
} from './financial-access.service';
import { FinancialRequestType, StepStatus } from './financial-request.constants';

const access = new FinancialAccessService(
  {} as Repository<FinancialRoleAssignment>,
  {} as Repository<FinancialApprovalDelegation>,
  {} as Repository<Employee>,
);

const context = (userId: number): FinanceContext => ({
  userId,
  name: `#${userId}`,
  systemRoles: [],
  scopes: [],
  isAdmin: false,
  delegations: [],
});

const request = {
  id: 50,
  companyId: 1,
  departmentId: 2,
  requesterId: 100,
  createdById: 100,
  directManagerId: 201,
  type: FinancialRequestType.EXPENSE_PAYMENT,
} as FinancialRequest;

const step = (
  status: StepStatus,
  candidateApproverIds: number[],
  actedById: number | null = null,
) =>
  ({ status, candidateApproverIds, actedById }) as FinancialApprovalStep;

describe('FinancialAccessService.canView — quyền xem xuyên suốt quy trình duyệt', () => {
  const steps = [
    step(StepStatus.PENDING, [201]),
    step(StepStatus.WAITING, [202]),
    step(StepStatus.WAITING, [203]),
  ];

  it('cấp duyệt hiện tại xem được chi tiết và tệp đính kèm', () => {
    expect(access.canView(context(201), request, steps)).toBe(true);
  });

  it('các cấp duyệt sau ở trạng thái chờ vẫn xem được chi tiết và tệp', () => {
    expect(access.canView(context(202), request, steps)).toBe(true);
    expect(access.canView(context(203), request, steps)).toBe(true);
  });

  it('người đã duyệt vẫn xem lại được chứng từ', () => {
    const completed = [step(StepStatus.APPROVED, [201], 201)];
    expect(access.canView(context(201), request, completed)).toBe(true);
  });

  it('người ngoài quy trình không được xem', () => {
    expect(access.canView(context(999), request, steps)).toBe(false);
  });
});
