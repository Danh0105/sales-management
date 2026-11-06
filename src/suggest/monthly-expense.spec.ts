import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';

import { SubjectsController } from '../subject/subject.controller';
import { ExpenseRole } from './constants/expense-roles';
import { CreateExpenseRequestDto } from './dto/expense/create-expense-request.dto';
import { ExpenseAction } from './enums/expense-action.enum';
import { ExpenseRequestKind } from './enums/expense-request-kind.enum';
import { SuggestType } from './enums/suggest-type.enum';
import {
  assertExpenseTransition,
  expenseActorForStatus,
} from './expense-flow.state-machine';
import { SuggestStatus } from './SuggestStatus.enum';
import { SuggestService } from './suggest.service';

const sales = { actorRoles: [ExpenseRole.SALES], isOwner: true };
const accountant = { actorRoles: [ExpenseRole.DEBT_ACCOUNTANT], isOwner: false };
const chiefAccountant = {
  actorRoles: [ExpenseRole.CHIEF_ACCOUNTANT],
  isOwner: false,
};
const director = { actorRoles: [ExpenseRole.DIRECTOR], isOwner: false };
const salesAdmin = { actorRoles: [ExpenseRole.SALES_ADMIN], isOwner: false };
const treasurer = { actorRoles: [ExpenseRole.TREASURER], isOwner: false };

describe('Luồng đề xuất chi tháng', () => {
  it('đi đúng thứ tự: Kế toán nhập tiền, Giám đốc duyệt, Thủ quỹ xuất tiền', () => {
    let status = SuggestStatus.PENDING_ACCOUNTING;
    status = assertExpenseTransition(
      ExpenseAction.CREATE_MONTHLY_PAYMENT_ORDER,
      status,
      accountant,
    );
    expect(status).toBe(SuggestStatus.PENDING_APPROVAL);
    status = assertExpenseTransition(
      ExpenseAction.APPROVE_MONTHLY,
      status,
      director,
    );
    expect(status).toBe(SuggestStatus.PAYMENT_ORDERED);
    status = assertExpenseTransition(
      ExpenseAction.CONFIRM_CASH_RELEASED,
      status,
      treasurer,
    );
    expect(status).toBe(SuggestStatus.CASH_RELEASED);
  });

  it.each([
    ['Sales Admin', salesAdmin],
    ['Kế toán trưởng', chiefAccountant],
    ['Kế toán công nợ', accountant],
  ])('%s không duyệt hay từ chối được thay Giám đốc', (_name, actor) => {
    for (const action of [
      ExpenseAction.APPROVE_MONTHLY,
      ExpenseAction.REJECT_MONTHLY,
    ]) {
      expect(() =>
        assertExpenseTransition(action, SuggestStatus.PENDING_APPROVAL, actor),
      ).toThrow(ForbiddenException);
    }
  });

  it('Giám đốc không duyệt được khi Kế toán chưa nhập tiền', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.APPROVE_MONTHLY,
        SuggestStatus.PENDING_ACCOUNTING,
        director,
      ),
    ).toThrow(ConflictException);
  });

  it('người lập kiêm kế toán không tự nhập tiền cho đề xuất của mình', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CREATE_MONTHLY_PAYMENT_ORDER,
        SuggestStatus.PENDING_ACCOUNTING,
        {
          actorRoles: [ExpenseRole.SALES, ExpenseRole.DEBT_ACCOUNTANT],
          isOwner: true,
        },
      ),
    ).toThrow(ForbiddenException);
  });

  it('chủ đơn rút được khi còn chờ Kế toán', () => {
    expect(
      assertExpenseTransition(
        ExpenseAction.WITHDRAW,
        SuggestStatus.PENDING_ACCOUNTING,
        sales,
      ),
    ).toBe(SuggestStatus.WITHDRAWN);
  });

  it('Kế toán sửa số tiền sau khi đã chi thì quay lại chờ Giám đốc', () => {
    expect(
      assertExpenseTransition(
        ExpenseAction.EDIT_MONTHLY_PAYMENT_ORDER,
        SuggestStatus.SPENT,
        accountant,
      ),
    ).toBe(SuggestStatus.PENDING_APPROVAL);
  });

  it('chỉ đề xuất tiền mới đi luồng tháng', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CREATE_MONTHLY_PAYMENT_ORDER,
        SuggestStatus.PENDING_ACCOUNTING,
        { ...accountant, kind: ExpenseRequestKind.EQUIPMENT },
      ),
    ).toThrow(ConflictException);
  });

  it('xác định đúng bộ phận giữ từng bước', () => {
    expect(expenseActorForStatus(SuggestStatus.PENDING_ACCOUNTING)).toEqual({
      roles: [ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT],
      owner: false,
    });
    expect(
      expenseActorForStatus(
        SuggestStatus.PENDING_APPROVAL,
        ExpenseRequestKind.CASH,
        null,
        true,
      ),
    ).toEqual({ roles: [ExpenseRole.DIRECTOR], owner: false });
    // Đề xuất năm vẫn giữ nguyên người duyệt cũ.
    expect(
      expenseActorForStatus(SuggestStatus.PENDING_APPROVAL)?.roles,
    ).toEqual(expect.arrayContaining([ExpenseRole.SALES_ADMIN]));
  });
});

