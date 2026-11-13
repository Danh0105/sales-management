import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  cashflowItemKey,
  cashflowItemStatus,
  cashflowSourceOf,
  managementGroupsFromSections,
  recordSchoolExpenseSuggestPayments,
  recordSchoolTeacherSuggestPayments,
} from './cashflow-sources';
import { ExpenseRole } from './constants/expense-roles';
import { MonthlyExpenseItemDto } from './dto/expense/create-expense-request.dto';
import { SuggestService } from './suggest.service';

/**
 * Đề xuất chi lấy khoản chưa chi từ QL thu chi: Chi Ngoài (đề xuất chi tháng
 * cũ), Chi Trường, Chi GV trường. SQL thật kiểm ở test tích hợp trên DB tạm.
 */

const sales = { id: 7, roles: [ExpenseRole.SALES] };

describe('bảng nguồn của đề xuất', () => {
  it('chi Năm không có bảng nguồn; chi tháng cũ (trống) là Chi Ngoài', () => {
    expect(
      cashflowSourceOf({
        isMonthlyExpense: false,
        cashflowSource: 'SCHOOL_EXPENSE',
      }),
    ).toBeNull();
    expect(
      cashflowSourceOf({ isMonthlyExpense: true, cashflowSource: null }),
    ).toBe('MANAGEMENT');
    expect(
      cashflowSourceOf({
        isMonthlyExpense: true,
        cashflowSource: 'SCHOOL_TEACHER',
      }),
    ).toBe('SCHOOL_TEACHER');
  });

  it('khoá khoản: môn cho Chi Ngoài / Chi Trường, giáo viên cho GV trường', () => {
    const ref = {
      schoolId: 5,
      expensePeriodId: 3,
      subjectId: 8,
      schoolTeacherId: 2,
    };
    expect(cashflowItemKey('SCHOOL_EXPENSE', ref)).toBe('5:3:s8');
    expect(cashflowItemKey('MANAGEMENT', ref)).toBe('5:3:s8');
    expect(cashflowItemKey('SCHOOL_TEACHER', ref)).toBe('5:3:t2');
  });

  it('trạng thái: đề xuất đang giữ trước, rồi theo số tiền', () => {
    const unpaid = { paidAmount: 0, remainingAmount: 100 };
    expect(cashflowItemStatus(unpaid, { status: 'PENDING_APPROVAL' })).toBe(
      'PROPOSED',
    );
    expect(cashflowItemStatus(unpaid, { status: 'CASH_RELEASED' })).toBe(
      'APPROVED_WAITING',
    );
    expect(cashflowItemStatus(unpaid, { status: 'FUND_RETURNED' })).toBe(
      'APPROVED_WAITING',
    );
    expect(cashflowItemStatus(unpaid)).toBe('UNPAID');
    expect(cashflowItemStatus({ paidAmount: 40, remainingAmount: 60 })).toBe(
      'PARTIAL',
    );
    expect(cashflowItemStatus({ paidAmount: 100, remainingAmount: 0 })).toBe(
      'PAID',
    );
  });

  it('Chi Ngoài: gộp các bảng cùng trường + kỳ + môn, Còn lại = tổng Còn chi (như lệnh chi)', () => {
    const section = (id: number, totals: Record<string, number>) =>
      ({
        schoolExpenseId: id,
        schoolId: 5,
        schoolName: 'TH A',
        periodId: 3,
        periodName: 'Tháng 9/2026',
        subjectId: 8,
        subjectName: 'Tin học',
        schoolYear: '2026-2027',
        confirmed: false,
        finalized: false,
        otherCostColumns: [],
        rows: [{}, {}],
        totals,
      }) as never;
    const [group, ...rest] = managementGroupsFromSections(
      [
        section(40, { totalOutside: 300, paidAmount: 50, remaining: 250 }),
        section(41, { totalOutside: 100, paidAmount: 120, remaining: -20 }),
        {
          ...(section(42, {
            totalOutside: 0,
            paidAmount: 0,
            remaining: 0,
          }) as object),
          subjectId: 9,
        } as never,
      ],
      new Map([[3, { month: 9, year: 2026, name: null }]]),
    );
    expect(rest).toHaveLength(0);
    expect(group).toMatchObject({
      key: '5:3:s8',
      schoolExpenseIds: [40, 41],
      totalAmount: 400,
      paidAmount: 170,
      remainingAmount: 230,
      periodMonth: 9,
    });
  });

  it('DTO: Chi GV trường bỏ trống môn được khi có giáo viên, còn lại bắt buộc môn', async () => {
    const errors = async (value: object) =>
      (await validate(plainToInstance(MonthlyExpenseItemDto, value))).map(
        (e) => e.property,
      );
    expect(await errors({ schoolId: 1, expensePeriodId: 2 })).toContain(
      'subjectId',
    );
    expect(
      await errors({ schoolId: 1, expensePeriodId: 2, schoolTeacherId: 3 }),
    ).toEqual([]);
    expect(
      await errors({ schoolId: 1, expensePeriodId: 2, subjectId: 4 }),
    ).toEqual([]);
  });
});

