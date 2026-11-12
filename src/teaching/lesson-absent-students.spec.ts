import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { SubmitLessonDto } from './dto/teaching-session.dto';
import { TeachingSession } from './entities/teaching-session.entity';
import { lessonStudentCounts } from './lesson-student-counts';
import { TeachingSessionService } from './teaching-session.service';
import { AssignmentStatus, SessionStatus } from './teaching.enum';

/**
 * Báo giảng từ Mini App mới: tổng sĩ số lớp + họ tên học sinh vắng; sĩ số
 * thực tế = tổng − số vắng (server tự tính). Bản cũ chỉ gửi sĩ số thực tế.
 */
describe('SubmitLessonDto — tổng sĩ số + học sinh vắng (multipart)', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata = { type: 'body' as const, metatype: SubmitLessonDto };
  const base = { lessonName: 'Phép trừ', lessonEvaluation: 'Khá', actualStudentCount: '28' };

  it('chuỗi JSON: đổi số, trim tên, bỏ tên rỗng', async () => {
    const dto = await pipe.transform(
      { ...base, totalStudentCount: '30', absentStudentNames: '[" Nguyễn Văn A ","Trần Thị B","  "]' },
      metadata,
    );
    expect(dto).toMatchObject({
      actualStudentCount: 28,
      totalStudentCount: 30,
      absentStudentNames: ['Nguyễn Văn A', 'Trần Thị B'],
    });
  });

  it('mảng (key gửi lặp lại) và một chuỗi đơn', async () => {
    await expect(
      pipe.transform({ ...base, totalStudentCount: '30', absentStudentNames: [' A ', 'B'] }, metadata),
    ).resolves.toMatchObject({ absentStudentNames: ['A', 'B'] });
    await expect(
      pipe.transform({ ...base, totalStudentCount: '30', absentStudentNames: 'Nguyễn Văn A' }, metadata),
    ).resolves.toMatchObject({ absentStudentNames: ['Nguyễn Văn A'] });
  });

  it('"[]" → danh sách rỗng', async () => {
    await expect(
      pipe.transform({ ...base, totalStudentCount: '30', absentStudentNames: '[]' }, metadata),
    ).resolves.toMatchObject({ totalStudentCount: 30, absentStudentNames: [] });
  });

  it('request kiểu cũ (chỉ sĩ số thực tế) vẫn hợp lệ, không có trường mới', async () => {
    const dto = await pipe.transform({ ...base }, metadata);
    expect(dto.actualStudentCount).toBe(28);
    expect(dto.totalStudentCount).toBeUndefined();
    expect(dto.absentStudentNames).toBeUndefined();
  });

  it.each([
    ['JSON hỏng', { totalStudentCount: '30', absentStudentNames: '["A",' }],
    ['JSON không phải mảng', { totalStudentCount: '30', absentStudentNames: '{"a":1}' }],
    ['phần tử không phải chuỗi', { totalStudentCount: '30', absentStudentNames: '[1,2]' }],
    ['tên dài hơn 100 ký tự', { totalStudentCount: '30', absentStudentNames: JSON.stringify(['x'.repeat(101)]) }],
    ['quá 1000 tên', { totalStudentCount: '30', absentStudentNames: JSON.stringify(Array(1001).fill('A')) }],
    ['tổng sĩ số âm', { totalStudentCount: '-1' }],
    ['tổng sĩ số quá 1000', { totalStudentCount: '1001' }],
    ['tổng sĩ số không phải số', { totalStudentCount: 'ba mươi' }],
    ['tổng sĩ số lẻ', { totalStudentCount: '30.5' }],
  ])('%s → 400 (không 500)', async (_label, change) => {
    await expect(pipe.transform({ ...base, ...change }, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('lessonStudentCounts', () => {
  it('có tổng sĩ số: sĩ số thực tế = tổng − số vắng, bỏ qua số client gửi', () => {
    expect(
      lessonStudentCounts({ actualStudentCount: 99, totalStudentCount: 30, absentStudentNames: ['A', 'B'] }),
    ).toEqual({ actualStudentCount: 28, totalStudentCount: 30, absentStudentNames: ['A', 'B'] });
    expect(lessonStudentCounts({ actualStudentCount: 0, totalStudentCount: 30 })).toEqual({
      actualStudentCount: 30,
      totalStudentCount: 30,
      absentStudentNames: [],
    });
    expect(
      lessonStudentCounts({ actualStudentCount: 5, totalStudentCount: 2, absentStudentNames: ['A', 'B'] }),
    ).toEqual({ actualStudentCount: 0, totalStudentCount: 2, absentStudentNames: ['A', 'B'] });
  });

  it('không có tổng sĩ số (client cũ): giữ sĩ số thực tế, hai trường mới null', () => {
    expect(
      lessonStudentCounts({ actualStudentCount: 28, absentStudentNames: ['A'] }),
    ).toEqual({ actualStudentCount: 28, totalStudentCount: null, absentStudentNames: null });
  });

  it('số vắng > tổng → 400 TEACHING_SESSION_LESSON_ABSENT_EXCEEDS_TOTAL', () => {
    expect(() =>
      lessonStudentCounts({ actualStudentCount: 0, totalStudentCount: 1, absentStudentNames: ['A', 'B'] }),
    ).toThrow(
      expect.objectContaining({
        status: 400,
        response: {
          statusCode: 400,
          code: 'TEACHING_SESSION_LESSON_ABSENT_EXCEEDS_TOTAL',
          message: 'Số học sinh vắng không được vượt quá tổng sĩ số lớp.',
        },
      }),
    );
  });
});

describe('TeachingSessionService.submitLesson() — tổng sĩ số + học sinh vắng', () => {
  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

  function setup() {
    const entity: any = {
      id: 7,
      teacherId: 5,
      schoolId: 10,
      date: today,
      status: SessionStatus.SCHEDULED,
      assignmentStatus: AssignmentStatus.ASSIGNED,
      checkinAt: new Date(),
      checkoutAt: new Date(),
      lessonSubmittedAt: null,
    };
    const transactionRepo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn().mockResolvedValue(entity),
    };
    const imageRepo = { create: jest.fn((row) => row), insert: jest.fn() };
    const dataSource = {
      transaction: jest.fn(async (work: any) =>
        work({
          getRepository: (target: any) => (target === TeachingSession ? transactionRepo : imageRepo),
        }),
      ),
    };
    const storage = {
      storeMany: jest.fn().mockResolvedValue([]),
      removeMany: jest.fn().mockResolvedValue(undefined),
      publicItems: jest.fn((items: unknown[]) => items),
    };
    const teacherRepo = { findOne: jest.fn().mockResolvedValue({ id: 5, employeeId: 99 }) };
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
    const findOne = jest.spyOn(service, 'findOne').mockResolvedValue({ id: 7 } as any);
    return { service, entity, storage, findOne };
  }

  const lesson = { lessonName: 'Phép trừ', lessonEvaluation: 'Khá' };
  const file = [{} as Express.Multer.File];

  it('total=30 + 2 tên vắng → lưu total 30, actual 28, danh sách tên', async () => {
    const { service, entity, findOne } = setup();
    await expect(
      service.submitLesson(
        7,
        { ...lesson, actualStudentCount: 99, totalStudentCount: 30, absentStudentNames: ['Nguyễn Văn A', 'Trần Thị B'] },
        99,
        file,
      ),
    ).resolves.toEqual({ id: 7 });
    expect(entity).toMatchObject({
      totalStudentCount: 30,
      actualStudentCount: 28,
      absentStudentNames: ['Nguyễn Văn A', 'Trần Thị B'],
    });
    // Response là bản ghi đọc lại (đủ 2 trường mới qua toSessionItem).
    expect(findOne).toHaveBeenCalledWith(7);
  });

  it('số vắng > tổng → 400, không lưu ảnh, không ghi buổi dạy', async () => {
    const { service, entity, storage } = setup();
    await expect(
      service.submitLesson(
        7,
        { ...lesson, actualStudentCount: 0, totalStudentCount: 1, absentStudentNames: ['A', 'B'] },
        99,
        file,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'TEACHING_SESSION_LESSON_ABSENT_EXCEEDS_TOTAL' }),
    });
    expect(storage.storeMany).not.toHaveBeenCalled();
    expect(entity.lessonSubmittedAt).toBeNull();
  });

  it('request kiểu cũ → actual theo client, 2 trường mới null', async () => {
    const { service, entity } = setup();
    await service.submitLesson(7, { ...lesson, actualStudentCount: 27 }, 99, file);
    expect(entity).toMatchObject({
      actualStudentCount: 27,
      totalStudentCount: null,
      absentStudentNames: null,
    });
  });

  it('API danh sách / chi tiết trả tổng sĩ số + học sinh vắng', () => {
    const { service } = setup();
    const toItem = (row: Record<string, unknown>) =>
      (service as any).toSessionItem({ id: 7, date: today, schoolId: 10, subjectId: 3, ...row });
    expect(
      toItem({ actualStudentCount: 28, totalStudentCount: '30', absentStudentNames: ['A', 'B'] }),
    ).toMatchObject({ actualStudentCount: 28, totalStudentCount: 30, absentStudentNames: ['A', 'B'] });
    expect(toItem({ actualStudentCount: 27, totalStudentCount: null, absentStudentNames: null })).toMatchObject({
      actualStudentCount: 27,
      totalStudentCount: null,
      absentStudentNames: null,
    });
  });

  it('câu query danh sách / chi tiết chọn 2 cột mới', () => {
    const qb: any = new Proxy(
      {},
      { get: (target: any, key) => (key in target ? target[key] : (target[key] = jest.fn(() => qb))) },
    );
    const service = new TeachingSessionService(
      { createQueryBuilder: () => qb } as any,
      ...(Array(10).fill({}) as [any, any, any, any, any, any, any, any, any, any]),
    );
    (service as any).buildSessionQuery();
    const selected = qb.select.mock.calls.flat(2);
    expect(selected).toEqual(
      expect.arrayContaining([
        'ss.totalStudentCount AS "totalStudentCount"',
        'ss.absentStudentNames AS "absentStudentNames"',
      ]),
    );
  });
});
