import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ManagementExpenseItemsService } from '../management-expense-item/management-expense-items.service';
import { SchoolExpenseManagementConfirmation } from './entities/school-expense-management-confirmation.entity';
import { SchoolExpenseHistory } from './entities/school-expense-history.entity';
import { RealExpensesService } from './real-expenses.service';

/**
 * "Xác nhận đúng BBCS" bảng Chi Ngoài theo TỪNG MÔN: xác nhận môn 3 không
 * khoá môn 4 cùng trường cùng kỳ (lỗi cũ: cờ nằm ở cả bảng thu chi).
 */

type Row = { schoolExpenseId: number; subjectId: number; confirmedBy: number | null; confirmedByName: string | null; confirmedAt: Date };

const matches = (row: Row, where: Partial<Row>) =>
  Object.entries(where).every(([k, v]) => (row as any)[k] === v);

function fakeStore(initial: Row[] = []) {
  const rows = [...initial];
  const confirmations = {
    exists: jest.fn(async ({ where }) => rows.some((r) => matches(r, where))),
    findOne: jest.fn(async ({ where, order }) => {
      const found = rows.filter((r) => matches(r, where));
      if (order?.confirmedAt) found.sort((a, b) => a.confirmedAt.getTime() - b.confirmedAt.getTime());
      return found[0] ?? null;
    }),
    find: jest.fn(async ({ where }) =>
      rows.filter((r) => (where.schoolExpenseId.value ?? [where.schoolExpenseId]).includes(r.schoolExpenseId)),
    ),
    insert: jest.fn(async (row: Row) => {
      rows.push(row);
    }),
    delete: jest.fn(async (where: Partial<Row>) => {
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
    }),
  };
  const saved: { entity: unknown; data: any }[] = [];
  const manager = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity !== SchoolExpenseManagementConfirmation) throw new Error('unexpected repo');
      return confirmations;
    }),
    save: jest.fn(async (entity: unknown, data: any) => {
      saved.push({ entity, data: { ...data } });
      return data;
    }),
  };
  const dataSource = {
    manager,
    transaction: jest.fn(async (fn: (m: typeof manager) => unknown) => fn(manager)),
  };
  return { rows, saved, manager, dataSource, confirmations };
}

const sheet = () => ({ id: 9, school: { id: 5 }, finalized: false, managementExpenseConfirmed: false } as any);
const subjects: Record<number, { id: number; schoolId: number }> = {
  3: { id: 3, schoolId: 5 },
  4: { id: 4, schoolId: 5 },
  8: { id: 8, schoolId: 6 },
};
const salesAdmin = { id: 1, name: 'SA', roles: ['sales_admin'] } as any;
const chief = { id: 2, name: 'KTT', roles: ['ketoan_truong'] } as any;

function realService(store: ReturnType<typeof fakeStore>, data = sheet()) {
  const repo = (value: any) => ({ findOne: jest.fn().mockResolvedValue(value), find: jest.fn() });
  const subjectRepo = { findOne: jest.fn(async ({ where }) => subjects[where.id] ?? null) };
  const service = new RealExpensesService(
    repo(data) as any,
    repo(null) as any,
    repo(null) as any,
    repo(null) as any,
    repo(null) as any,
    repo(null) as any,
    subjectRepo as any,
    repo(null) as any,
    store.dataSource as any,
  );
  return { service, data };
}

