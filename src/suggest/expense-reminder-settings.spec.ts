import { NotFoundException } from '@nestjs/common';
import { SuggestService } from './suggest.service';
import {
  EXPENSE_REMINDERS_ENABLED_KEY,
  REMIND_BEFORE_DAYS_KEY,
} from './entities/suggest-reminder-setting.entity';
import { SuggestType } from './enums/suggest-type.enum';
import { SuggestStatus } from './SuggestStatus.enum';

describe('Expense reminder settings', () => {
  function serviceWith(settingRepo: any, repo: any = {}) {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    (service as any).settingRepo = settingRepo;
    (service as any).repo = repo;
    return service;
  }

  it('mặc định bật cảnh báo để giữ tương thích cấu hình cũ', async () => {
    const service = serviceWith({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.getExpenseRemindersEnabled()).resolves.toBe(true);
  });

  it('lưu công tắc và số ngày nhắc trong cùng endpoint', async () => {
    const values: Record<string, string> = {};
    const settingRepo = {
      upsert: jest.fn(async (rows: Array<{ key: string; value: string }>) => {
        for (const row of rows) values[row.key] = row.value;
      }),
      findOne: jest.fn(async ({ where }: any) =>
        values[where.key] ? { key: where.key, value: values[where.key] } : null,
      ),
    };
    const service = serviceWith(settingRepo);

    await expect(
      service.updateExpenseReminderSettings({
        enabled: false,
        remindBeforeDays: 3,
      }),
    ).resolves.toEqual({ enabled: false, remindBeforeDays: 3 });
    expect(values[EXPENSE_REMINDERS_ENABLED_KEY]).toBe('false');
    expect(values[REMIND_BEFORE_DAYS_KEY]).toBe('3');
  });

  it('không truy vấn đề xuất hoặc phát cảnh báo khi đã tắt', async () => {
    const repo = { find: jest.fn() };
    const service = serviceWith(
      {
        findOne: jest
          .fn()
          .mockResolvedValue({
            key: EXPENSE_REMINDERS_ENABLED_KEY,
            value: 'false',
          }),
      },
      repo,
    );

    await expect(service.runExpenseReminders()).resolves.toEqual({
      enabled: false,
      upcoming: 0,
      dueToday: 0,
      overdue: 0,
    });
    expect(repo.find).not.toHaveBeenCalled();
  });
});

describe('Tắt nhắc quá hạn theo từng đề xuất', () => {
  const overdueRequest = (overrides: Record<string, any> = {}) => ({
    id: 1,
    code: 'DX-202608-0021',
    type: SuggestType.EXPENSE_REQUEST,
    status: SuggestStatus.PENDING_APPROVAL,
    expectedPaymentDate: '2020-01-01', // luôn nằm trong quá khứ
    isOverdue: false,
    overdueAlertMuted: false,
    createdBy: 7,
    ...overrides,
  });

  function serviceWith(repo: any) {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    (service as any).repo = repo;
    (service as any).settingRepo = {
      findOne: jest.fn().mockResolvedValue(null), // mặc định bật, dùng ngày nhắc mặc định
    };
    (service as any).notifyExpense = jest.fn().mockResolvedValue(undefined);
    return service;
  }

  it('không gửi thông báo cho đề xuất đã tắt nhắc quá hạn', async () => {
    const repo = {
      find: jest.fn().mockResolvedValue([overdueRequest({ overdueAlertMuted: true })]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const service = serviceWith(repo);

    const result = await service.runExpenseReminders();

    expect(result.overdue).toBe(0);
    expect((service as any).notifyExpense).not.toHaveBeenCalled();
    // Vẫn đánh dấu isOverdue để các màn khác hiển thị đúng trạng thái.
    expect(repo.update).toHaveBeenCalledWith(1, { isOverdue: true });
  });

  it('vẫn gửi thông báo bình thường khi chưa tắt', async () => {
    const repo = {
      find: jest.fn().mockResolvedValue([overdueRequest()]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const service = serviceWith(repo);

    const result = await service.runExpenseReminders();

    expect(result.overdue).toBe(1);
    expect((service as any).notifyExpense).toHaveBeenCalledTimes(1);
  });

  it('setOverdueAlertMuted lưu đúng cờ cho đề xuất chi', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(overdueRequest()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    (service as any).repo = repo;

    await expect(service.setOverdueAlertMuted(1, true)).resolves.toEqual({
      id: 1,
      overdueAlertMuted: true,
    });
    expect(repo.update).toHaveBeenCalledWith(1, { overdueAlertMuted: true });
  });

  it('setOverdueAlertMuted báo lỗi khi không tìm thấy đề xuất chi', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    (service as any).repo = repo;

    await expect(service.setOverdueAlertMuted(999, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });
});