/** Manager giả: trả dòng theo từ khoá trong SQL, ghi lại mọi câu lệnh. */
function fakeManager(answers: [RegExp, unknown[]][]) {
  const sql: { text: string; params: unknown[] }[] = [];
  return {
    sql,
    query: jest.fn(async (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      return answers.find(([pattern]) => pattern.test(text))?.[1] ?? [];
    }),
  };
}

const paidRow = (overrides: Record<string, unknown> = {}) => ({
  monthlyItemId: 11,
  schoolId: 5,
  expensePeriodId: 3,
  subjectId: 8,
  schoolTeacherId: null,
  approvedAmount: 250_000,
  label: 'TH A · Tin học · Tháng 9/2026',
  ...overrides,
});

describe('ghi ngược Chi Trường khi đã chi', () => {
  it('chia theo dòng của môn, mỗi dòng tối đa phần chưa chi, ghi liên kết theo ID dòng', async () => {
    const manager = fakeManager([
      [/FROM school_expenses/, [{ id: 40, school_id: 5, period_id: 3 }]],
      [
        /FROM school_expense_items/,
        [
          {
            id: 71,
            school_expense_id: 40,
            row_index: 0,
            amount: '100000',
            paid: '0',
          },
          {
            id: 72,
            school_expense_id: 40,
            row_index: 1,
            amount: '200000',
            paid: '50000',
          },
        ],
      ],
    ]);
    const log = await recordSchoolExpenseSuggestPayments(
      manager as never,
      5,
      [paidRow()],
      '2026-11-13',
      '1121',
    );
    const updates = manager.sql.filter((q) =>
      q.text.includes('UPDATE school_expense_items'),
    );
    const inserts = manager.sql.filter((q) =>
      q.text.includes('INSERT INTO school_expense_suggest_payments'),
    );
    expect(updates.map((q) => q.params)).toEqual([
      [71, 100_000],
      [72, 150_000],
    ]);
    expect(inserts.map((q) => q.params)).toEqual([
      [71, 5, 11, 100_000, '2026-11-13', '1121'],
      [72, 5, 11, 150_000, '2026-11-13', '1121'],
    ]);
    expect(log).toMatchObject({
      source: 'SCHOOL_EXPENSE',
      items: [{ amount: 250_000, unallocated: 0 }],
    });
    // Khoá bảng thu chi trước khi ghi.
    expect(manager.sql[0].text).toContain('FOR UPDATE');
  });

  it('lệnh chi do Kế toán lập (không có phần từng khoản) thì không tự ghi', async () => {
    const manager = fakeManager([]);
    const log = await recordSchoolExpenseSuggestPayments(
      manager as never,
      5,
      [paidRow({ approvedAmount: null })],
      '2026-11-13',
      '1121',
    );
    expect(log).toMatchObject({
      skipped: expect.stringContaining('Chi Trường'),
    });
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe('ghi ngược Giáo viên trường khi đã chi', () => {
  it('trả trọn dòng khi còn đủ tiền, dòng không đủ giữ chưa trả, phần dư ghi lịch sử', async () => {
    const manager = fakeManager([
      [/FROM school_expenses/, [{ id: 40, school_id: 5, period_id: 3 }]],
      [
        /FROM school_teacher_expense_items/,
        [
          {
            id: 81,
            school_expense_id: 40,
            subject_id: 8,
            row_index: 0,
            net: '900000',
          },
          {
            id: 82,
            school_expense_id: 40,
            subject_id: 9,
            row_index: 0,
            net: '600000',
          },
          {
            id: 83,
            school_expense_id: 40,
            subject_id: 9,
            row_index: 1,
            net: '300000',
          },
        ],
      ],
    ]);
    const log = await recordSchoolTeacherSuggestPayments(
      manager as never,
      5,
      [
        paidRow({
          subjectId: null,
          schoolTeacherId: 2,
          approvedAmount: 1_250_000,
        }),
      ],
      '2026-11-13',
      '1111',
    );
    const updates = manager.sql.filter((q) =>
      q.text.includes('UPDATE school_teacher_expense_items'),
    );
    expect(updates.map((q) => q.params)).toEqual([
      [81, '2026-11-13', '1111'],
      [83, '2026-11-13', '1111'],
    ]);
    const inserts = manager.sql.filter((q) =>
      q.text.includes('INSERT INTO school_teacher_suggest_payments'),
    );
    expect(inserts.map((q) => q.params[3])).toEqual([900_000, 300_000]);
    expect(log).toMatchObject({
      items: [{ amount: 1_250_000, unallocated: 50_000 }],
    });
  });
});

describe('tạo đề xuất từ QL thu chi: phạm vi, chống trùng, chỉ khoản còn phải chi', () => {
  const school = { id: 5, name: 'TH A' };
  const item = {
    school,
    schoolYear: '2026-2027',
    subject: { id: 8, name: 'Tin học' },
    schoolTeacher: null,
    expensePeriod: { id: 3, month: 9, year: 2026 },
  };

  function setup(answers: [RegExp, unknown[]][], remaining = 250_000) {
    const manager = fakeManager(answers);
    const service = Object.create(SuggestService.prototype) as SuggestService;
    Object.assign(service as object, {
      cashflowGroupsFor: jest.fn(
        async () => new Map([['5:3:s8', { remainingAmount: remaining }]]),
      ),
    });
    const prepare = (
      source = 'SCHOOL_EXPENSE',
      exclude: number | null = null,
    ) =>
      (service as any).prepareCashflowItems(
        manager,
        source,
        [item],
        sales,
        exclude,
      );
    return { manager, prepare };
  }

  it('Chi Trường của trường không phụ trách: chặn', async () => {
    const { prepare } = setup([[/FROM schools/, [{ id: 99 }]]]);
    await expect(prepare()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('khoản đang nằm trong đề xuất khác chưa xong: chặn, báo mã đề xuất', async () => {
    const { prepare, manager } = setup([
      [/FROM schools/, [{ id: 5 }]],
      [
        /FROM suggest_monthly_items/,
        [
          {
            suggest_id: 31,
            code: 'DX-202611-0031',
            status: 'PAYMENT_ORDERED',
            school_id: 5,
            expense_period_id: 3,
            subject_id: 8,
            school_teacher_id: null,
          },
        ],
      ],
    ]);
    await expect(prepare()).rejects.toThrow('DX-202611-0031');
    // Khoá theo khoản trước khi tra để hai người không cùng đề xuất.
    expect(
      manager.sql.some((q) => q.text.includes('pg_advisory_xact_lock')),
    ).toBe(true);
    // Đề xuất đã xong / bị từ chối / rút không giữ khoản.
    const open = manager.sql.find((q) =>
      q.text.includes('FROM suggest_monthly_items'),
    )!;
    expect(open.params[1]).toEqual(['SPENT', 'REJECTED', 'WITHDRAWN']);
  });

  it('khoản đã chi đủ: chặn', async () => {
    const { prepare } = setup([[/FROM schools/, [{ id: 5 }]]], 0);
    await expect(prepare()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('hợp lệ: trả Còn phải chi để lưu cùng khoản; sửa đề xuất thì bỏ qua chính nó', async () => {
    const { prepare, manager } = setup([[/FROM schools/, [{ id: 5 }]]]);
    await expect(prepare('SCHOOL_EXPENSE', 77)).resolves.toEqual([250_000]);
    const open = manager.sql.find((q) =>
      q.text.includes('FROM suggest_monthly_items'),
    )!;
    expect(open.params[3]).toBe(77);
  });

  it('Chi Ngoài giữ như cũ: không kiểm phạm vi trường', async () => {
    const { prepare, manager } = setup([]);
    await expect(prepare('MANAGEMENT')).resolves.toEqual([250_000]);
    expect(manager.sql.some((q) => q.text.includes('FROM schools'))).toBe(
      false,
    );
  });
});

describe('Sales Admin không thấy lương từng giáo viên trường', () => {
  function setup(actor: { id: number; roles: string[] }) {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    const suggest = {
      id: 5,
      createdBy: 7,
      isMonthlyExpense: true,
      cashflowSource: 'SCHOOL_TEACHER',
      monthlyItems: [
        { id: 11, approvedAmount: 900_000, requestedAmount: 900_000 },
      ],
    };
    Object.assign(service as object, {
      repo: { findOne: jest.fn().mockResolvedValue(suggest) },
      historyRepo: {
        find: jest
          .fn()
          .mockResolvedValue([
            { userId: null, data: { items: [{ amount: 900_000 }], note: 'x' } },
          ]),
      },
      employeeRepo: { findBy: jest.fn().mockResolvedValue([]) },
    });
    return service.findOneExpense(5, actor as never);
  }

  it('Sales Admin: ẩn số tiền từng giáo viên ở khoản và lịch sử', async () => {
    const result: any = await setup({ id: 9, roles: ['saleadmin'] });
    expect(result.monthlyItems[0]).toMatchObject({
      approvedAmount: null,
      requestedAmount: null,
    });
    expect(result.logs[0].data).toEqual({ note: 'x' });
  });

  it('chủ đề xuất và Kế toán vẫn thấy', async () => {
    const owner: any = await setup({ id: 7, roles: ['sales'] });
    expect(owner.monthlyItems[0].approvedAmount).toBe(900_000);
    const accountant: any = await setup({ id: 9, roles: ['ketoan_congno'] });
    expect(accountant.logs[0].data.items).toHaveLength(1);
  });
});