describe('Xác nhận đúng BBCS theo môn', () => {
  it('xác nhận môn 3 chỉ ghi môn 3; cờ cũ của bảng = còn môn xác nhận; lịch sử ghi môn', async () => {
    const store = fakeStore();
    const { service, data } = realService(store);
    const result = await service.confirmManagementExpense(9, 3, salesAdmin);

    expect(store.rows.map((r) => [r.schoolExpenseId, r.subjectId, r.confirmedByName])).toEqual([[9, 3, 'SA']]);
    expect(result.managementConfirmations.map((c) => c.subjectId)).toEqual([3]);
    expect(data.managementExpenseConfirmed).toBe(true);
    const history = store.saved.find((s) => s.entity === SchoolExpenseHistory)?.data;
    expect(history).toMatchObject({
      action: 'CONFIRM_MANAGEMENT_EXPENSE',
      oldData: { subjectId: 3 },
      newData: { subjectId: 3, managementExpenseConfirmed: true },
    });
  });

  it('xác nhận lại môn đã xác nhận: không ghi thêm, không lỗi', async () => {
    const store = fakeStore([{ schoolExpenseId: 9, subjectId: 3, confirmedBy: 1, confirmedByName: 'SA', confirmedAt: new Date() }]);
    const { service } = realService(store);
    await service.confirmManagementExpense(9, 3, salesAdmin);
    expect(store.confirmations.insert).not.toHaveBeenCalled();
    expect(store.saved).toEqual([]);
  });

  it.each([
    [NaN, 'Chọn môn cần xác nhận BBCS'],
    [0, 'Chọn môn cần xác nhận BBCS'],
    [8, 'Môn không thuộc trường của bảng thu chi'],
    [999, 'Môn không thuộc trường của bảng thu chi'],
  ])('môn %p → 400, không ghi', async (subjectId, message) => {
    const store = fakeStore();
    const { service } = realService(store);
    await expect(service.confirmManagementExpense(9, subjectId, salesAdmin)).rejects.toThrow(
      new BadRequestException(message),
    );
    expect(store.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('mở khoá môn 3 giữ môn 4; cờ cũ vẫn bật vì môn 4 còn xác nhận', async () => {
    const store = fakeStore([
      { schoolExpenseId: 9, subjectId: 3, confirmedBy: 1, confirmedByName: 'SA', confirmedAt: new Date('2026-11-01') },
      { schoolExpenseId: 9, subjectId: 4, confirmedBy: 1, confirmedByName: 'SA2', confirmedAt: new Date('2026-11-02') },
    ]);
    const { service, data } = realService(store, { ...sheet(), managementExpenseConfirmed: true });
    const result = await service.unconfirmManagementExpense(9, 3, chief);

    expect(store.rows.map((r) => r.subjectId)).toEqual([4]);
    expect(result.managementConfirmations.map((c) => c.subjectId)).toEqual([4]);
    expect(data.managementExpenseConfirmed).toBe(true);
    expect(data.managementExpenseConfirmedByName).toBe('SA2');
    expect(store.saved.find((s) => s.entity === SchoolExpenseHistory)?.data).toMatchObject({
      action: 'UNCONFIRM_MANAGEMENT_EXPENSE',
      oldData: { subjectId: 3, managementExpenseConfirmedByName: 'SA' },
    });
  });

  it('mở khoá môn cuối cùng → cờ cũ của bảng tắt', async () => {
    const store = fakeStore([{ schoolExpenseId: 9, subjectId: 3, confirmedBy: 1, confirmedByName: 'SA', confirmedAt: new Date() }]);
    const { service, data } = realService(store, { ...sheet(), managementExpenseConfirmed: true });
    await service.unconfirmManagementExpense(9, 3, chief);
    expect(store.rows).toEqual([]);
    expect(data).toMatchObject({ managementExpenseConfirmed: false, managementExpenseConfirmedByName: null });
  });

  it('mở khoá môn chưa xác nhận: không đổi gì', async () => {
    const store = fakeStore([{ schoolExpenseId: 9, subjectId: 4, confirmedBy: 1, confirmedByName: 'SA', confirmedAt: new Date() }]);
    const { service } = realService(store, { ...sheet(), managementExpenseConfirmed: true });
    await service.unconfirmManagementExpense(9, 3, chief);
    expect(store.rows.map((r) => r.subjectId)).toEqual([4]);
    expect(store.saved).toEqual([]);
  });
});

describe('API từng dòng Chi Ngoài — khoá theo môn', () => {
  function itemsService(store: ReturnType<typeof fakeStore>, subjectId: number) {
    const repo = (value: any) => ({ find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(value) });
    const service = new ManagementExpenseItemsService(
      repo(null) as any,
      repo(sheet()) as any,
      repo(subjects[subjectId]) as any,
      repo(null) as any,
      store.dataSource as any,
    );
    return service;
  }
  const confirmed3 = () =>
    fakeStore([{ schoolExpenseId: 9, subjectId: 3, confirmedBy: 1, confirmedByName: 'SA', confirmedAt: new Date() }]);

  it('môn 3 đã xác nhận → sales admin thêm dòng môn 3 bị chặn', async () => {
    const store = confirmed3();
    await expect(
      itemsService(store, 3).create({ schoolExpenseId: 9, subjectId: 3 }, salesAdmin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('môn 3 đã xác nhận → môn 4 vẫn qua bước khoá (sales admin thêm được)', async () => {
    const store = confirmed3();
    const service = itemsService(store, 4);
    // Qua bước khoá thì tới bước ghi; mock dừng ở đó để chỉ kiểm khoá.
    store.dataSource.transaction.mockRejectedValue(new Error('tới bước ghi'));
    const error = await service.create({ schoolExpenseId: 9, subjectId: 4 }, salesAdmin).catch((e) => e);
    expect(error).not.toBeInstanceOf(ForbiddenException);
    expect(error.message).toBe('tới bước ghi');
    expect(store.confirmations.exists).toHaveBeenCalledWith({ where: { schoolExpenseId: 9, subjectId: 4 } });
  });
});
