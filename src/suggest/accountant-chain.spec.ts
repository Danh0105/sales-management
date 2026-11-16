import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import { ExpensePeriod } from '../expense-periods/expense-period.entity';
import { School } from '../school/schools.entity';
import { ACCOUNTANT_CHAIN, schoolYearOfPeriod } from './cashflow-sources';
import { ExpenseRole } from './constants/expense-roles';
import { Suggest } from './entities/suggest.entity';
import { SuggestMonthlyItem } from './entities/suggest-monthly-item.entity';
import { SuggestPaymentOrder } from './entities/suggest-payment-order.entity';
import { ExpenseAction } from './enums/expense-action.enum';
import { ExpenseRequestKind } from './enums/expense-request-kind.enum';
import { SuggestType } from './enums/suggest-type.enum';
import {
  assertExpenseTransition,
  expenseActorForStatus,
} from './expense-flow.state-machine';
import {
  cashSupportActualAmount,
  loadPolicySupport,
} from './policy-support';
import { SuggestStatus } from './SuggestStatus.enum';
import { SuggestService } from './suggest.service';

const accountant = { actorRoles: [ExpenseRole.ACCOUNTANT], isOwner: false, actorId: 20 };
const chief = { actorRoles: [ExpenseRole.CHIEF_ACCOUNTANT], isOwner: false, actorId: 21 };
const director = { actorRoles: [ExpenseRole.DIRECTOR], isOwner: false, actorId: 1 };
const debt = { actorRoles: [ExpenseRole.DEBT_ACCOUNTANT], isOwner: false, actorId: 22 };
const treasurer = { actorRoles: [ExpenseRole.TREASURER], isOwner: false, actorId: 23 };
const owner = { actorRoles: [ExpenseRole.SALES], isOwner: true, actorId: 7 };

