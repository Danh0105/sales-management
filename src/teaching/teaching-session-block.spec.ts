import { HttpException } from '@nestjs/common';
import { TeachingSessionService } from './teaching-session.service';
import { AssignmentStatus, SessionStatus } from './teaching.enum';
import { TeachingSession } from './entities/teaching-session.entity';
import { computeDayBlocks, isBlockCheckedIn } from './teaching.util';

/**
 * Tiết liên tiếp cùng trường trong ngày chỉ cần check-in tiết đầu, check-out
 * tiết cuối; tiết giữa (hoặc tiết đầu của block nhiều tiết) nộp nội dung bài
 * dạy qua `submitLesson()` không cần GPS, miễn block đã có ai check-in.
 */

describe('computeDayBlocks', () => {
  it('buổi lẻ (không liên tiếp trường nào khác) thì cần cả check-in lẫn check-out', () => {
    const result = computeDayBlocks([{ id: 1, schoolId: 10 }]);
    expect(result.get(1)).toEqual({ checkinRequired: true, checkoutRequired: true });
  });

  it('3 tiết liên tiếp cùng trường: chỉ tiết đầu cần check-in, chỉ tiết cuối cần check-out', () => {
    const result = computeDayBlocks([
      { id: 1, schoolId: 10 },
      { id: 2, schoolId: 10 },
      { id: 3, schoolId: 10 },
    ]);
    expect(result.get(1)).toEqual({ checkinRequired: true, checkoutRequired: false });
    expect(result.get(2)).toEqual({ checkinRequired: false, checkoutRequired: false });
    expect(result.get(3)).toEqual({ checkinRequired: false, checkoutRequired: true });
  });

  it('xen trường khác thì ngắt block, mỗi bên tự có đầu/cuối riêng', () => {
    const result = computeDayBlocks([
      { id: 1, schoolId: 10 },
      { id: 2, schoolId: 10 },
      { id: 3, schoolId: 20 },
      { id: 4, schoolId: 10 },
    ]);
    expect(result.get(1)).toEqual({ checkinRequired: true, checkoutRequired: false });
    expect(result.get(2)).toEqual({ checkinRequired: false, checkoutRequired: true });
    expect(result.get(3)).toEqual({ checkinRequired: true, checkoutRequired: true });
    expect(result.get(4)).toEqual({ checkinRequired: true, checkoutRequired: true });
  });
});

describe('isBlockCheckedIn', () => {
  const now = new Date();

  it('không tìm thấy session thì false', () => {
    expect(isBlockCheckedIn([], 99)).toBe(false);
  });

  it('block chưa ai check-in thì false', () => {
    const sessions = [
      { id: 1, schoolId: 10, checkinAt: null },
      { id: 2, schoolId: 10, checkinAt: null },
    ];
    expect(isBlockCheckedIn(sessions, 2)).toBe(false);
  });

  it('tiết đầu đã check-in thì tiết giữa/cuối trong block đều true', () => {
    const sessions = [
      { id: 1, schoolId: 10, checkinAt: now },
      { id: 2, schoolId: 10, checkinAt: null },
      { id: 3, schoolId: 10, checkinAt: null },
    ];
    expect(isBlockCheckedIn(sessions, 2)).toBe(true);
    expect(isBlockCheckedIn(sessions, 3)).toBe(true);
  });

  it('checkin ở block khác trường không lan sang block đang xét', () => {
    const sessions = [
      { id: 1, schoolId: 10, checkinAt: now },
      { id: 2, schoolId: 20, checkinAt: null },
    ];
    expect(isBlockCheckedIn(sessions, 2)).toBe(false);
  });
});

