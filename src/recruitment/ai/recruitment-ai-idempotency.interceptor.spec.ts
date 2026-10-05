import { lastValueFrom, of, throwError } from 'rxjs';

import { IdempotencyStatus } from '../recruitment.enums';
import {
  hashRequest,
  RecruitmentAiIdempotencyInterceptor,
} from './recruitment-ai-idempotency.interceptor';

/** Repo trong bộ nhớ có unique (key, endpoint) như bảng thật. */
function memoryRepo() {
  const rows: any[] = [];
  let seq = 0;
  const match = (where: any) => (r: any) =>
    Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    rows,
    findOne: jest.fn(async ({ where }) => rows.find(match(where)) ?? null),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => {
      if (
        rows.some(
          (r) =>
            r.idempotencyKey === v.idempotencyKey && r.endpoint === v.endpoint,
        )
      ) {
        throw { code: '23505' };
      }
      const row = { id: ++seq, createdAt: new Date(), ...v };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ id }, patch) => {
      Object.assign(
        rows.find((r) => r.id === id),
        patch,
      );
    }),
    delete: jest.fn(async ({ id }) => {
      rows.splice(
        rows.findIndex((r) => r.id === id),
        1,
      );
    }),
  };
}

function setup(required = false) {
  const repo = memoryRepo();
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as any;
  const interceptor = new RecruitmentAiIdempotencyInterceptor(
    repo as any,
    reflector,
  );
  return { repo, interceptor };
}

function ctx(
  key: string | undefined,
  body: unknown = { applicationId: 12, slotId: 3 },
) {
  const res = { setHeader: jest.fn() };
  const req = {
    method: 'POST',
    headers: key === undefined ? {} : { 'idempotency-key': key },
    route: { path: '/recruitment/ai/interviews/propose' },
    params: {},
    body,
  };
  return {
    res,
    context: {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as any,
  };
}

async function run(
  interceptor: RecruitmentAiIdempotencyInterceptor,
  c: any,
  handle: () => any,
) {
  const handler = { handle: jest.fn(handle) };
  const result = await lastValueFrom(
    await interceptor.intercept(c.context, handler),
  );
  return { result, handler };
}

describe('RecruitmentAiIdempotencyInterceptor', () => {
  it('retry cùng key + cùng body → trả response cũ, handler không chạy lại', async () => {
    const { interceptor, repo } = setup(true);
    const first = await run(interceptor, ctx('key-abc-123'), () =>
      of({ interview: { id: 5 } }),
    );
    expect(first.result).toEqual({ interview: { id: 5 } });
    expect(repo.rows[0].status).toBe(IdempotencyStatus.COMPLETED);

    const retry = ctx('key-abc-123');
    const second = await run(interceptor, retry, () =>
      of({ interview: { id: 6 } }),
    );

    expect(second.result).toEqual({ interview: { id: 5 } });
    expect(second.handler.handle).not.toHaveBeenCalled();
    expect(retry.res.setHeader).toHaveBeenCalledWith(
      'Idempotent-Replayed',
      'true',
    );
  });

  it('cùng key nhưng body khác → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const { interceptor } = setup(true);
    await run(interceptor, ctx('key-abc-123'), () => of({ ok: true }));

    await expect(
      run(
        interceptor,
        ctx('key-abc-123', { applicationId: 12, slotId: 4 }),
        () => of({}),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }),
    });
  });

  it('request trước còn đang chạy → 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const { interceptor, repo } = setup(true);
    repo.rows.push({
      id: 1,
      idempotencyKey: 'key-abc-123',
      endpoint: 'POST /recruitment/ai/interviews/propose',
      requestHash: hashRequest({}, { applicationId: 12, slotId: 3 }),
      status: IdempotencyStatus.IN_PROGRESS,
      createdAt: new Date(),
    });

    await expect(
      run(interceptor, ctx('key-abc-123'), () => of({})),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IDEMPOTENCY_IN_PROGRESS' }),
    });
  });

  it('handler lỗi → xoá key để retry chạy lại được', async () => {
    const { interceptor, repo } = setup(true);

    await expect(
      run(interceptor, ctx('key-abc-123'), () =>
        throwError(() => new Error('slot hết chỗ')),
      ),
    ).rejects.toThrow('slot hết chỗ');
    expect(repo.rows).toHaveLength(0);

    const retry = await run(interceptor, ctx('key-abc-123'), () =>
      of({ ok: true }),
    );
    expect(retry.result).toEqual({ ok: true });
  });

  it('endpoint bắt buộc mà thiếu header → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const { interceptor } = setup(true);
    await expect(
      run(interceptor, ctx(undefined), () => of({})),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }),
    });
  });

  it('endpoint không bắt buộc và không gửi header → chạy bình thường, không ghi gì', async () => {
    const { interceptor, repo } = setup(false);
    const { result } = await run(interceptor, ctx(undefined), () =>
      of({ ok: true }),
    );
    expect(result).toEqual({ ok: true });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('key sai định dạng → 400', async () => {
    const { interceptor } = setup(false);
    await expect(
      run(interceptor, ctx('x'), () => of({})),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY' }),
    });
  });

  it('hash không phụ thuộc thứ tự khoá trong body', () => {
    expect(hashRequest({}, { a: 1, b: { c: 2, d: 3 } })).toBe(
      hashRequest({}, { b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});