describe('Quy trình Kế toán — state machine', () => {
  it('KD → Kế toán → KTT → GĐ → KT công nợ → Thủ quỹ → KD', () => {
    let status = SuggestStatus.PENDING_ACCOUNTANT;
    const step = (action: ExpenseAction, ctx: object, previousActorId: number | null) =>
      assertExpenseTransition(action, status, { ...ctx, previousActorId } as never);

    status = step(ExpenseAction.SUBMIT_TO_CHIEF_ACCOUNTANT, accountant, 7);
    expect(status).toBe(SuggestStatus.PENDING_CHIEF_APPROVAL);
    status = step(ExpenseAction.CHIEF_APPROVE, chief, 20);
    expect(status).toBe(SuggestStatus.PENDING_APPROVAL);
    status = step(ExpenseAction.APPROVE_MONTHLY_CHAIN, director, 21);
    expect(status).toBe(SuggestStatus.APPROVED);
    status = step(ExpenseAction.CREATE_PAYMENT_ORDER, debt, 1);
    expect(status).toBe(SuggestStatus.PAYMENT_ORDERED);
    status = step(ExpenseAction.CONFIRM_CASH_RELEASED, treasurer, 22);
    expect(status).toBe(SuggestStatus.CASH_RELEASED);
    status = step(ExpenseAction.CONFIRM_CASH_RECEIVED, owner, 23);
    expect(status).toBe(SuggestStatus.CASH_RECEIVED);
    status = step(ExpenseAction.CONFIRM_SPENT, owner, 7);
    expect(status).toBe(SuggestStatus.SPENT);
  });

  it('Kế toán trưởng làm được bước Kế toán nhưng không tự duyệt tiếp', () => {
    expect(
      assertExpenseTransition(
        ExpenseAction.SUBMIT_TO_CHIEF_ACCOUNTANT,
        SuggestStatus.PENDING_ACCOUNTANT,
        chief,
      ),
    ).toBe(SuggestStatus.PENDING_CHIEF_APPROVAL);
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CHIEF_APPROVE,
        SuggestStatus.PENDING_CHIEF_APPROVAL,
        { ...chief, previousActorId: 21 },
      ),
    ).toThrow(ForbiddenException);
  });

  it.each([
    ['Kế toán công nợ', debt],
    ['Thủ quỹ', treasurer],
    ['Giám đốc', director],
  ])('%s không làm bước Kế toán nhập số liệu', (_name, actor) => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.SUBMIT_TO_CHIEF_ACCOUNTANT,
        SuggestStatus.PENDING_ACCOUNTANT,
        actor,
      ),
    ).toThrow(ForbiddenException);
  });

  it.each([
    ['Kế toán', accountant],
    ['Giám đốc', director],
  ])('%s không duyệt thay Kế toán trưởng', (_name, actor) => {
    for (const action of [ExpenseAction.CHIEF_APPROVE, ExpenseAction.CHIEF_REJECT]) {
      expect(() =>
        assertExpenseTransition(action, SuggestStatus.PENDING_CHIEF_APPROVAL, actor),
      ).toThrow(ForbiddenException);
    }
  });

  it('chủ đơn kiêm kế toán không tự nhập số liệu cho đề xuất của mình', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.SUBMIT_TO_CHIEF_ACCOUNTANT,
        SuggestStatus.PENDING_ACCOUNTANT,
        { actorRoles: [ExpenseRole.SALES, ExpenseRole.ACCOUNTANT], isOwner: true },
      ),
    ).toThrow(ForbiddenException);
  });

  it('Giám đốc không duyệt khi Kế toán trưởng chưa duyệt', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.APPROVE_MONTHLY_CHAIN,
        SuggestStatus.PENDING_CHIEF_APPROVAL,
        director,
      ),
    ).toThrow(ConflictException);
  });

  it('Kế toán trưởng từ chối thì kết thúc', () => {
    expect(
      assertExpenseTransition(
        ExpenseAction.CHIEF_REJECT,
        SuggestStatus.PENDING_CHIEF_APPROVAL,
        chief,
      ),
    ).toBe(SuggestStatus.REJECTED);
  });

  it.each([SuggestStatus.PENDING_ACCOUNTANT, SuggestStatus.PENDING_CHIEF_APPROVAL])(
    'chủ đơn rút được khi %s',
    (status) => {
      expect(assertExpenseTransition(ExpenseAction.WITHDRAW, status, owner)).toBe(
        SuggestStatus.WITHDRAWN,
      );
    },
  );

  it('người giữ bước của trạng thái mới', () => {
    expect(expenseActorForStatus(SuggestStatus.PENDING_ACCOUNTANT)?.roles).toEqual([
      ExpenseRole.ACCOUNTANT,
      ExpenseRole.CHIEF_ACCOUNTANT,
    ]);
    expect(expenseActorForStatus(SuggestStatus.PENDING_CHIEF_APPROVAL)?.roles).toEqual([
      ExpenseRole.CHIEF_ACCOUNTANT,
    ]);
    expect(
      expenseActorForStatus(SuggestStatus.APPROVED, ExpenseRequestKind.CASH, null, true)
        ?.roles,
    ).toEqual([ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT]);
  });
});

// ---------------------------------------------------------------------------

const school = { id: 445, name: 'TH A' };
const period = { id: 77, month: 9, year: 2099, name: 'Tháng 9/2099', school };
const sales = { id: 7, roles: [ExpenseRole.SALES] } as never;
const body = {
  content: 'Chi tháng 9',
  expectedPaymentDate: '2099-09-15',
  type: SuggestType.EXPENSE_REQUEST,
};

type QueryRule = (sql: string, params: unknown[]) => unknown[] | undefined;