describe('TeachingSessionService — checkout()/submitLesson() nới lỏng theo block', () => {
  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

  function makeBlockQb(daySessions: any[]) {
    const qb: any = {};
    ['select', 'where', 'andWhere', 'orderBy', 'addOrderBy'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getRawMany = jest.fn().mockResolvedValue(daySessions);
    return qb;
  }

  function setup(entityOverrides: Record<string, unknown>, daySessions: any[]) {
    const entity: any = {
      id: 7,
      teacherId: 5,
      schoolId: 10,
      date: today,
      teacher: { employeeId: 99 },
      school: { latitude: 10, longitude: 106, checkinRadius: 200 },
      status: SessionStatus.SCHEDULED,
      assignmentStatus: AssignmentStatus.ASSIGNED,
      checkinAt: null,
      checkoutAt: null,
      ...entityOverrides,
    };
    const blockQb = makeBlockQb(daySessions);
    const transactionRepo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn().mockResolvedValue(entity),
      update: jest.fn().mockResolvedValue({ affected: daySessions.length }),
      createQueryBuilder: jest.fn().mockReturnValue(blockQb),
    };
    const schoolRepo = {
      findOne: jest.fn().mockResolvedValue(entity.school),
    };
    const dataSource = {
      transaction: jest.fn(async (work: any) =>
        work({
          getRepository: (target: any) =>
            target === TeachingSession ? transactionRepo : schoolRepo,
        }),
      ),
    };
    const storage = {
      storeMany: jest.fn().mockResolvedValue([]),
      removeMany: jest.fn().mockResolvedValue(undefined),
    };
    const teacherRepo = {
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve({ id: 5, employeeId: where.employeeId }),
      ),
    };
    const sessionRepo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn().mockResolvedValue(entity),
      createQueryBuilder: jest.fn().mockReturnValue(blockQb),
    };
    const service = new TeachingSessionService(
      sessionRepo as any,
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
    return { service, entity, transactionRepo, storage, sessionRepo };
  }

  const checkoutDto = {
    latitude: 10.0001,
    longitude: 106,
    lessonName: 'Phép cộng',
    lessonEvaluation: 'Tiếp thu tốt',
  };
  const lessonDto = {
    lessonName: 'Phép trừ',
    lessonEvaluation: 'Khá',
    actualStudentCount: 28,
  };

  it('checkout() ở tiết cuối block đóng luôn các tiết chưa tự check-out, đánh dấu checkoutViaAdjacent', async () => {
    const { service, entity, transactionRepo } = setup({ id: 7 }, [
      { id: 6, schoolId: 10, checkinAt: new Date(), checkoutAt: null },
      { id: 7, schoolId: 10, checkinAt: null, checkoutAt: null },
    ]);

    await expect(
      service.checkout(7, checkoutDto, 99, []),
    ).resolves.toEqual({ id: 7 });
    expect(entity.checkoutAt).toBeInstanceOf(Date);
    expect(entity.checkoutViaAdjacent).toBe(false);
    expect(transactionRepo.update).toHaveBeenCalledWith(
      expect.any(Object),
      { checkoutAt: expect.any(Date), checkoutViaAdjacent: true },
    );
    // Chỉ đóng hộ tiết KHÁC chưa tự check-out — tiết đang check-out (7) tự
    // lưu qua repository.save(), không lặp lại trong update() cascade.
    expect(transactionRepo.update.mock.calls[0][0].id.value).toEqual([6]);
  });

  it('checkout() ở tiết cuối block không đụng tới tiết đã tự check-out riêng trước đó', async () => {
    const { service, transactionRepo } = setup({ id: 8 }, [
      { id: 6, schoolId: 10, checkinAt: new Date(), checkoutAt: new Date() },
      { id: 7, schoolId: 10, checkinAt: null, checkoutAt: null },
      { id: 8, schoolId: 10, checkinAt: null, checkoutAt: null },
    ]);

    await expect(service.checkout(8, checkoutDto, 99, [])).resolves.toEqual({
      id: 7,
    });
    // Tiết 6 đã tự check-out từ trước (checkoutAt riêng) → không nằm trong
    // danh sách bị ghi đè.
    expect(transactionRepo.update.mock.calls[0][0].id.value).toEqual([7]);
  });

  it('checkout() tiết cuối block khi chưa ai check-in → lỗi NOT_CHECKED_IN', async () => {
    const { service } = setup({ id: 7 }, [
      { id: 6, schoolId: 10, checkinAt: null, checkoutAt: null },
      { id: 7, schoolId: 10, checkinAt: null, checkoutAt: null },
    ]);

    await expect(service.checkout(7, checkoutDto, 99, [])).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'TEACHING_SESSION_NOT_CHECKED_IN',
      }),
    });
  });

  it('checkout() trực tiếp ở tiết giữa/đầu block: chỉ tự check-out tiết đó, không cascade', async () => {
    const { service, entity, transactionRepo } = setup({ id: 6 }, [
      { id: 6, schoolId: 10, checkinAt: new Date(), checkoutAt: null },
      { id: 7, schoolId: 10, checkinAt: null, checkoutAt: null },
    ]);

    await expect(
      service.checkout(6, checkoutDto, 99, []),
    ).resolves.toEqual({ id: 7 });
    expect(entity.checkoutAt).toBeInstanceOf(Date);
    expect(entity.checkoutViaAdjacent).toBe(false);
    expect(transactionRepo.update).not.toHaveBeenCalled();
  });

  it('checkout() trực tiếp ở tiết giữa khi block chưa ai check-in → lỗi NOT_CHECKED_IN', async () => {
    const { service } = setup({ id: 6 }, [
      { id: 6, schoolId: 10, checkinAt: null, checkoutAt: null },
      { id: 7, schoolId: 10, checkinAt: null, checkoutAt: null },
    ]);

    await expect(service.checkout(6, checkoutDto, 99, [])).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'TEACHING_SESSION_NOT_CHECKED_IN',
      }),
    });
  });

  it('checkout() buổi lẻ chưa check-in → lỗi NOT_CHECKED_IN', async () => {
    const { service } = setup({ id: 7 }, [
      { id: 7, schoolId: 10, checkinAt: null },
    ]);

    await expect(service.checkout(7, checkoutDto, 99, [])).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'TEACHING_SESSION_NOT_CHECKED_IN',
      }),
    });
  });

  it('checkin() ở tiết giữa/cuối block → lỗi CHECKIN_NOT_REQUIRED', async () => {
    const { service, sessionRepo } = setup({ id: 7 }, [
      { id: 6, schoolId: 10, checkinAt: null },
      { id: 7, schoolId: 10, checkinAt: null },
      { id: 8, schoolId: 10, checkinAt: null },
    ]);

    await expect(
      service.checkin(7, { latitude: 10, longitude: 106 }, 99),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'TEACHING_SESSION_CHECKIN_NOT_REQUIRED',
      }),
    });
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('checkin() tiết đầu bắt buộc lưu kèm ảnh', async () => {
    const { service, entity, storage } = setup({ id: 6 }, [
      { id: 6, schoolId: 10, checkinAt: null },
      { id: 7, schoolId: 10, checkinAt: null },
    ]);
    const image = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
    } as Express.Multer.File;

    await expect(
      service.checkin(6, { latitude: 10, longitude: 106 }, 99, image),
    ).resolves.toEqual({ id: 7 });
    expect(storage.storeMany).toHaveBeenCalledWith([image]);
    expect(entity.checkinAt).toBeInstanceOf(Date);
    expect(entity.checkinImages).toEqual([]);
  });

  it('checkin() không có ảnh → lỗi CHECKIN_IMAGE_REQUIRED', async () => {
    const { service } = setup({ id: 6 }, [
      { id: 6, schoolId: 10, checkinAt: null },
    ]);

    await expect(
      service.checkin(6, { latitude: 10, longitude: 106 }, 99),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'TEACHING_SESSION_CHECKIN_IMAGE_REQUIRED',
      }),
    });
  });

  it('submitLesson() cho tiết đã chấm công: lưu nội dung và sĩ số riêng', async () => {
    const { service, entity } = setup({ id: 7, checkoutAt: new Date() }, [
      { id: 6, schoolId: 10, checkinAt: new Date() },
      { id: 7, schoolId: 10, checkinAt: null },
      { id: 8, schoolId: 10, checkinAt: null },
    ]);

    await expect(
      service.submitLesson(7, lessonDto, 99, [{} as Express.Multer.File]),
    ).resolves.toEqual({ id: 7 });
    expect(entity.lessonSubmittedAt).toBeInstanceOf(Date);
    expect(entity.lessonName).toBe('Phép trừ');
    expect(entity.actualStudentCount).toBe(28);
    expect(entity.checkoutLatitude).toBeUndefined();
  });

  it('submitLesson() khi block chưa ai check-in → 400 yêu cầu check-in trước', async () => {
    const { service } = setup({ id: 7 }, [{ id: 7, schoolId: 10, checkinAt: null }]);

    await expect(service.submitLesson(7, lessonDto, 99, [{} as Express.Multer.File])).rejects.toMatchObject({
      status: 400,
    });
  });

  it('submitLesson() buổi đã huỷ → 400', async () => {
    const { service } = setup({ id: 7, status: SessionStatus.CANCELLED }, []);

    await expect(service.submitLesson(7, lessonDto, 99, [{} as Express.Multer.File])).rejects.toMatchObject({
      status: 400,
    });
  });

  it('submitLesson() đã nộp rồi → 409', async () => {
    const { service } = setup(
      {
        id: 7,
        checkinAt: new Date(),
        checkoutAt: new Date(),
        lessonSubmittedAt: new Date(),
      },
      [],
    );

    await expect(service.submitLesson(7, lessonDto, 99, [{} as Express.Multer.File])).rejects.toMatchObject({
      status: 409,
    });
  });

  it('submitLesson() sau 08:00 hôm sau → lỗi hết hạn', async () => {
    const { service } = setup(
      { id: 7, date: '2020-01-01', checkoutAt: new Date() },
      [{ id: 7, schoolId: 10, checkinAt: new Date() }],
    );

    await expect(
      service.submitLesson(7, lessonDto, 99, [{} as Express.Multer.File]),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'TEACHING_SESSION_LESSON_DEADLINE_EXPIRED',
      }),
    });
  });

  it('submitLesson() sai giáo viên → 403', async () => {
    const { service } = setup({ id: 7, teacherId: 6 }, []);

    await expect(service.submitLesson(7, lessonDto, 99, [{} as Express.Multer.File])).rejects.toMatchObject({
      status: 403,
    });
  });
});
