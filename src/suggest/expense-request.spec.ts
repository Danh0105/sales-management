import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateExpenseRequestDto } from './dto/expense/create-expense-request.dto';
import { CreateSuggestDto } from './dto/create-suggest.dto';
import { SuggestService } from './suggest.service';
import { ExpenseRole } from './constants/expense-roles';
import { SuggestType } from './enums/suggest-type.enum';
import { SuggestStatus } from './SuggestStatus.enum';

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

    it('có schoolId thì bắt buộc schoolYear', async () => {
      const service = makeService({});

      await expect(
        service.create(
          {
            content: 'Mua thiết bị',
            expectedPaymentDate: '2099-09-15',
            schoolId: 445,
            type: SuggestType.EXPENSE_REQUEST,
          },
          undefined,
          user,
        ),
      ).rejects.toThrow('Thiếu năm học');
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
        save: jest.fn().mockImplementation(async (data) => ({ ...data, id: 123 })),
      };
      const service = makeService(manager);
      (service as any).generateCode = jest.fn().mockResolvedValue('DX-209909-0001');
      (service as any).writeExpenseLog = jest.fn();
      (service as any).notifyExpense = jest.fn();
      (service as any).findOneExpense = jest.fn().mockResolvedValue({ id: 123 });

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
        save: jest.fn().mockImplementation(async (data) => ({ ...data, id: 124 })),
      };
      const service = makeService(manager);
      (service as any).generateCode = jest.fn().mockResolvedValue('DX-209909-0002');
      (service as any).writeExpenseLog = jest.fn();
      (service as any).notifyExpense = jest.fn();
      (service as any).findOneExpense = jest.fn().mockResolvedValue({ id: 124 });

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
});
