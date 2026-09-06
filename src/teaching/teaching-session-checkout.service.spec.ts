import { Logger } from '@nestjs/common';
import { TeachingSessionService } from './teaching-session.service';
import { AssignmentStatus, SessionStatus } from './teaching.enum';
import { TeachingSession } from './entities/teaching-session.entity';

describe('TeachingSessionService.checkout', () => {
  const dto = {
    latitude: 10.0001,
    longitude: 106,
    lessonName: 'Phép cộng',
    lessonEvaluation: 'Tiếp thu tốt',
  };

  function setup(overrides: Record<string, unknown> = {}) {
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const entity: any = {
      id: 7,
      teacherId: 5,
      schoolId: 10,
      date: today,
      teacher: { employeeId: 99 },
      school: { latitude: 10, longitude: 106, checkinRadius: 200 },
      status: SessionStatus.SCHEDULED,
      assignmentStatus: AssignmentStatus.ASSIGNED,
      checkinAt: new Date(),
      checkoutAt: null,
      ...overrides,
    };
    // Buổi này không thuộc block nào có check-in — dùng cho case `checkinAt: null`
    // (nới lỏng checkout() giờ phải truy vấn thêm để biết điều đó).
    const blockQb: any = {};
    ['select', 'where', 'andWhere', 'orderBy', 'addOrderBy'].forEach(
      (method) => {
        blockQb[method] = jest.fn().mockReturnValue(blockQb);
      },
    );
    blockQb.getRawMany = jest.fn().mockResolvedValue([]);
    const transactionRepo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn().mockResolvedValue(entity),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(blockQb),
    };
    const schoolRepo = {
      findOne: jest
        .fn()
        .mockImplementation(() => Promise.resolve(entity.school)),
    };
    const dataSource = {
      transaction: jest.fn(async (work) =>
        work({
          getRepository: (target) =>
            target === TeachingSession ? transactionRepo : schoolRepo,
        }),
      ),
    };
    const storage = {
      storeMany: jest
        .fn()
        .mockResolvedValue([
          { url: '/uploads/lesson-images/a.webp', name: 'a.webp' },
        ]),
      removeMany: jest.fn().mockResolvedValue(undefined),
    };
    const teacherRepo = {
      findOne: jest.fn(({ where }) =>
        Promise.resolve({
          id: where.employeeId === 99 ? 5 : 6,
          employeeId: where.employeeId,
        }),
      ),
    };
    const service = new TeachingSessionService(
      {} as any,
      teacherRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource as any,
      {} as any,
      {} as any,
      {} as any,
      storage as any,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 7 } as any);
    return {
      service,
      entity,
      transactionRepo,
      dataSource,
      storage,
      teacherRepo,
      schoolRepo,
    };
  }

  it('lưu thời gian server và GPS, không lưu nội dung báo giảng', async () => {
    const { service, entity, transactionRepo, storage, schoolRepo } = setup();
    await expect(
      service.checkout(7, dto, 99, [{} as Express.Multer.File]),
    ).resolves.toEqual({ id: 7 });
    expect(storage.storeMany).not.toHaveBeenCalled();
    expect(transactionRepo.findOne).toHaveBeenCalledWith({
      where: { id: 7 },
      lock: { mode: 'pessimistic_write' },
    });
    expect(schoolRepo.findOne).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(transactionRepo.save).toHaveBeenCalledWith(entity);
    expect(entity.checkoutAt).toBeInstanceOf(Date);
    expect(entity.checkoutAccuracy).toBeNull();
    expect(entity.checkoutDistance).toBeGreaterThan(0);
    expect(entity.checkoutOutOfRange).toBe(false);
    expect(entity.lessonName).toBeUndefined();
    expect(entity.lessonImages).toBeUndefined();
  });

  it('để distance null nếu trường chưa có tọa độ', async () => {
    const { service, entity } = setup({
      school: { latitude: null, longitude: null },
    });
    await service.checkout(7, { ...dto, accuracy: 8 }, 99, []);
    expect(entity.checkoutDistance).toBeNull();
    expect(entity.checkoutOutOfRange).toBe(false);
    expect(entity.checkoutAccuracy).toBe(8);
  });

  it('từ chối giáo viên không được phân công và dọn ảnh', async () => {
    const { service, storage } = setup();
    await expect(service.checkout(7, dto, 100, [])).rejects.toMatchObject({
      status: 403,
    });
    expect(storage.removeMany).not.toHaveBeenCalled();
  });

  it('trả 404 khi tài khoản chưa có hồ sơ giáo viên và chưa upload ảnh', async () => {
    const { service, teacherRepo, storage } = setup();
    teacherRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.checkout(7, dto, 99, [])).rejects.toMatchObject({
      status: 404,
    });
    expect(storage.storeMany).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: SessionStatus.CANCELLED }, 400],
    [{ checkoutAt: new Date() }, 409],
    [{ checkinAt: null }, 400],
  ])('từ chối trạng thái không hợp lệ %#', async (change, status) => {
    const { service, storage } = setup(change);
    await expect(service.checkout(7, dto, 99, [])).rejects.toMatchObject({
      status,
    });
    expect(storage.removeMany).not.toHaveBeenCalled();
  });

  it('rollback transaction và dọn file khi database lỗi', async () => {
    const { service, transactionRepo, storage } = setup();
    transactionRepo.save.mockRejectedValueOnce(new Error('database failed'));
    await expect(service.checkout(7, dto, 99, [])).rejects.toMatchObject({
      status: 500,
      response: expect.objectContaining({
        code: 'TEACHING_SESSION_CHECKOUT_SAVE_FAILED',
      }),
    });
    expect(storage.removeMany).not.toHaveBeenCalled();
  });

  it('log lỗi kèm requestId, sessionId, teacherId và số ảnh', async () => {
    const { service, transactionRepo } = setup();
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    transactionRepo.save.mockRejectedValueOnce(new Error('database failed'));

    await expect(
      service.checkout(
        7,
        dto,
        99,
        [{} as Express.Multer.File, {} as Express.Multer.File],
        'req-123',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ requestId: 'req-123' }),
    });

    const [message, stack] = log.mock.calls[0];
    expect(
      JSON.parse(String(message).replace('checkout thất bại ', '')),
    ).toEqual({
      requestId: 'req-123',
      sessionId: 7,
      employeeId: 99,
      teacherId: 5,
      imageCount: 2,
      status: 500,
      code: null,
    });
    expect(stack).toContain('database failed');
    log.mockRestore();
  });

  it('tự sinh requestId khi không có header và log lỗi nghiệp vụ ở mức warn', async () => {
    const { service } = setup({ checkoutAt: new Date() });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(service.checkout(7, dto, 99, [])).rejects.toMatchObject({
      status: 409,
    });

    const logged = JSON.parse(
      String(warn.mock.calls[0][0]).replace('checkout bị từ chối ', ''),
    );
    expect(logged).toMatchObject({
      sessionId: 7,
      teacherId: 5,
      imageCount: 0,
      status: 409,
      code: 'TEACHING_SESSION_ALREADY_CHECKED_OUT',
    });
    expect(logged.requestId).toEqual(expect.any(String));
    warn.mockRestore();
  });

  it('checkout không xử lý file minh chứng', async () => {
    const { service, storage } = setup();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.checkout(7, dto, 99, [{} as Express.Multer.File]),
    ).resolves.toEqual({ id: 7 });
    expect(storage.storeMany).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
