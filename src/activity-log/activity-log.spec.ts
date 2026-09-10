import { lastValueFrom, of, throwError } from 'rxjs';
import { ActivityLogInterceptor } from './activity-log.interceptor';
import { ActivityLogService } from './activity-log.service';
import {
  sanitizeBody,
  stripRowFields,
  flattenRelationNames,
  pickFields,
  collectIds,
  capPayload,
  resourceOf,
  describeFiles,
  extractContext,
  diffSnapshots,
} from './activity-log.util';

/** DataSource giả: `row` là bản ghi mà repository trả về. */
function dataSourceOf(row: any) {
  return {
    getRepository: () => ({ findOne: jest.fn().mockResolvedValue(row) }),
  } as any;
}

function contextOf(req: any, statusCode = 200) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  } as any;
}

const reqOf = (over: any = {}) => ({
  method: 'PATCH',
  originalUrl: '/teachers/12?x=1',
  params: { id: '12' },
  query: { x: '1' },
  body: { name: 'A' },
  ip: '10.0.0.1',
  user: { id: 9, name: 'Giáo vụ', roles: ['giaovu'] },
  ...over,
});

describe('sanitizeBody', () => {
  it('che mật khẩu ở mọi cấp', () => {
    const out = sanitizeBody({ password: 'x', nested: { newPassword: 'y', name: 'A' } });
    expect(out.password).toBe('***');
    expect(out.nested.newPassword).toBe('***');
    expect(out.nested.name).toBe('A');
  });

  it('cắt mảng dài và chuỗi dài', () => {
    const arr = sanitizeBody(Array.from({ length: 250 }, (_, i) => i));
    expect(arr).toHaveLength(201);
    expect(String(arr[200])).toContain('50');
    expect(sanitizeBody('a'.repeat(2500))).toContain('cắt bớt');
  });
});