function makeManager(options: {
  findOne?: (entity: unknown, opts: any) => unknown;
  query?: QueryRule;
  periodsByQb?: unknown[];
}) {
  const periodsByQb = [...(options.periodsByQb ?? [])];
  const qb: any = {};
  for (const method of ['leftJoinAndSelect', 'where', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getOne = jest.fn(async () => periodsByQb.shift() ?? null);
  return {
    findOne: jest.fn(async (entity: unknown, opts: any) =>
      options.findOne ? options.findOne(entity, opts) : null,
    ),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(1),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const ruled = options.query?.(sql, params);
      if (ruled) return ruled;
      if (sql.includes('FROM schools s WHERE s.employee_id')) return [{ id: 445 }];
      return [];
    }),
    create: jest.fn((_entity: unknown, data: unknown) => data),
    save: jest.fn(async (_entityOrData: unknown, data?: unknown) =>
      data === undefined ? { ...(_entityOrData as object), id: 125 } : data,
    ),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
}

function makeService(manager: ReturnType<typeof makeManager>) {
  const service = Object.create(SuggestService.prototype) as SuggestService;
  Object.assign(service as object, {
    dataSource: { transaction: jest.fn((run) => run(manager)), manager },
    generateCode: jest.fn().mockResolvedValue('DX-1'),
    writeExpenseLog: jest.fn(),
    expenseNextStepDetails: jest.fn().mockResolvedValue({}),
    notifyExpense: jest.fn(),
    findOneExpense: jest.fn().mockResolvedValue({ id: 125 }),
    // Bảng chưa có số liệu (Kế toán nhập ở bước sau); test riêng ở dưới.
    sheetGroups: jest.fn().mockResolvedValue({ groups: [], unassigned: [] }),
  });
  return service as SuggestService & { notifyExpense: jest.Mock; sheetGroups: jest.Mock };
}

const byEntity =
  (rows: Map<unknown, unknown>) =>
  (entity: unknown) =>
    rows.get(entity) ?? null;

describe('Kinh doanh tạo Chi Ngoài / Chi Trường / Chi GV trường', () => {
  it('chọn kỳ đã có: chờ Kế toán nhập số liệu, chưa có khoản, báo Kế toán', async () => {
    const manager = makeManager({
      findOne: byEntity(
        new Map<unknown, unknown>([
          [School, school],
          [ExpensePeriod, period],
        ]),
      ),
    });
    const service = makeService(manager);
    await service.create(
      { ...body, cashflowSource: 'SCHOOL_EXPENSE', schoolId: 445, expensePeriodId: 77 } as never,
      undefined,
      sales,
    );
    const created = manager.create.mock.calls.find(([entity]) => entity === Suggest)![1];
    expect(created).toEqual(
      expect.objectContaining({
        status: SuggestStatus.PENDING_ACCOUNTANT,
        approvalFlow: ACCOUNTANT_CHAIN,
        isMonthlyExpense: true,
        cashflowSource: 'SCHOOL_EXPENSE',
        requestKind: ExpenseRequestKind.CASH,
        schoolId: 445,
        expensePeriodId: 77,
        schoolYear: '2099-2100',
        amount: null,
      }),
    );
    expect(manager.save).not.toHaveBeenCalledWith(SuggestMonthlyItem, expect.anything());
    expect(service.notifyExpense).toHaveBeenCalledWith(expect.anything(), {
      roles: [ExpenseRole.ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT],
    });
  });

  it('kinh doanh không tạo kỳ kế toán: gửi tháng/năm mà không chọn kỳ thì từ chối, không tạo kỳ', async () => {
    const manager = makeManager({
      findOne: byEntity(new Map<unknown, unknown>([[School, school]])),
    });
    const service = makeService(manager);
    await expect(
      service.create(
        { ...body, cashflowSource: 'MANAGEMENT', schoolId: 445, periodMonth: 10, periodYear: 2099 } as never,
        undefined,
        sales,
      ),
    ).rejects.toThrow('Chọn kỳ kế toán của trường');
    expect(manager.insert).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('bảng đã có số liệu nhưng không còn khoản đề xuất được (Có trong HĐ) thì từ chối', async () => {
    const manager = makeManager({
      findOne: byEntity(
        new Map<unknown, unknown>([
          [School, school],
          [ExpensePeriod, period],
        ]),
      ),
    });
    const service = makeService(manager);
    service.sheetGroups.mockResolvedValue({
      groups: [{ key: '445:77:s1', remainingAmount: 0, inContractAmount: 500_000 }],
      unassigned: [],
    });
    await expect(
      service.create(
        { ...body, cashflowSource: 'SCHOOL_EXPENSE', schoolId: 445, expensePeriodId: 77 } as never,
        undefined,
        sales,
      ),
    ).rejects.toThrow('"Có trong HĐ" đã tính là đã chi');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('bảng còn khoản chưa chi thì tạo được', async () => {
    const manager = makeManager({
      findOne: byEntity(
        new Map<unknown, unknown>([
          [School, school],
          [ExpensePeriod, period],
        ]),
      ),
    });
    const service = makeService(manager);
    service.sheetGroups.mockResolvedValue({
      groups: [
        { key: '445:77:s1', remainingAmount: 0, inContractAmount: 500_000 },
        { key: '445:77:s2', remainingAmount: 200_000, inContractAmount: 0 },
      ],
      unassigned: [],
    });
    await expect(
      service.create(
        { ...body, cashflowSource: 'SCHOOL_EXPENSE', schoolId: 445, expensePeriodId: 77 } as never,
        undefined,
        sales,
      ),
    ).resolves.toEqual({ id: 125 });
  });

  it.each([
    ['không chọn kỳ', { schoolId: 445 }, 'Chọn kỳ kế toán của trường'],
    ['không chọn trường', { expensePeriodId: 77 }, 'Chọn trường của đề xuất'],
    [
      'client cũ gửi nhiều trường',
      {
        monthlyItems: [
          { schoolId: 445, subjectId: 1, expensePeriodId: 77 },
          { schoolId: 446, subjectId: 2, expensePeriodId: 78 },
        ],
      },
      'Mỗi đề xuất chỉ cho một trường',
    ],
    [
      'client cũ gửi nhiều kỳ',
      {
        monthlyItems: [
          { schoolId: 445, subjectId: 1, expensePeriodId: 77 },
          { schoolId: 445, subjectId: 2, expensePeriodId: 78 },
        ],
      },
      'Mỗi đề xuất chỉ cho một kỳ kế toán',
    ],
  ])('từ chối khi %s', async (_name, extra, message) => {
    const manager = makeManager({
      findOne: byEntity(
        new Map<unknown, unknown>([
          [School, school],
          [ExpensePeriod, period],
        ]),
      ),
    });
    const service = makeService(manager);
    await expect(
      service.create({ ...body, cashflowSource: 'MANAGEMENT', ...extra } as never, undefined, sales),
    ).rejects.toThrow(message);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('kỳ của trường khác thì từ chối', async () => {
    const manager = makeManager({
      findOne: byEntity(
        new Map<unknown, unknown>([
          [School, school],
          [ExpensePeriod, { ...period, school: { id: 999 } }],
        ]),
      ),
    });
    const service = makeService(manager);
    await expect(
      service.create(
        { ...body, cashflowSource: 'MANAGEMENT', schoolId: 445, expensePeriodId: 77 } as never,
        undefined,
        sales,
      ),
    ).rejects.toThrow('Kỳ kế toán không thuộc trường');
  });

  it('trường không phụ trách thì 403', async () => {
    const manager = makeManager({
      findOne: byEntity(
        new Map<unknown, unknown>([
          [School, school],
          [ExpensePeriod, period],
        ]),
      ),
      query: (sql) => (sql.includes('FROM schools s WHERE s.employee_id') ? [{ id: 1 }] : undefined),
    });
    const service = makeService(manager);
    await expect(
      service.create(
        { ...body, cashflowSource: 'MANAGEMENT', schoolId: 445, expensePeriodId: 77 } as never,
        undefined,
        sales,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('bảng đã có đề xuất đang chạy thì từ chối', async () => {
    const manager = makeManager({
      findOne: byEntity(
        new Map<unknown, unknown>([
          [School, school],
          [ExpensePeriod, period],
        ]),
      ),
      query: (sql) => (sql.includes('approval_flow = $1') ? [{ id: 90, code: 'DX-9' }] : undefined),
    });
    const service = makeService(manager);
    await expect(
      service.create(
        { ...body, cashflowSource: 'MANAGEMENT', schoolId: 445, expensePeriodId: 77 } as never,
        undefined,
        sales,
      ),
    ).rejects.toThrow('đã có đề xuất DX-9 đang chạy');
  });
});

describe('Đề xuất chi Năm cho trường cần chính sách có tiền mặt / thiết bị', () => {
  const policy = (data: object) => [
    { policy_id: 1, subject_id: 9, subject_name: 'Tin học', data },
  ];

  it.each([
    ['không có hỗ trợ', { httienmat: [], htthietbi: [] }, false],
    ['hỗ trợ tiền mặt 0 đồng', { httienmat: [{ money: 0 }], htthietbi: [] }, false],
    ['có tiền mặt', { httienmat: [{ money: 1000 }], htthietbi: [] }, true],
    ['chỉ có thiết bị', { httienmat: [], htthietbi: [{ qty: 2, price: 500 }] }, true],
  ])('%s', async (_name, data, allowed) => {
    const manager = makeManager({
      findOne: byEntity(new Map<unknown, unknown>([[School, school]])),
      query: (sql) => (sql.includes('FROM policy p') ? policy(data) : undefined),
    });
    const service = makeService(manager);
    const run = service.create(
      { ...body, schoolId: 445, schoolYear: '2099-2100' } as never,
      undefined,
      sales,
    );
    if (allowed) {
      await expect(run).resolves.toEqual({ id: 125 });
    } else {
      await expect(run).rejects.toThrow('không có hỗ trợ tiền mặt hoặc thiết bị');
    }
  });

  it('đề xuất phường/xã không kiểm chính sách', async () => {
    const manager = makeManager({
      findOne: () => ({ id: 12, name: 'P. 1' }),
    });
    const service = makeService(manager);
    await expect(
      service.create({ ...body, wardId: 12 } as never, undefined, sales),
    ).resolves.toEqual({ id: 125 });
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe('Bảng hỗ trợ trong chính sách', () => {
  it('tính thành tiền thực tế như form chính sách', () => {
    // 90 triệu / 1 năm / 1000 HS / 9 tháng × 500 HS × 9 tháng = 45 triệu
    expect(
      cashSupportActualAmount({ money: 90_000_000, realStudents: 500, months: 9 }),
    ).toBe(45_000_000);
    // Theo tiết: 72 triệu / 2 năm / 1000 / 36 × 1000 HS × 18 tiết = 18 triệu
    expect(
      cashSupportActualAmount(
        { money: 72_000_000, depreciationYears: 2, students: 1000, periods: 18 },
        'TIET',
      ),
    ).toBe(18_000_000);
  });

  it('gom tiền mặt + thiết bị của các môn, bỏ dòng 0 đồng', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        {
          policy_id: 1,
          subject_id: 9,
          subject_name: 'Tin học',
          data: {
            httienmat: [{ type: 'CS', money: 9_000_000, realStudents: 1000, months: 9 }, { money: 0 }],
            htthietbi: [{ category: 'Tablet', qty: 2, price: 3_000_000 }],
          },
        },
        {
          policy_id: 2,
          subject_id: 10,
          subject_name: 'STEM',
          data: { htthietbi: [{ category: 'Bộ kit', totalAmount: 1_500_000 }] },
        },
      ]),
    };
    const support = await loadPolicySupport(manager as never, 445, '2099-2100');
    expect(support.hasCash).toBe(true);
    expect(support.hasEquipment).toBe(true);
    expect(support.cash).toHaveLength(1);
    expect(support.cashTotal).toBe(9_000_000);
    expect(support.cashActualTotal).toBe(9_000_000);
    expect(support.equipment.map((row) => row.amount)).toEqual([6_000_000, 1_500_000]);
    expect(support.equipmentTotal).toBe(7_500_000);
    expect(manager.query.mock.calls[0][1]).toEqual([445, '2099-2100']);
  });
});

// ---------------------------------------------------------------------------

const group = (subjectId: number, remaining: number, extra: object = {}) => ({
  key: `445:77:s${subjectId}`,
  source: 'SCHOOL_EXPENSE',
  schoolId: 445,
  expensePeriodId: 77,
  subjectId,
  schoolTeacherId: null,
  schoolName: 'TH A',
  periodMonth: 9,
  periodYear: 2099,
  periodName: null,
  schoolExpenseIds: [5],
  schoolYear: '2099-2100',
  subjectName: `Môn ${subjectId}`,
  teacherName: null,
  rowCount: 1,
  totalAmount: remaining,
  paidAmount: 0,
  remainingAmount: remaining,
  finalized: false,
  ...extra,
});

describe('Kế toán gửi Kế toán trưởng', () => {
  const chainSuggest = {
    id: 125,
    code: 'DX-1',
    type: SuggestType.EXPENSE_REQUEST,
    isMonthlyExpense: true,
    approvalFlow: ACCOUNTANT_CHAIN,
    cashflowSource: 'SCHOOL_EXPENSE',
    schoolId: 445,
    expensePeriodId: 77,
    schoolYear: '2099-2100',
    status: SuggestStatus.PENDING_ACCOUNTANT,
  };

  const setup = (options: {
    groups: unknown[];
    unassigned?: unknown[];
    open?: unknown[];
    existing?: unknown[];
  }) => {
    const manager = makeManager({
      query: (sql) => {
        if (sql.includes('FROM suggest_monthly_items i')) return (options.open ?? []) as unknown[];
        return undefined;
      },
    });
    const service = makeService(manager);
    const s = { ...chainSuggest };
    Object.assign(service as object, {
      repo: { findOne: jest.fn().mockResolvedValue(s) },
      loadMonthlyRows: jest.fn().mockResolvedValue(options.existing ?? []),
      sheetGroups: jest
        .fn()
        .mockResolvedValue({ groups: options.groups, unassigned: options.unassigned ?? [] }),
      cashflowGroupsFor: jest
        .fn()
        .mockResolvedValue(new Map((options.groups as any[]).map((g) => [g.key, g]))),
      expenseTransition: jest.fn(async (opts) => {
        opts.mutate?.(s);
        await opts.extra?.(manager, s);
        const log = opts.logData ? await opts.logData(manager, s) : {};
        return { ...s, status: SuggestStatus.PENDING_CHIEF_APPROVAL, log };
      }),
    });
    return { service, manager, s };
  };

  it('chốt mọi khoản còn phải chi của bảng, số tiền = tổng Còn chi', async () => {
    const { service, manager, s } = setup({
      groups: [group(1, 300_000), group(2, 0), group(3, 200_000.5)],
    });
    const saved: any = await service.submitToChiefAccountant(125, { id: 20, roles: [ExpenseRole.ACCOUNTANT] } as never);
    const items = manager.save.mock.calls.find(([entity]) => entity === SuggestMonthlyItem)![1];
    expect(items).toEqual([
      expect.objectContaining({ subjectId: 1, requestedAmount: 300_000, position: 0, schoolId: 445, expensePeriodId: 77 }),
      expect.objectContaining({ subjectId: 3, requestedAmount: 200_000.5, position: 1 }),
    ]);
    expect(s.amount).toBe(500_000.5);
    expect(manager.update).toHaveBeenCalledWith(Suggest, { id: 125 }, { amount: 500_000.5 });
    expect(saved.log).toEqual(expect.objectContaining({ amount: 500_000.5, cashflowTable: 'Chi Trường' }));
    expect(service.notifyExpense).toHaveBeenCalledWith(expect.anything(), {
      roles: [ExpenseRole.CHIEF_ACCOUNTANT],
    });
  });

  it('khoản đang nằm trong đề xuất khác thì bỏ qua và ghi lại', async () => {
    const { service, manager } = setup({
      groups: [group(1, 300_000), group(3, 200_000)],
      open: [
        { suggest_id: 80, code: 'DX-80', status: 'PAYMENT_ORDERED', school_id: 445, expense_period_id: 77, subject_id: 3, school_teacher_id: null },
      ],
    });
    const saved: any = await service.submitToChiefAccountant(125, { id: 20, roles: [ExpenseRole.ACCOUNTANT] } as never);
    const items = manager.save.mock.calls.find(([entity]) => entity === SuggestMonthlyItem)![1];
    expect(items.map((item: any) => item.subjectId)).toEqual([1]);
    expect(saved.log.skippedItems).toEqual([
      expect.objectContaining({ code: 'DX-80', amount: 200_000 }),
    ]);
  });

  it('bảng chưa có số liệu (Còn chi = 0) thì không gửi được', async () => {
    const { service } = setup({ groups: [group(1, 0)] });
    await expect(
      service.submitToChiefAccountant(125, { id: 20, roles: [ExpenseRole.ACCOUNTANT] } as never),
    ).rejects.toThrow('chưa có khoản nào cần chi');
  });

  it('bảng Giáo viên trường còn dòng chưa chọn giáo viên thì không gửi được', async () => {
    const { service } = setup({
      groups: [group(1, 100)],
      unassigned: [{ rowCount: 2, amount: 3_000_000 }],
    });
    await expect(
      service.submitToChiefAccountant(125, { id: 20, roles: [ExpenseRole.ACCOUNTANT] } as never),
    ).rejects.toThrow('2 dòng chưa chọn giáo viên');
  });

  it('đề xuất chuyển từ luồng cũ giữ khoản kinh doanh đã chọn, lấy lại Còn chi', async () => {
    const existing = [
      {
        id: 3,
        schoolId: 445,
        expensePeriodId: 77,
        subjectId: 2,
        schoolTeacherId: null,
        schoolYear: '2099-2100',
        school,
        subject: { name: 'Môn 2' },
        expensePeriod: period,
      },
    ];
    const { service, manager } = setup({ groups: [group(1, 999), group(2, 400_000)], existing });
    await service.submitToChiefAccountant(125, { id: 20, roles: [ExpenseRole.ACCOUNTANT] } as never);
    expect((service as any).sheetGroups).not.toHaveBeenCalled();
    const items = manager.save.mock.calls.find(([entity]) => entity === SuggestMonthlyItem)![1];
    expect(items).toEqual([expect.objectContaining({ subjectId: 2, requestedAmount: 400_000 })]);
  });

  it('đề xuất không theo quy trình Kế toán thì từ chối', async () => {
    const { service } = setup({ groups: [] });
    (service as any).repo.findOne.mockResolvedValue({ ...chainSuggest, approvalFlow: null });
    await expect(
      service.submitToChiefAccountant(125, { id: 20, roles: [ExpenseRole.ACCOUNTANT] } as never),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('Giám đốc duyệt đề xuất quy trình Kế toán', () => {
  const rows = [
    { id: 1, requestedAmount: '300000.00', school, subject: { name: 'A' }, expensePeriod: period },
    { id: 2, requestedAmount: '200000.00', school, subject: { name: 'B' }, expensePeriod: period },
  ];
  const setup = () => {
    const manager = makeManager({});
    const service = makeService(manager);
    const s: any = { id: 125, code: 'DX-1', isMonthlyExpense: true, approvalFlow: ACCOUNTANT_CHAIN, cashflowSource: 'SCHOOL_EXPENSE', createdBy: 7 };
    const transition = jest.fn(async (opts) => {
      opts.mutate?.(s);
      await opts.extra?.(manager, s);
      return { ...s, status: SuggestStatus.APPROVED };
    });
    Object.assign(service as object, {
      repo: { findOne: jest.fn().mockResolvedValue(s) },
      loadMonthlyRows: jest.fn().mockResolvedValue(rows),
      expenseTransition: transition,
    });
    return { service, manager, s, transition };
  };

  it('duyệt hết: phần từng khoản = số Kế toán chốt, không lập lệnh chi, báo Kế toán công nợ', async () => {
    const { service, manager, s, transition } = setup();
    await service.approveExpense(125, { id: 1, roles: [ExpenseRole.DIRECTOR] } as never, {} as never);
    expect(transition.mock.calls[0][0].action).toBe(ExpenseAction.APPROVE_MONTHLY_CHAIN);
    expect(manager.update).toHaveBeenCalledWith(
      SuggestMonthlyItem,
      { id: 1 },
      { approvedAmount: 300_000, spent: null, excluded: false },
    );
    expect(s.amount).toBe(500_000);
    expect(manager.save).not.toHaveBeenCalledWith(SuggestPaymentOrder, expect.anything());
    expect(service.notifyExpense).toHaveBeenCalledWith(expect.anything(), {
      roles: [ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT],
      userIds: [7],
    });
  });

  it('bỏ một khoản phải ghi lý do; khoản bỏ không vào lệnh chi', async () => {
    const { service, manager, s } = setup();
    await expect(
      service.approveExpense(125, { id: 1, roles: [ExpenseRole.DIRECTOR] } as never, { approvedItemIds: [1] } as never),
    ).rejects.toThrow('Phải ghi lý do');
    await service.approveExpense(
      125,
      { id: 1, roles: [ExpenseRole.DIRECTOR] } as never,
      { approvedItemIds: [1], note: 'Môn B chưa đủ chứng từ' } as never,
    );
    expect(manager.update).toHaveBeenCalledWith(
      SuggestMonthlyItem,
      { id: 2 },
      { approvedAmount: null, spent: null, excluded: true },
    );
    expect(s.amount).toBe(300_000);
  });
});

describe('Kế toán công nợ lập lệnh chi cho đề xuất quy trình Kế toán', () => {
  const setup = (status = SuggestStatus.APPROVED) => {
    const manager = makeManager({});
    manager.find.mockResolvedValue([
      { id: 1, approvedAmount: '300000.00', excluded: false },
      { id: 2, approvedAmount: null, excluded: true },
    ]);
    const service = makeService(manager);
    const s: any = { id: 125, code: 'DX-1', isMonthlyExpense: true, approvalFlow: ACCOUNTANT_CHAIN, status };
    const transition = jest.fn(async (opts) => {
      opts.mutate?.(s);
      await opts.extra?.(manager, s);
      return { ...s, status: SuggestStatus.PAYMENT_ORDERED };
    });
    Object.assign(service as object, {
      repo: { findOne: jest.fn().mockResolvedValue(s) },
      expenseTransition: transition,
      clearMonthlyItemSplit: jest.fn(),
    });
    return { service, manager, s, transition };
  };

  it('số tiền lệnh chi = số Giám đốc duyệt, giữ phần từng khoản để ghi ngược', async () => {
    const { service, manager, transition } = setup();
    await service.createExpensePaymentOrder(
      125,
      { amount: 1, paymentMethod: 'CASH' } as never,
      { id: 22, roles: [ExpenseRole.DEBT_ACCOUNTANT] } as never,
    );
    expect(transition.mock.calls[0][0].action).toBe(ExpenseAction.CREATE_PAYMENT_ORDER);
    expect(manager.save).toHaveBeenCalledWith(
      SuggestPaymentOrder,
      expect.objectContaining({ amount: 300_000 }),
    );
    expect((service as any).clearMonthlyItemSplit).not.toHaveBeenCalled();
    expect(service.notifyExpense).toHaveBeenCalledWith(expect.anything(), {
      roles: [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT],
    });
  });

  it('đã chi (đã ghi về QL thu chi) thì không sửa lệnh chi', async () => {
    const { service } = setup(SuggestStatus.SPENT);
    await expect(
      service.editExpensePaymentOrder(
        125,
        { amount: 1, paymentMethod: 'CASH' } as never,
        { id: 22, roles: [ExpenseRole.DEBT_ACCOUNTANT] } as never,
      ),
    ).rejects.toThrow('không sửa lệnh chi được');
  });
});

describe('Chủ đơn sửa đề xuất chi tháng', () => {
  it('đề xuất cũ nhiều trường: sửa xong về một trường + kỳ, chờ Kế toán nhập lại', async () => {
    const legacy = {
      id: 5,
      type: SuggestType.EXPENSE_REQUEST,
      createdBy: 7,
      status: SuggestStatus.PENDING_APPROVAL,
      isMonthlyExpense: true,
      cashflowSource: null,
      approvalFlow: null,
      schoolId: 445,
      expensePeriodId: 77,
      content: 'Chi',
      expectedPaymentDate: '2099-09-15',
    };
    const manager = makeManager({
      findOne: (entity) =>
        entity === Suggest ? legacy : entity === School ? school : entity === ExpensePeriod ? period : null,
    });
    manager.save.mockImplementation(async (data: any) => data);
    const service = makeService(manager);
    Object.assign(service as object, { findOneExpense: jest.fn().mockResolvedValue({ id: 5 }) });
    await service.updateExpense(5, { content: 'Chi tháng 9' } as never, undefined, sales);
    const saved = manager.save.mock.calls[0][0];
    expect(saved).toEqual(
      expect.objectContaining({
        status: SuggestStatus.PENDING_ACCOUNTANT,
        approvalFlow: ACCOUNTANT_CHAIN,
        cashflowSource: 'MANAGEMENT',
        schoolId: 445,
        expensePeriodId: 77,
        amount: null,
      }),
    );
    expect(manager.delete).toHaveBeenCalledWith(SuggestPaymentOrder, { suggestId: 5 });
    expect(manager.delete).toHaveBeenCalledWith(SuggestMonthlyItem, { suggestId: 5 });
    expect(service.notifyExpense).toHaveBeenCalledWith(expect.anything(), {
      roles: [ExpenseRole.ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT],
    });
  });
});

describe('Năm học của kỳ tháng', () => {
  it.each([
    [{ month: 8, year: 2026 }, '2026-2027'],
    [{ month: 7, year: 2027 }, '2026-2027'],
    [{ month: 13, year: 2026 }, null],
  ])('%j → %s', (input, expected) => {
    expect(schoolYearOfPeriod(input)).toBe(expected);
  });
});