describe('DTO đề xuất chi tháng', () => {
  it('ép kiểu đúng từ multipart, kể cả cờ false', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const metadata = {
      type: 'body' as const,
      metatype: CreateExpenseRequestDto,
    };
    const base = { content: 'Chi', expectedPaymentDate: '2099-09-15' };
    await expect(
      pipe.transform(
        {
          ...base,
          isMonthlyExpense: 'true',
          subjectId: '901',
          expensePeriodId: '77',
        },
        metadata,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        isMonthlyExpense: true,
        subjectId: 901,
        expensePeriodId: 77,
      }),
    );
    await expect(
      pipe.transform({ ...base, isMonthlyExpense: 'false' }, metadata),
    ).resolves.toEqual(expect.objectContaining({ isMonthlyExpense: false }));
  });
});

describe('Tạo đề xuất chi tháng', () => {
  const body = {
    content: 'Chi tháng 9',
    expectedPaymentDate: '2099-09-15',
    schoolYear: '2099-2100',
    type: SuggestType.EXPENSE_REQUEST,
  };
  const user = { id: 7, roles: [ExpenseRole.SALES] } as never;
  const school = { id: 445, name: 'TH ABC' };
  const subject = { id: 901, schoolId: 445, schoolYear: '2099-2100' };
  const period = { id: 77, name: 'Tháng 9', school };

  const makeService = (found: unknown[]) => {
    const findOne = jest.fn();
    found.forEach((row) => findOne.mockResolvedValueOnce(row));
    const manager = {
      findOne,
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn((_entity, data) => data),
      save: jest.fn(async (data) => ({ ...data, id: 125 })),
    };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      dataSource: { transaction: jest.fn((run) => run(manager)) },
      generateCode: jest.fn().mockResolvedValue('DX-1'),
      writeExpenseLog: jest.fn(),
      expenseNextStepDetails: jest.fn(),
      notifyExpense: jest.fn(),
      findOneExpense: jest.fn().mockResolvedValue({ id: 125 }),
    });
    return { service, manager };
  };

  it('lưu môn và kỳ, cố định tiền, chuyển Kế toán công nợ', async () => {
    const { service, manager } = makeService([school, subject, period]);
    await service.create(
      {
        ...body,
        schoolId: 445,
        isMonthlyExpense: true,
        subjectId: 901,
        expensePeriodId: 77,
      } as never,
      undefined,
      user,
    );
    expect(manager.create.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        isMonthlyExpense: true,
        requestKind: ExpenseRequestKind.CASH,
        status: SuggestStatus.PENDING_ACCOUNTING,
        subjectId: 901,
        expensePeriodId: 77,
      }),
    );
    expect((service as never as { notifyExpense: jest.Mock }).notifyExpense)
      .toHaveBeenCalledWith(expect.anything(), {
        roles: [ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT],
      });
  });

  it('đề xuất năm vẫn gửi Giám đốc và không có môn, kỳ', async () => {
    const { service, manager } = makeService([school]);
    await service.create(
      { ...body, schoolId: 445, isMonthlyExpense: false } as never,
      undefined,
      user,
    );
    expect(manager.create.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        isMonthlyExpense: false,
        requestKind: null,
        status: SuggestStatus.PENDING_APPROVAL,
      }),
    );
    expect(manager.create.mock.calls[0][1].subjectId).toBeUndefined();
  });

  it.each([
    [
      'thiếu môn và kỳ',
      { schoolId: 445, isMonthlyExpense: true },
      [school],
      'phải chọn môn học và kỳ kế toán',
    ],
    [
      'chọn môn của năm học khác',
      { schoolId: 445, subjectId: 901, expensePeriodId: 77 },
      [school, { ...subject, schoolYear: '2098-2099' }],
      'Môn học không thuộc trường và năm học',
    ],
    [
      'chọn môn của trường khác',
      { schoolId: 445, subjectId: 901, expensePeriodId: 77 },
      [school, { ...subject, schoolId: 999 }],
      'Môn học không thuộc trường và năm học',
    ],
    [
      'chọn kỳ của trường khác',
      { schoolId: 445, subjectId: 901, expensePeriodId: 77 },
      [school, subject, { id: 77, school: { id: 999 } }],
      'Kỳ kế toán không thuộc trường',
    ],
    [
      'kỳ không tồn tại',
      { schoolId: 445, subjectId: 901, expensePeriodId: 77 },
      [school, subject, null],
      'Kỳ kế toán không tồn tại',
    ],
    [
      'chi tháng theo phường/xã',
      { wardId: 12, isMonthlyExpense: true },
      [],
      'phải chọn trường',
    ],
  ])('từ chối khi %s', async (_name, extra, found, message) => {
    const { service, manager } = makeService(found);
    await expect(
      service.create({ ...body, ...extra } as never, undefined, user),
    ).rejects.toThrow(message);
    expect(manager.save).not.toHaveBeenCalled();
  });
});

