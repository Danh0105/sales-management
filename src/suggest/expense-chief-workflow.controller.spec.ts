import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from '../auth/roles.decorator';
import { ExpenseRole } from './constants/expense-roles';
import { ExpenseRequestController } from './expense-request.controller';

describe('ExpenseRequestController — quyền workflow của Kế toán trưởng', () => {
  const reflector = new Reflector();

  it.each([
    'cashReceived',
    'confirmSpent',
    'confirmPartiallySpent',
    'confirmNotSpent',
    'withdraw',
    'approve',
    'reject',
    'equipmentReceived',
    'stockIssueOrder',
    'equipmentReturned',
    'repairAccept',
    'repairReject',
  ] as const)('%s cho phép ketoan_truong qua HTTP guard', (method) => {
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      ExpenseRequestController.prototype[method],
    );
    expect(roles).toContain(ExpenseRole.CHIEF_ACCOUNTANT);
  });
});