describe('capPayload', () => {
  it('thay payload quá lớn bằng cờ _truncated', () => {
    const big = { blob: 'a'.repeat(30_000) };
    expect(capPayload(big)._truncated).toBe(true);
    expect(capPayload({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('resourceOf / describeFiles', () => {
  it('lấy đoạn đầu của path', () => {
    expect(resourceOf('/teachers/12/approve?x=1')).toBe('teachers');
  });

  it('chỉ ghi metadata của file', () => {
    const files = describeFiles({ file: { fieldname: 'f', originalname: 'a.png', size: 3, mimetype: 'image/png' } });
    expect(files).toEqual([{ field: 'f', name: 'a.png', size: 3, mimetype: 'image/png' }]);
    expect(describeFiles({})).toBeNull();
  });
});

describe('ActivityLogInterceptor', () => {
  const handler = (obs: any) => ({ handle: () => obs });

  it('ghi log request ghi dữ liệu của giáo vụ', async () => {
    const service = { record: jest.fn().mockResolvedValue(undefined) } as any;
    const interceptor = new ActivityLogInterceptor(service, dataSourceOf(null));

    await lastValueFrom(
      interceptor.intercept(contextOf(reqOf()), handler(of({ ok: true }))),
    );

    // record() chạy sau khi đọc lại bản ghi -> đợi hết microtask.
    await new Promise((r) => setTimeout(r, 0));

    expect(service.record).toHaveBeenCalledTimes(1);
    const entry = service.record.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorId: 9,
      method: 'PATCH',
      path: '/teachers/12',
      resource: 'teachers',
      success: true,
      statusCode: 200,
    });
  });

  it('vẫn ghi log khi request lỗi', async () => {
    const service = { record: jest.fn() } as any;
    const interceptor = new ActivityLogInterceptor(service, dataSourceOf(null));

    await lastValueFrom(
      interceptor.intercept(
        contextOf(reqOf()),
        handler(throwError(() => Object.assign(new Error('Cấm'), { status: 403 }))),
      ),
    ).catch(() => undefined);

    expect(service.record).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: 403, errorMessage: 'Cấm' }),
    );
  });

  it('bỏ qua GET, khách vãng lai và role khác', async () => {
    const service = { record: jest.fn() } as any;
    const interceptor = new ActivityLogInterceptor(service, dataSourceOf(null));

    for (const req of [
      reqOf({ method: 'GET' }),
      reqOf({ user: undefined }),
      reqOf({ user: { id: 3, roles: ['sales'] } }),
    ]) {
      await lastValueFrom(interceptor.intercept(contextOf(req), handler(of(1))));
    }

    expect(service.record).not.toHaveBeenCalled();
  });

  it('ghi log cả nhân sự', async () => {
    const service = { record: jest.fn() } as any;
    const interceptor = new ActivityLogInterceptor(service, dataSourceOf(null));

    await lastValueFrom(
      interceptor.intercept(
        contextOf(reqOf({ user: { id: 4, roles: ['nhansu'] }, body: { password: 'p' } })),
        handler(of(1)),
      ),
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(service.record.mock.calls[0][0].body.password).toBe('***');
  });
});

describe('extractContext', () => {
  const session = {
    id: 128,
    date: '2026-09-09',
    startTime: '07:00',
    endTime: '07:45',
    periods: 1,
    school: { id: 3, name: 'THCS Chi Lăng' },
    class: { id: 9, name: '6A1', schoolYear: '2026-2027' },
    teacher: { id: 5, name: 'Nguyễn Văn A' },
    subject: { id: 2, name: 'STEM' },
  };

  it('lấy tên trường/lớp/giáo viên/môn và giờ tiết từ response', () => {
    expect(extractContext(session, {})).toEqual({
      schoolName: 'THCS Chi Lăng',
      className: '6A1',
      teacherName: 'Nguyễn Văn A',
      subjectName: 'STEM',
      schoolYear: '2026-2027',
      date: '2026-09-09',
      startTime: '07:00',
      endTime: '07:45',
      periods: 1,
    });
  });

  it('ghi số lượng cho endpoint hàng loạt', () => {
    const ctx = extractContext([session, session], {});
    expect(ctx?.itemCount).toBe(2);
    expect(ctx?.className).toBe('6A1');
  });

  it('quan hệ cấp nông thắng cấp sâu', () => {
    const ctx = extractContext(
      { school: { name: 'Trường A' }, schedule: { school: { name: 'Trường B' } } },
      {},
    );
    expect(ctx?.schoolName).toBe('Trường A');
  });

  it('bù từ body khi response rỗng (endpoint xoá)', () => {
    expect(extractContext(undefined, { school: { name: 'Trường C' } })?.schoolName).toBe(
      'Trường C',
    );
    expect(extractContext(undefined, {})).toBeNull();
  });
});

describe('diffSnapshots', () => {
  it('chỉ giữ field thực sự đổi', () => {
    const changes = diffSnapshots(
      { id: 1, name: 'A', phone: '090', note: null },
      { id: 1, name: 'B', phone: '090', note: null },
    );
    expect(changes).toEqual([{ field: 'name', before: 'A', after: 'B' }]);
  });

  it('bỏ qua dấu thời gian và coi 12 với "12" là một', () => {
    const changes = diffSnapshots(
      { updatedAt: '2026-01-01', amount: 12 },
      { updatedAt: '2026-09-09', amount: '12' },
      ['updatedAt'],
    );
    expect(changes).toEqual([]);
  });

  it('bản ghi bị xoá: mọi field đều là before', () => {
    const changes = diffSnapshots({ id: 3, name: 'A' }, null);
    expect(changes).toContainEqual({ field: 'name', before: 'A', after: null });
  });
});

describe('ActivityLogInterceptor — dữ liệu cũ / mới', () => {
  const handler = (obs: any) => ({ handle: () => obs });

  it('chụp bản ghi trước và sau, kèm danh sách field đã đổi', async () => {
    const service = { record: jest.fn() } as any;
    // Cùng một repository giả trả bản ghi khác nhau ở lần đọc trước và sau.
    let call = 0;
    const dataSource = {
      getRepository: () => ({
        findOne: jest.fn().mockImplementation(() =>
          Promise.resolve(
            call++ === 0 ? { id: 12, name: 'A' } : { id: 12, name: 'B' },
          ),
        ),
      }),
    } as any;

    const interceptor = new ActivityLogInterceptor(service, dataSource);
    await lastValueFrom(
      interceptor.intercept(contextOf(reqOf()), handler(of({ id: 12 }))),
    );
    // record() được gọi trong tap, sau await của loadRow lần 2.
    await new Promise((r) => setTimeout(r, 0));

    const entry = service.record.mock.calls[0][0];
    expect(entry.beforeData).toEqual({ id: 12, name: 'A' });
    expect(entry.afterData).toEqual({ id: 12, name: 'B' });
    expect(entry.changes).toEqual([{ field: 'name', before: 'A', after: 'B' }]);
  });

  it('POST không chụp dữ liệu cũ', async () => {
    const service = { record: jest.fn() } as any;
    const interceptor = new ActivityLogInterceptor(
      service,
      dataSourceOf({ id: 1, name: 'A' }),
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(reqOf({ method: 'POST', originalUrl: '/teachers' })),
        handler(of({ id: 1 })),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(service.record.mock.calls[0][0].beforeData).toBeNull();
  });
});

describe('ActivityLogInterceptor — bỏ qua thao tác không phải nghiệp vụ', () => {
  const handler = (obs: any) => ({ handle: () => obs });

  it.each([
    ['/employee-fcm-token', 'đăng ký token thông báo'],
    ['/teachers/candidates', 'tra cứu giáo viên phù hợp'],
    ['/activity-logs', 'chính nhật ký'],
  ])('không ghi %s (%s)', async (url) => {
    const service = { record: jest.fn() } as any;
    const interceptor = new ActivityLogInterceptor(service, dataSourceOf(null));

    await lastValueFrom(
      interceptor.intercept(
        contextOf(reqOf({ method: 'POST', originalUrl: url })),
        handler(of(1)),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(service.record).not.toHaveBeenCalled();
  });

  it('tra tên trường/môn từ id trong body', async () => {
    const service = { record: jest.fn() } as any;
    const interceptor = new ActivityLogInterceptor(
      service,
      dataSourceOf({ id: 448, name: 'THCS Chi Lăng' }),
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(
          reqOf({
            method: 'POST',
            originalUrl: '/teaching-schedules',
            body: { schoolId: 448, subjectId: 527 },
          }),
        ),
        handler(of({ id: 9 })),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    const ctx = service.record.mock.calls[0][0].context;
    expect(ctx.schoolName).toBe('THCS Chi Lăng');
    expect(ctx.subjectName).toBe('THCS Chi Lăng');
  });
});

describe('ActivityLogInterceptor — bảng con (bảng tiết)', () => {
  const handler = (obs: any) => ({ handle: () => obs });

  /** `find` trả bảng tiết trước rồi sau; `findOne` trả bản ghi trường. */
  function periodDataSource(before: any[], after: any[]) {
    let call = 0;
    return {
      getRepository: () => ({
        find: jest
          .fn()
          .mockImplementation(() => Promise.resolve(call++ === 0 ? before : after)),
        findOne: jest.fn().mockResolvedValue({ id: 365, name: 'THCS Chi Lăng' }),
      }),
    } as any;
  }

  const period = (periodNo: number, startTime: string) => ({
    id: periodNo,
    schoolId: 365,
    periodNo,
    startTime,
    endTime: '07:45',
    updatedAt: new Date('2026-01-01'),
  });

  it('PUT /schools/:id/periods chụp mảng trước/sau chứ không phải bản ghi trường', async () => {
    const service = { record: jest.fn() } as any;
    const interceptor = new ActivityLogInterceptor(
      service,
      periodDataSource([period(1, '07:00')], [period(1, '07:15')]),
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(
          reqOf({
            method: 'PUT',
            originalUrl: '/schools/365/periods',
            body: { periods: [{ periodNo: 1, startTime: '07:15' }] },
          }),
        ),
        handler(of({ periods: [] })),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    const entry = service.record.mock.calls[0][0];
    expect(entry.beforeData.periods[0].startTime).toBe('07:00');
    expect(entry.afterData.periods[0].startTime).toBe('07:15');
    expect(entry.changes).toHaveLength(1);
    expect(entry.changes[0].field).toBe('periods');
    // Nguyên cả mảng, không phải số lượng phần tử.
    expect(entry.changes[0].before[0].periodNo).toBe(1);
    expect(entry.changes[0].after[0].startTime).toBe('07:15');
  });

  it('bảng tiết không đổi thì không sinh dòng "đã đổi" nào', async () => {
    const service = { record: jest.fn() } as any;
    const interceptor = new ActivityLogInterceptor(
      service,
      // Cùng nội dung nhưng id và updatedAt khác — service xoá rồi ghi lại.
      periodDataSource(
        [period(1, '07:00')],
        [{ ...period(1, '07:00'), id: 99, updatedAt: new Date('2026-09-09') }],
      ),
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(reqOf({ method: 'PUT', originalUrl: '/schools/365/periods' })),
        handler(of({ periods: [] })),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(service.record.mock.calls[0][0].changes).toBeNull();
  });
});

describe('stripRowFields', () => {
  it('cắt id và dấu thời gian khỏi từng dòng', () => {
    expect(
      stripRowFields([{ id: 1, periodNo: 2, updatedAt: 'x' }], ['id', 'updatedAt']),
    ).toEqual([{ periodNo: 2 }]);
  });
});

describe('flattenRelationNames', () => {
  it('rút quan hệ thành tên phẳng và bỏ object gốc', () => {
    expect(
      flattenRelationNames({
        id: 7,
        schoolId: 448,
        school: { id: 448, name: 'Trường Tiểu học A' },
        class: { id: 91, name: '8/1', schoolYear: '2026-2027' },
        startTime: '09:15',
      }),
    ).toEqual({
      id: 7,
      schoolId: 448,
      schoolName: 'Trường Tiểu học A',
      className: '8/1',
      schoolYear: '2026-2027',
      startTime: '09:15',
    });
  });

  it('quan hệ null hoặc không có tên thì bỏ, không nhồi object vào log', () => {
    expect(flattenRelationNames({ id: 1, class: null, subject: { id: 5 } })).toEqual({
      id: 1,
      class: null,
      subject: undefined,
    });
  });
});

describe('ActivityLogInterceptor — xoá lịch dạy', () => {
  const handler = (obs: any) => ({ handle: () => obs });

  const schedule = {
    id: 7,
    schoolId: 448,
    school: { id: 448, name: 'Trường Tiểu học A' },
    class: { id: 91, name: '8/1', schoolYear: '2026-2027' },
    subject: { id: 5, name: 'Tiếng Anh' },
    teacher: { id: 3, name: 'Nguyễn Ngọc Phương Nghi' },
    dayOfWeek: 2,
    startTime: '09:15',
    endTime: '10:00',
  };

  it('chụp đủ tên trường/lớp/môn/giáo viên vào beforeData và context', async () => {
    const service = { record: jest.fn() } as any;
    const findOne = jest.fn().mockResolvedValue(schedule);
    const interceptor = new ActivityLogInterceptor(
      service,
      { getRepository: () => ({ findOne }) } as any,
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(
          reqOf({
            method: 'DELETE',
            originalUrl: '/teaching-schedules/7',
            body: {},
          }),
        ),
        handler(of({ deleted: true })),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    const entry = service.record.mock.calls[0][0];
    expect(entry.beforeData).toMatchObject({
      schoolId: 448,
      schoolName: 'Trường Tiểu học A',
      className: '8/1',
      subjectName: 'Tiếng Anh',
      teacherName: 'Nguyễn Ngọc Phương Nghi',
      dayOfWeek: 2,
      startTime: '09:15',
      endTime: '10:00',
    });
    expect(entry.context).toMatchObject({
      schoolName: 'Trường Tiểu học A',
      className: '8/1',
      subjectName: 'Tiếng Anh',
      teacherName: 'Nguyễn Ngọc Phương Nghi',
      startTime: '09:15',
      endTime: '10:00',
    });
    // Bản ghi phải đọc TRƯỚC khi xoá; sau khi xoá không còn gì để chụp.
    expect(entry.afterData).toBeNull();
    // Quan hệ được nạp kèm, không phải bản ghi trơ id.
    expect(findOne.mock.calls[0][0].relations).toEqual([
      'school',
      'class',
      'subject',
      'teacher',
    ]);
  });
});

describe('pickFields', () => {
  it('giữ đúng field đã khai, bỏ field thiếu', () => {
    expect(pickFields({ a: 1, b: 2, c: null }, ['a', 'c', 'z'])).toEqual({
      a: 1,
      c: null,
    });
  });
});

describe('ActivityLogInterceptor — tạo lịch dạy hàng loạt', () => {
  const handler = (obs: any) => ({ handle: () => obs });

  const row = (id: number, className: string) => ({
    id,
    schoolId: 448,
    school: { id: 448, name: 'Trường Tiểu học A' },
    classId: 81,
    class: { id: 81, name: className, schoolYear: '2026-2027' },
    subjectId: 886,
    subject: { id: 886, name: 'Tiếng Anh' },
    teacherId: 17,
    teacher: { id: 17, name: 'Nguyễn Ngọc Phương Nghi' },
    dayOfWeek: 6,
    startTime: '14:10',
    endTime: '14:45',
    periods: 1,
    note: 'ghi chú dài không cần trong nhật ký',
    createdAt: new Date(),
  });

  const bulkReq = (over: any = {}) =>
    reqOf({
      method: 'POST',
      originalUrl: '/teaching-schedules/bulk',
      body: { teacherId: 17, items: [{ classId: 81 }] },
      ...over,
    });

  it('đọc lại các lịch vừa tạo và chốt đủ tên trường/lớp/môn/giáo viên', async () => {
    const service = { record: jest.fn() } as any;
    const find = jest.fn().mockResolvedValue([row(31, '8/1'), row(32, '8/2')]);
    const interceptor = new ActivityLogInterceptor(
      service,
      { getRepository: () => ({ find, findOne: jest.fn() }) } as any,
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(bulkReq()),
        handler(
          of({
            created: 2,
            results: [
              { scheduleId: 31, status: 'CREATED' },
              { scheduleId: 32, status: 'CREATED' },
            ],
          }),
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    const entry = service.record.mock.calls[0][0];
    expect(entry.afterData.schedules).toHaveLength(2);
    expect(entry.afterData.schedules[0]).toEqual({
      schoolId: 448,
      schoolName: 'Trường Tiểu học A',
      classId: 81,
      className: '8/1',
      subjectId: 886,
      subjectName: 'Tiếng Anh',
      teacherId: 17,
      teacherName: 'Nguyễn Ngọc Phương Nghi',
      dayOfWeek: 6,
      startTime: '14:10',
      endTime: '14:45',
      periods: 1,
    });
    // Đọc lại theo id trong response, không tin payload.
    expect(find.mock.calls[0][0].where.id._value).toEqual([31, 32]);
  });

  it('dòng SKIPPED không có scheduleId thì không được chụp nhầm', async () => {
    const service = { record: jest.fn() } as any;
    const find = jest.fn().mockResolvedValue([row(31, '8/1')]);
    const interceptor = new ActivityLogInterceptor(
      service,
      { getRepository: () => ({ find, findOne: jest.fn() }) } as any,
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(bulkReq()),
        handler(
          of({
            results: [
              { scheduleId: 31, status: 'CREATED' },
              { classId: 82, status: 'SKIPPED', reason: 'Lớp học không tồn tại' },
            ],
          }),
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(find.mock.calls[0][0].where.id._value).toEqual([31]);
  });

  it('cả lô bị bỏ qua thì ghi mảng rỗng, không đọc DB', async () => {
    const service = { record: jest.fn() } as any;
    const find = jest.fn();
    const interceptor = new ActivityLogInterceptor(
      service,
      { getRepository: () => ({ find, findOne: jest.fn() }) } as any,
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(bulkReq()),
        handler(of({ created: 0, results: [{ classId: 82, status: 'SKIPPED' }] })),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(service.record.mock.calls[0][0].afterData).toEqual({ schedules: [] });
    expect(find).not.toHaveBeenCalled();
  });
});

describe('collectIds', () => {
  it('gom id trong mảng, bỏ trùng', () => {
    expect(
      collectIds(
        { schedules: [{ schoolId: 448 }, { schoolId: 365 }, { schoolId: 448 }] },
        'schoolId',
      ),
    ).toEqual([448, 365]);
  });

  it('bỏ qua id không hợp lệ', () => {
    expect(collectIds({ schoolId: null, a: { schoolId: 0 } }, 'schoolId')).toEqual([]);
  });
});

describe('ActivityLogInterceptor — id để lọc', () => {
  const handler = (obs: any) => ({ handle: () => obs });

  it('lô nhiều trường thì ghi cả mảng, không chỉ id đầu tiên', async () => {
    const service = { record: jest.fn() } as any;
    const find = jest.fn().mockResolvedValue([
      { id: 1, schoolId: 448, teacherId: 17 },
      { id: 2, schoolId: 365, teacherId: 17 },
    ]);
    const interceptor = new ActivityLogInterceptor(
      service,
      { getRepository: () => ({ find, findOne: jest.fn() }) } as any,
    );

    await lastValueFrom(
      interceptor.intercept(
        contextOf(
          reqOf({
            method: 'POST',
            originalUrl: '/teaching-schedules/bulk',
            body: {},
          }),
        ),
        handler(
          of({ results: [{ scheduleId: 1 }, { scheduleId: 2 }] }),
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    const ctx = service.record.mock.calls[0][0].context;
    expect(ctx.schoolIds).toEqual([448, 365]);
    // Nhiều trường thì không có field số ít.
    expect(ctx.schoolId).toBeUndefined();
    // Đúng một giáo viên thì có cả hai dạng.
    expect(ctx.teacherIds).toEqual([17]);
    expect(ctx.teacherId).toBe(17);
  });
});

describe('ActivityLogService.find — lọc theo trường / giáo viên', () => {
  function qbSpy() {
    const qb: any = {
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      addOrderBy: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      take: jest.fn(() => qb),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    return qb;
  }

  const serviceWith = (qb: any) =>
    new ActivityLogService({ createQueryBuilder: () => qb } as any);

  it('không gửi filter thì không thêm điều kiện context nào', async () => {
    const qb = qbSpy();
    await serviceWith(qb).find({});
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('gửi cả hai thì áp đồng thời và vẫn phân trang', async () => {
    const qb = qbSpy();
    const result = await serviceWith(qb).find({
      schoolId: 448,
      teacherId: 17,
      page: 2,
      limit: 10,
    });

    const sql = qb.andWhere.mock.calls.map((c: any[]) => c[0]).join(' ');
    expect(sql).toContain("log.context -> 'schoolIds'");
    expect(sql).toContain("log.context -> 'teacherIds'");
    expect(qb.andWhere.mock.calls[0][1]).toEqual({
      schoolIds: '[448]',
      schoolId: '448',
    });
    expect(qb.skip).toHaveBeenCalledWith(10);
    expect(qb.take).toHaveBeenCalledWith(10);
    // `total` là tổng SAU khi lọc, lấy từ chính câu đã áp điều kiện.
    expect(result).toEqual({ data: [], total: 0, page: 2, limit: 10 });
  });
});