describe('Chủ đơn sửa đề xuất chi tháng', () => {
  const actor = { id: 7, roles: [ExpenseRole.SALES] } as never;
  const makeService = (status: SuggestStatus) => {
    const manager = {
      findOne: jest.fn().mockResolvedValue({
        id: 5,
        type: SuggestType.EXPENSE_REQUEST,
        createdBy: 7,
        status,
        isMonthlyExpense: true,
        content: 'Chi',
        expectedPaymentDate: '2099-09-15',
      }),
      delete: jest.fn(),
      save: jest.fn(),
    };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      dataSource: { transaction: jest.fn((run) => run(manager)) },
    });
    return { service, manager };
  };

  it.each([
    SuggestStatus.CASH_RELEASED,
    SuggestStatus.CASH_RECEIVED,
    SuggestStatus.SPENT,
    SuggestStatus.NOT_SPENT,
  ])('tiền đã xuất (%s) thì không sửa được, lệnh chi giữ nguyên', async (status) => {
    const { service, manager } = makeService(status);
    await expect(
      service.updateExpense(5, { content: 'Sửa' } as never, undefined, actor),
    ).rejects.toThrow(BadRequestException);
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
});

describe('GET /subjects', () => {
  it('truyền năm học xuống để không hiện môn của năm khác', () => {
    const service = {
      findBySchool: jest.fn(),
      findAll: jest.fn(),
    };
    const controller = new SubjectsController(service as never);
    controller.findAll('467', '2026-2027');
    expect(service.findBySchool).toHaveBeenCalledWith(467, '2026-2027');
    controller.findAll('467');
    expect(service.findBySchool).toHaveBeenLastCalledWith(467, undefined);
  });
});
