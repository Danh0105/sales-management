import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateExpenseRequestDto } from './dto/expense/create-expense-request.dto';
import { ConfirmCashReleasedDto } from './dto/expense/confirm-cash-released.dto';
import { CreateSuggestDto } from './dto/create-suggest.dto';
import { SuggestService } from './suggest.service';
import { ExpenseRole } from './constants/expense-roles';
import { SuggestType } from './enums/suggest-type.enum';
import { SuggestStatus } from './SuggestStatus.enum';
import { currentSchoolYear } from './utils/vn-date';

describe('Expense request school mapping', () => {
  const validBody = {
    content: 'Mua thiết bị KNS',
    expectedPaymentDate: '2099-09-15',
    schoolId: '445',
    schoolYear: '2099-2100',
  };

  describe('multipart DTO', () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const metadata = {
      type: 'body' as const,
      metatype: CreateExpenseRequestDto,
      data: '',
    };

    it('không yêu cầu amount và giữ đúng schoolYear', async () => {
      const result = await pipe.transform(validBody, metadata);

      expect(result.amount).toBeUndefined();
      expect(result.schoolId).toBe(445);
      expect(result.schoolYear).toBe('2099-2100');
    });

    it('endpoint /suggest tương thích cũ cũng nhận tiền định dạng Việt Nam', async () => {
      const legacyMetadata = {
        type: 'body' as const,
        metatype: CreateSuggestDto,
        data: '',
      };

      const result = await pipe.transform(
        {
          content: 'Mua thiết bị KNS',
          amount: '15.000.000',
          type: SuggestType.EXPENSE_REQUEST,
          expectedPaymentDate: '2099-09-15',
          schoolId: '445',
          schoolYear: '2099-2100',
        },
        legacyMetadata,
      );

      expect(result.amount).toBe(15000000);
    });

    it('schoolId và schoolYear là optional ở tầng DTO', async () => {
      const result = await pipe.transform(
        {
          content: 'Hoạt động cấp phường',
          expectedPaymentDate: '2099-09-15',
          wardId: '12',
        },
        metadata,
      );

      expect(result.schoolId).toBeUndefined();
      expect(result.schoolYear).toBeUndefined();
      expect(result.wardId).toBe(12);
    });
  });

  describe('business validation and persistence', () => {
    function makeService(manager: Record<string, jest.Mock>) {
      const service = Object.create(SuggestService.prototype) as SuggestService;
      (service as any).dataSource = {
        transaction: jest.fn((callback) => callback(manager)),
      };
      return service;
    }

    const user = {
      id: 7,
      roles: [ExpenseRole.SALES, ExpenseRole.TREASURER],
    } as any;

    it('có schoolId thì tự điền năm học hiện tại khi chưa truyền schoolYear', async () => {
      const school = { id: 445, name: 'TH ABC' };
      let createdSuggest: any;
      const manager = {
        findOne: jest.fn().mockResolvedValue(school),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn((_entity, data) => {
          createdSuggest = data;
          return data;
        }),
        save: jest
          .fn()
          .mockImplementation(async (data) => ({ ...data, id: 123 })),
      };
      const service = makeService(manager);
      (service as any).generateCode = jest
        .fn()
        .mockResolvedValue('DX-209909-0001');
      (service as any).writeExpenseLog = jest.fn();
      (service as any).notifyExpense = jest.fn();
      (service as any).findOneExpense = jest
        .fn()
        .mockResolvedValue({ id: 123 });

      await service.create(
        {
          content: 'Mua thiết bị',
          expectedPaymentDate: '2099-09-15',
          schoolId: 445,
          type: SuggestType.EXPENSE_REQUEST,
        },
        undefined,
        user,
      );

      expect(createdSuggest).toEqual(
        expect.objectContaining({
          schoolId: 445,
          schoolYear: currentSchoolYear(),
        }),
      );
      expect(manager.count).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          where: { schoolId: 445, schoolYear: currentSchoolYear() },
        }),
      );
    });

    it('không có schoolId thì bắt buộc wardId', async () => {
      const service = makeService({});

      await expect(
        service.create(
          {
            content: 'Hoạt động địa phương',
            expectedPaymentDate: '2099-09-15',
            type: SuggestType.EXPENSE_REQUEST,
          },
          undefined,
          user,
        ),
      ).rejects.toThrow('Thiếu xã/phường');
    });

    it('không có schoolId thì lưu wardId và không ép schoolId/schoolYear thành null', async () => {
      const ward = { id: 12, name: 'Phường Tân Lập' };
      let createdSuggest: any;
      const manager = {
        findOne: jest.fn().mockResolvedValue(ward),
        create: jest.fn((_entity, data) => {
          createdSuggest = data;
          return data;
        }),
        save: jest
          .fn()
          .mockImplementation(async (data) => ({ ...data, id: 123 })),
      };
      const service = makeService(manager);
      (service as any).generateCode = jest
        .fn()
        .mockResolvedValue('DX-209909-0001');
      (service as any).writeExpenseLog = jest.fn();
      (service as any).notifyExpense = jest.fn();
      (service as any).findOneExpense = jest
        .fn()
        .mockResolvedValue({ id: 123 });

      await service.create(
        {
          content: 'Hoạt động địa phương',
          expectedPaymentDate: '2099-09-15',
          wardId: 12,
          type: SuggestType.EXPENSE_REQUEST,
        },
        undefined,
        user,
      );

      expect(createdSuggest).toEqual(
        expect.objectContaining({ wardId: 12, ward }),
      );
      expect(createdSuggest).not.toHaveProperty('schoolId');
      expect(createdSuggest).not.toHaveProperty('schoolYear');
    });

    it('giáo viên công ty tạo đề nghị nội bộ không cần trường hoặc xã/phường', async () => {
      let createdSuggest: any;
      const manager = {
        create: jest.fn((_entity, data) => {
          createdSuggest = data;
          return data;
        }),
        save: jest.fn().mockImplementation(async (data) => ({ ...data, id: 125 })),
      };
      const service = makeService(manager);
      (service as any).generateCode = jest.fn().mockResolvedValue('DX-209909-0002');
      (service as any).writeExpenseLog = jest.fn();
      (service as any).notifyExpense = jest.fn();
      (service as any).findOneExpense = jest.fn().mockResolvedValue({ id: 125 });

      await expect(
        service.create(
          {
            content: 'Đề nghị hỗ trợ tài chính',
            expectedPaymentDate: '2099-09-15',
            type: SuggestType.EXPENSE_REQUEST,
          },
          undefined,
          { id: 19, roles: [ExpenseRole.STAFF_TEACHER] } as any,
        ),
      ).resolves.toEqual({ id: 125 });

      expect(createdSuggest).toEqual(
        expect.objectContaining({ createdBy: 19 }),
      );
      expect(createdSuggest).not.toHaveProperty('schoolId');
      expect(createdSuggest).not.toHaveProperty('wardId');
    });

    it('giáo viên công ty không giả lập đề xuất theo địa bàn', async () => {
      const service = makeService({});

      await expect(
        service.create(
          {
            content: 'Đề nghị sai phạm vi',
            expectedPaymentDate: '2099-09-15',
            wardId: 12,
            type: SuggestType.EXPENSE_REQUEST,
          },
          undefined,
          { id: 19, roles: [ExpenseRole.STAFF_TEACHER] } as any,
        ),
      ).rejects.toThrow('chỉ tạo đề nghị tài chính nội bộ');
    });

    it('từ chối năm kết thúc không liền sau năm bắt đầu', async () => {
      const manager = {
        findOne: jest.fn().mockResolvedValue({ id: 445, name: 'TH ABC' }),
        count: jest.fn(),
      };
      const service = makeService(manager);

      await expect(
        service.create(
          {
            ...validBody,
            schoolId: 445,
            schoolYear: '2099-2101',
            type: SuggestType.EXPENSE_REQUEST,
          },
          undefined,
          user,
        ),
      ).rejects.toThrow('Năm học không hợp lệ');
      expect(manager.count).not.toHaveBeenCalled();
    });

    it('từ chối khi trường không có môn học đúng năm', async () => {
      const manager = {
        findOne: jest.fn().mockResolvedValue({ id: 445, name: 'TH ABC' }),
        count: jest.fn().mockResolvedValue(0),
      };
      const service = makeService(manager);

      await expect(
        service.create(
          {
            ...validBody,
            schoolId: 445,
            type: SuggestType.EXPENSE_REQUEST,
          },
          undefined,
          user,
        ),
      ).rejects.toThrow('Trường không có môn học trong năm học đã chọn');
      expect(manager.count).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          where: { schoolId: 445, schoolYear: '2099-2100' },
        }),
      );
    });

    it('lưu và trả snapshot có school, schoolId, schoolYear', async () => {
      const school = { id: 445, name: 'TH ABC' };
      let createdSuggest: any;
      const manager = {
        findOne: jest.fn().mockResolvedValue(school),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn((_entity, data) => {
          createdSuggest = data;
          return data;
        }),
        save: jest.fn().mockImplementation(async (data) => ({
          ...data,
          id: 123,
        })),
      };
      const service = makeService(manager);
      (service as any).generateCode = jest
        .fn()
        .mockResolvedValue('DX-209909-0001');
      (service as any).writeExpenseLog = jest.fn();
      (service as any).notifyExpense = jest.fn();
      (service as any).findOneExpense = jest.fn().mockResolvedValue({
        id: 123,
        schoolId: 445,
        school,
        schoolYear: '2099-2100',
        status: SuggestStatus.PENDING_APPROVAL,
      });

      const result = await service.create(
        {
          ...validBody,
          schoolId: 445,
          type: SuggestType.EXPENSE_REQUEST,
        },
        undefined,
        user,
      );

      expect(createdSuggest).toEqual(
        expect.objectContaining({
          schoolId: 445,
          school,
          schoolYear: '2099-2100',
          amount: null,
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          schoolId: 445,
          school,
          schoolYear: '2099-2100',
        }),
      );
    });

    it('cho phép người kiêm kinh doanh và thủ quỹ tạo đề xuất', async () => {
      const school = { id: 445, name: 'TH ABC' };
      const manager = {
        findOne: jest.fn().mockResolvedValue(school),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn((_entity, data) => data),
        save: jest
          .fn()
          .mockImplementation(async (data) => ({ ...data, id: 124 })),
      };
      const service = makeService(manager);
      (service as any).generateCode = jest
        .fn()
        .mockResolvedValue('DX-209909-0002');
      (service as any).writeExpenseLog = jest.fn();
      (service as any).notifyExpense = jest.fn();
      (service as any).findOneExpense = jest
        .fn()
        .mockResolvedValue({ id: 124 });

      await expect(
        service.create(
          {
            ...validBody,
            schoolId: 445,
            type: SuggestType.EXPENSE_REQUEST,
          },
          undefined,
          user,
        ),
      ).resolves.toEqual({ id: 124 });
    });
  });

  it('áp dụng đồng thời status, schoolId và schoolYear trước pagination', async () => {
    const qb: any = {};
    for (const method of [
      'leftJoinAndSelect',
      'where',
      'andWhere',
      'orderBy',
      'skip',
      'take',
    ]) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);

    const service = Object.create(SuggestService.prototype) as SuggestService;
    (service as any).repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    await service.findAllExpense({
      status: SuggestStatus.SPENT,
      schoolId: 445,
      schoolYear: '2099-2100',
      page: 2,
      limit: 100,
    });

    expect(qb.andWhere).toHaveBeenCalledWith('s.status = :status', {
      status: SuggestStatus.SPENT,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('s.schoolId = :schoolId', {
      schoolId: 445,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('s.schoolYear = :schoolYear', {
      schoolYear: '2099-2100',
    });
    expect(qb.skip).toHaveBeenCalledWith(100);
    expect(qb.take).toHaveBeenCalledWith(100);
  });

  it('giáo viên công ty chỉ được query đề nghị của chính mình', async () => {
    const qb: any = {};
    for (const method of [
      'leftJoinAndSelect',
      'where',
      'andWhere',
      'orderBy',
      'skip',
      'take',
    ]) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    const service = Object.create(SuggestService.prototype) as SuggestService;
    (service as any).repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    await service.findAllExpense(
      { page: 1, limit: 20 },
      { id: 19, roles: [ExpenseRole.STAFF_TEACHER] } as any,
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      's.createdBy = :requesterId',
      { requesterId: 19 },
    );
  });

  it('giáo viên công ty không xem được chi tiết đề nghị của người khác', async () => {
    const service = Object.create(SuggestService.prototype) as SuggestService;
    (service as any).repo = {
      findOne: jest.fn().mockResolvedValue({ id: 8, createdBy: 77 }),
    };

    await expect(
      service.findOneExpense(8, {
        id: 19,
        roles: [ExpenseRole.STAFF_TEACHER],
      } as any),
    ).rejects.toThrow('chỉ được xem đề nghị của chính mình');
  });
});

describe('Thủ quỹ xác nhận xuất tiền — Nguồn chi', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata = {
    type: 'body' as const,
    metatype: ConfirmCashReleasedDto,
    data: '',
  };

  it('DTO nhận số hiệu tài khoản Nguồn thu chi, từ chối mã nhóm/mã lạ', async () => {
    await expect(
      pipe.transform({ cashAccount: '1121' }, metadata),
    ).resolves.toMatchObject({
      cashAccount: '1121',
    });
    await expect(
      pipe.transform({ cashAccount: '112' }, metadata),
    ).rejects.toBeDefined();
    await expect(
      pipe.transform({ cashAccount: '9999' }, metadata),
    ).rejects.toBeDefined();
  });

  function makeService() {
    const manager = { update: jest.fn() };
    const service = Object.create(SuggestService.prototype) as SuggestService;
    const calls: { transition?: any; notify?: any } = {};
    (service as any).expenseTransition = jest.fn(async (opts: any) => {
      calls.transition = opts;
      const s = {
        id: 5,
        code: 'DX-202610-0001',
        createdBy: 9,
        status: 'CASH_RELEASED',
      };
      await opts.extra(manager, s);
      return s;
    });
    (service as any).saveExpenseAttachments = jest.fn();
    (service as any).notifyExpense = jest.fn(async (payload: any) => {
      calls.notify = payload;
    });
    return { service, manager, calls };
  }

  it('chọn Nguồn chi 1113 → lưu tài khoản, nhóm tiền mặt, ghi log và báo đúng tên tài khoản', async () => {
    const { service, manager, calls } = makeService();

    await service.confirmCashReleased(
      5,
      { id: 3 } as any,
      undefined,
      [],
      undefined,
      '1113',
    );

    expect(calls.transition.logData()).toEqual({
      fundSource: 'COMPANY_CASH',
      cashAccount: '1113',
    });
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { suggestId: 5 },
      { fundSource: 'COMPANY_CASH', cashAccount: '1113' },
    );
    expect(calls.notify.message).toContain('từ 1113 - Tiền mặt - Anh Trung,');
    expect(calls.notify.meta).toMatchObject({
      fundSource: 'COMPANY_CASH',
      cashAccount: '1113',
    });
  });

  it('tài khoản 112x suy ra nhóm Tài khoản ngân hàng', async () => {
    const { service, manager } = makeService();

    await service.confirmCashReleased(
      5,
      { id: 3 } as any,
      undefined,
      [],
      undefined,
      '11212',
    );

    expect(manager.update.mock.calls[0][2]).toEqual({
      fundSource: 'BANK_ACCOUNT',
      cashAccount: '11212',
    });
  });

  it('client cũ chỉ gửi fundSource → vẫn chạy, cashAccount = null', async () => {
    const { service, manager, calls } = makeService();

    await service.confirmCashReleased(
      5,
      { id: 3 } as any,
      undefined,
      [],
      'BANK_ACCOUNT' as any,
    );

    expect(calls.transition.logData()).toEqual({
      fundSource: 'BANK_ACCOUNT',
      cashAccount: null,
    });
    expect(manager.update.mock.calls[0][2]).toEqual({
      fundSource: 'BANK_ACCOUNT',
      cashAccount: null,
    });
    expect(calls.notify.message).toContain('từ tài khoản ngân hàng,');
  });

  it('không chọn nguồn chi thì báo lỗi, không chuyển trạng thái', async () => {
    const { service, calls } = makeService();

    await expect(
      service.confirmCashReleased(5, { id: 3 } as any, undefined, []),
    ).rejects.toThrow(BadRequestException);
    expect(calls.transition).toBeUndefined();
  });
});
