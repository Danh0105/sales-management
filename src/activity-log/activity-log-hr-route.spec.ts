import { Controller } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
  ActivityLogInterceptor,
  isMetadataOnlyRoute,
} from './activity-log.interceptor';

/**
 * `/api/hr/v1/**` chỉ ghi metadata vào `public.activity_log` — không body,
 * params, query, dữ liệu trước/sau, response hay message lỗi.
 */

const CCCD = '079201001234';
const BANK = '0071000123456';

@Controller('api/hr/v1/employees')
class FakeHrController {}

@Controller('teachers')
class FakeLegacyController {}

function contextOf(req: any, controller: any, statusCode = 200) {
  return {
    getType: () => 'http',
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  } as any;
}

function setup(row: any = null) {
  const record = jest.fn().mockResolvedValue(undefined);
  const findOne = jest.fn().mockResolvedValue(row);
  const interceptor = new ActivityLogInterceptor(
    { record } as any,
    { getRepository: () => ({ findOne, find: jest.fn() }) } as any,
  );
  return { interceptor, record, findOne };
}

const handler = (obs: any) => ({ handle: () => obs });
const flush = () => new Promise((r) => setTimeout(r, 0));
const hrUser = { id: 7, name: 'Nhân sự', roles: ['nhansu'] };

describe('isMetadataOnlyRoute', () => {
  it.each([
    ['/api/hr/v1/employees/5/identity-documents', true],
    ['/api/hr/v1/employees?x=1', true],
    ['/API/HR/V1/employees', true], // Express khớp route không phân biệt hoa thường
    ['//api//hr/v1/employees', true],
    ['/api/hr/%76%31/employees', true],
    ['/api/hr/v2/employees', false],
    ['/api/hrx/v1/employees', false],
    ['/api/other', false],
    ['/teachers/12', false],
    ['/hr/v1/employees', false],
  ])('%s → %s', (url, expected) => {
    expect(isMetadataOnlyRoute(url)).toBe(expected);
  });

  it('nhận theo path khai báo của controller dù URL lạ', () => {
    expect(isMetadataOnlyRoute('/x', 'api/hr/v1/employees')).toBe(true);
    expect(isMetadataOnlyRoute('/x', 'teachers')).toBe(false);
  });
});

describe('ActivityLogInterceptor — route HR chỉ ghi metadata', () => {
  it('[1] POST CCCD: plaintext không có trong activity_log, không đọc response', async () => {
    const { interceptor, record, findOne } = setup();
    const req = {
      method: 'POST',
      originalUrl: '/api/hr/v1/employees/5/identity-documents?note=' + CCCD,
      params: { employeeId: '5' },
      query: { note: CCCD },
      body: { documentType: 'CCCD', number: CCCD },
      ip: '10.0.0.1',
      user: hrUser,
    };
    await lastValueFrom(
      interceptor.intercept(
        contextOf(req, FakeHrController, 201),
        handler(of({ id: 1, numberMasked: '********1234', number: CCCD })),
      ),
    );
    await flush();

    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorId: 7,
      method: 'POST',
      path: '/api/hr/v1/employees/5/identity-documents',
      success: true,
      statusCode: 201,
      body: null,
      params: null,
      query: null,
    });
    expect(entry).not.toHaveProperty('context');
    expect(entry).not.toHaveProperty('afterData');
    expect(JSON.stringify(entry)).not.toContain(CCCD);
    expect(JSON.stringify(entry)).not.toContain('1234');
    expect(findOne).not.toHaveBeenCalled();
  });

  it('[2] PATCH bank: số tài khoản không có trong activity_log, không chụp bản ghi cũ', async () => {
    const { interceptor, record, findOne } = setup({
      id: 5,
      accountNumber: BANK,
    });
    const req = {
      method: 'PATCH',
      originalUrl: '/api/hr/v1/employees/5/bank-account',
      params: { employeeId: '5' },
      query: {},
      body: { accountNumber: BANK, version: 1 },
      user: hrUser,
    };
    await lastValueFrom(
      interceptor.intercept(
        contextOf(req, FakeHrController),
        handler(of({ ok: true })),
      ),
    );
    await flush();
    const dump = JSON.stringify(record.mock.calls);
    expect(dump).not.toContain(BANK);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('[3] request HR không nhạy cảm cũng không ghi raw body', async () => {
    const { interceptor, record } = setup();
    const req = {
      method: 'POST',
      originalUrl: '/api/hr/v1/employees',
      body: { employeeCode: 'NV001', fullName: 'Nguyễn Văn A' },
      user: hrUser,
    };
    await lastValueFrom(
      interceptor.intercept(
        contextOf(req, FakeHrController),
        handler(of({ id: 1 })),
      ),
    );
    await flush();
    expect(record.mock.calls[0][0].body).toBeNull();
    expect(JSON.stringify(record.mock.calls)).not.toContain('Nguyễn Văn A');
  });

  it('lỗi ở route HR: ghi status, KHÔNG ghi message lỗi', async () => {
    const { interceptor, record } = setup();
    const req = {
      method: 'POST',
      originalUrl: '/api/hr/v1/employees/5/identity-documents',
      body: { number: CCCD },
      user: hrUser,
    };
    await lastValueFrom(
      interceptor.intercept(
        contextOf(req, FakeHrController),
        handler(
          throwError(() =>
            Object.assign(new Error(`trùng ${CCCD}`), { status: 409 }),
          ),
        ),
      ),
    ).catch(() => undefined);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 409,
        errorMessage: null,
        body: null,
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(CCCD);
  });

  it('URL viết hoa vẫn bị nhận là route HR', async () => {
    const { interceptor, record } = setup();
    const req = {
      method: 'POST',
      originalUrl: '/API/HR/V1/employees/5/identity-documents',
      body: { number: CCCD },
      user: hrUser,
    };
    await lastValueFrom(
      interceptor.intercept(contextOf(req, FakeHrController), handler(of({}))),
    );
    await flush();
    expect(JSON.stringify(record.mock.calls)).not.toContain(CCCD);
  });

  it('[4] module cũ giữ nguyên hành vi: vẫn ghi body và chụp bản ghi', async () => {
    const { interceptor, record, findOne } = setup({ id: 12, name: 'Cũ' });
    const req = {
      method: 'PATCH',
      originalUrl: '/teachers/12',
      params: { id: '12' },
      query: {},
      body: { name: 'Mới' },
      user: { id: 9, name: 'Giáo vụ', roles: ['giaovu'] },
    };
    await lastValueFrom(
      interceptor.intercept(
        contextOf(req, FakeLegacyController),
        handler(of({ ok: true })),
      ),
    );
    await flush();
    const entry = record.mock.calls[0][0];
    expect(entry.body).toEqual({ name: 'Mới' });
    expect(entry.resource).toBe('teachers');
    expect(findOne).toHaveBeenCalled();
  });
});
