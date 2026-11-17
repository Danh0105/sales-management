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
      (service as any).assertNoOpenExpense = jest.fn();
      return service;
    }

    const user = {
      id: 7,
      roles: [ExpenseRole.SALES, ExpenseRole.TREASURER],
    } as any;

    // Chính sách đã duyệt của trường có hỗ trợ tiền mặt (điều kiện tạo chi Năm).
    const policyWithCash = [
      {
        policy_id: 1,
        subject_id: 9,
        subject_name: 'Tin học',
        data: { httienmat: [{ type: 'Chính sách', money: 9_000_000, realStudents: 1000, months: 9 }], htthietbi: [] },
      },
    ];

    it('có schoolId thì tự điền năm học hiện tại khi chưa truyền schoolYear', async () => {
      const school = { id: 445, name: 'TH ABC' };
      let createdSuggest: any;
      const manager = {
        findOne: jest.fn().mockResolvedValue(school),
        count: jest.fn().mockResolvedValue(1),
        query: jest.fn(async (sql: string) => (sql.includes('FROM policy p') ? policyWithCash : [])),
        delete: jest.fn(),
        create: jest.fn((_entity, data) => {
          // Dòng chính sách đã tích cũng tạo qua manager.create — chỉ bắt đề xuất.
          if (!('itemIndex' in data)) createdSuggest = data;
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
          policySupportItems: [{ policyId: 1, supportType: 'CASH', itemIndex: 0, amount: 100_000 }],
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
          // Dòng chính sách đã tích cũng tạo qua manager.create — chỉ bắt đề xuất.
          if (!('itemIndex' in data)) createdSuggest = data;
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

    it('giáo viên công ty cũng phải chọn trường hoặc xã/phường như kinh doanh', async () => {
      const service = makeService({});

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
      ).rejects.toThrow('Thiếu xã/phường');
    });

    it('giáo viên công ty tạo đề nghị theo xã/phường giống kinh doanh', async () => {
      const ward = { id: 12, name: 'Phường Tân Lập' };
      let createdSuggest: any;
      const manager = {
        findOne: jest.fn().mockResolvedValue(ward),
        create: jest.fn((_entity, data) => {
          // Dòng chính sách đã tích cũng tạo qua manager.create — chỉ bắt đề xuất.
          if (!('itemIndex' in data)) createdSuggest = data;
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
            wardId: 12,
            type: SuggestType.EXPENSE_REQUEST,
          },
          undefined,
          { id: 19, roles: [ExpenseRole.STAFF_TEACHER] } as any,
        ),
      ).resolves.toEqual({ id: 125 });

      expect(createdSuggest).toEqual(
        expect.objectContaining({ createdBy: 19, wardId: 12, ward }),
      );
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
            policySupportItems: [{ policyId: 1, supportType: 'CASH', itemIndex: 0, amount: 100_000 }],
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
        query: jest.fn(async (sql: string) => (sql.includes('FROM policy p') ? policyWithCash : [])),
        delete: jest.fn(),
        create: jest.fn((_entity, data) => {
          // Dòng chính sách đã tích cũng tạo qua manager.create — chỉ bắt đề xuất.
          if (!('itemIndex' in data)) createdSuggest = data;
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
          policySupportItems: [{ policyId: 1, supportType: 'CASH', itemIndex: 0, amount: 100_000 }],
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
          deductPolicy: true,
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
        query: jest.fn(async (sql: string) => (sql.includes('FROM policy p') ? policyWithCash : [])),
        delete: jest.fn(),
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
            policySupportItems: [{ policyId: 1, supportType: 'CASH', itemIndex: 0, amount: 100_000 }],
          },
          undefined,
          user,
        ),
      ).resolves.toEqual({ id: 124 });
    });

    it('bỏ Trừ chính sách thì không yêu cầu hỗ trợ tiền mặt hoặc thiết bị', async () => {
      const school = { id: 445, name: 'TH ABC' };
      let createdSuggest: any;
      const manager = {
        findOne: jest.fn().mockResolvedValue(school),
        count: jest.fn().mockResolvedValue(1),
        query: jest.fn(),
        delete: jest.fn(),
        create: jest.fn((_entity, data) => {
          createdSuggest = data;
          return data;
        }),
        save: jest.fn().mockImplementation(async (data) => ({
          ...data,
          id: 125,
        })),
      };
      const service = makeService(manager);
      (service as any).generateCode = jest
        .fn()
        .mockResolvedValue('DX-209909-0003');
      (service as any).writeExpenseLog = jest.fn();
      (service as any).notifyExpense = jest.fn();
      (service as any).findOneExpense = jest.fn().mockResolvedValue({ id: 125 });

      await service.create(
        {
          ...validBody,
          schoolId: 445,
          deductPolicy: false,
          type: SuggestType.EXPENSE_REQUEST,
        },
        undefined,
        user,
      );

      expect(createdSuggest).toEqual(
        expect.objectContaining({ deductPolicy: false }),
      );
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  it('chặn tạo khi nhân viên còn đề xuất chi chưa hoàn tất', async () => {
    const manager = {
      query: jest.fn(),
      findOne: jest.fn().mockResolvedValue({
        id: 91,
        code: 'DX-202611-0091',
        status: SuggestStatus.PENDING_APPROVAL,
      }),
    };
    const service = Object.create(SuggestService.prototype) as SuggestService;

    await expect(
      (service as any).assertNoOpenExpense(manager, 7),
    ).rejects.toThrow(
      'Bạn còn đề xuất DX-202611-0091 chưa hoàn tất',
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      [7],
    );
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
    // Đề xuất chi tháng nhiều trường: khớp cả trường thứ 2 trở đi.
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\(s\.schoolId = :schoolId OR EXISTS[\s\S]*suggest_monthly_items[\s\S]*school_id = :schoolId/,
      ),
      { schoolId: 445 },
    );
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

    // Đơn của mình + đơn mình được Giám đốc chỉ định, không gì khác.
    const scope = qb.andWhere.mock.calls.find(
      ([, params]: [string, any]) => params?.requesterId === 19,
    );
    expect(scope).toBeDefined();
    const [sql, params] = scope;
    expect(params).toEqual({ requesterId: 19 });
    expect(sql).toMatch(/^\(s\.createdBy = :requesterId OR \(/);
    for (const condition of [
      's.assignedTechnicianId = :requesterId',
      's.stockInHandlerId = :requesterId',
      's.acceptorId = :requesterId',
      'sa."suggestId" = s.id AND sa."employeeId" = :requesterId',
    ]) {
      expect(sql).toContain(condition);
    }
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

  describe('người được Giám đốc chỉ định xem được đề xuất', () => {
    const sales = { id: 19, roles: [ExpenseRole.SALES] } as any;
    const detailService = (suggest: Record<string, unknown>) => {
      const service = Object.create(SuggestService.prototype) as SuggestService;
      (service as any).repo = {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 8, createdBy: 77, ...suggest }),
      };
      (service as any).historyRepo = { find: jest.fn().mockResolvedValue([]) };
      (service as any).employeeRepo = {
        findBy: jest.fn().mockResolvedValue([]),
      };
      return service;
    };

    it.each([
      ['người hỗ trợ', { assignments: [{ employeeId: 19, role: 'SUPPORT' }] }],
      [
        'người hỗ trợ đã từ chối',
        {
          assignments: [
            { employeeId: 19, role: 'SUPPORT', status: 'DECLINED' },
          ],
        },
      ],
      ['người xử lý nhập kho', { stockInHandlerId: 19 }],
      ['người nghiệm thu', { acceptorId: 19 }],
    ])('kinh doanh là %s mở được chi tiết', async (_label, suggest) => {
      const service = detailService(suggest);

      await expect(service.findOneExpense(8, sales)).resolves.toMatchObject({
        id: 8,
        createdBy: 77,
      });
    });

    it('kinh doanh không được chỉ định vẫn bị chặn dù đề xuất có người khác được giao', async () => {
      const service = detailService({
        stockInHandlerId: 20,
        acceptorId: 21,
        assignments: [{ employeeId: 22, role: 'SUPPORT' }],
      });

      await expect(service.findOneExpense(8, sales)).rejects.toThrow(
        'chỉ được xem đề nghị của chính mình',
      );
    });

    it('kỹ thuật được chỉ định nghiệm thu vẫn xem được dù đã có người bàn giao khác', async () => {
      const service = detailService({
        requestKind: 'EQUIPMENT',
        assignedTechnicianId: 30,
        acceptorId: 19,
      });

      await expect(
        service.findOneExpense(8, {
          id: 19,
          roles: [ExpenseRole.TECHNICAL],
        } as any),
      ).resolves.toMatchObject({ id: 8 });
    });

    it('kỹ thuật không được chỉ định vẫn bị chặn khi đề xuất đã giao người khác', async () => {
      const service = detailService({
        requestKind: 'REPAIR',
        assignedTechnicianId: 30,
        assignments: [{ employeeId: 31, role: 'SUPPORT' }],
      });

      await expect(
        service.findOneExpense(8, {
          id: 19,
          roles: [ExpenseRole.TECHNICAL],
        } as any),
      ).rejects.toThrow('đã được giao cho một nhân viên kỹ thuật khác');
    });

    const listQb = () => {
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
      return { qb, service };
    };

    it('"Đề xuất của tôi" kèm includeAssigned trả thêm đề xuất mình được chỉ định', async () => {
      const { qb, service } = listQb();

      await service.findAllExpense(
        { createdBy: 19, includeAssigned: true, page: 1, limit: 20 },
        { id: 19, roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES] } as any,
      );

      const filter = qb.andWhere.mock.calls.find(
        ([, params]: [string, any]) => params?.createdBy === 19,
      );
      expect(filter[0]).toMatch(/^\(s\.createdBy = :createdBy OR \(/);
      expect(filter[0]).toContain('s.acceptorId = :createdBy');
      expect(qb.andWhere).not.toHaveBeenCalledWith('s.createdBy = :createdBy', {
        createdBy: 19,
      });
    });

    it('includeAssigned không mở rộng khi lọc theo người tạo khác', async () => {
      const { qb, service } = listQb();

      await service.findAllExpense(
        { createdBy: 77, includeAssigned: true, page: 1, limit: 20 },
        { id: 19, roles: [ExpenseRole.DIRECTOR] } as any,
      );

      expect(qb.andWhere).toHaveBeenCalledWith('s.createdBy = :createdBy', {
        createdBy: 77,
      });
    });

    it('kỹ thuật thấy đề xuất chưa giao ai hoặc mình được chỉ định', async () => {
      const { qb, service } = listQb();

      await service.findAllExpense({ page: 1, limit: 20 }, {
        id: 19,
        roles: [ExpenseRole.TECHNICAL],
      } as any);

      const scope = qb.andWhere.mock.calls.find(
        ([, params]: [string, any]) => params?.technicalActorId === 19,
      );
      expect(scope[1]).toEqual({
        technicalKinds: ['EQUIPMENT', 'REPAIR'],
        technicalActorId: 19,
      });
      expect(scope[0]).toMatch(
        /s\.requestKind IN \(:\.\.\.technicalKinds\)\s+AND s\.assignedTechnicianId IS NULL/,
      );
      expect(scope[0]).toContain('s.stockInHandlerId = :technicalActorId');
    });
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
