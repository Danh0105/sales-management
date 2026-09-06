import { SuggestService } from './suggest.service';

describe('SuggestService.handleExpenseReminders — chỉ chạy ở process production', () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  function serviceWith() {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    (service as any).runExpenseReminders = jest
      .fn()
      .mockResolvedValue({ enabled: true, upcoming: 0, dueToday: 0, overdue: 0 });
    (service as any).logger = { log: jest.fn(), error: jest.fn() };
    return service;
  }

  it('KHÔNG chạy khi NODE_ENV != production (dev sales-be dùng chung DB với prod)', async () => {
    process.env.NODE_ENV = 'development';
    const service = serviceWith();

    await service.handleExpenseReminders();

    expect((service as any).runExpenseReminders).not.toHaveBeenCalled();
  });

  it('chạy bình thường khi NODE_ENV = production', async () => {
    process.env.NODE_ENV = 'production';
    const service = serviceWith();

    await service.handleExpenseReminders();

    expect((service as any).runExpenseReminders).toHaveBeenCalledTimes(1);
  });
});
