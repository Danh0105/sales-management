import { DataSource } from 'typeorm';

import { REFUSE_PRODUCTION_DB_ERROR } from '../src/database/database-options';

/**
 * Chứng minh test không thể chạm DB production. Viết sao cho kể cả khi guard
 * hỏng cũng không có gì chạm `sales_db`:
 * - AppModule chỉ được **import**, không `compile()` — TypeORM chưa kết nối;
 * - DataSource trỏ `127.0.0.1:1` — không có gì lắng nghe ở đó.
 */
describe('Production database safety guard (e2e)', () => {
  const savedDbName = process.env.DB_NAME;

  beforeAll(() => {
    delete process.env.DB_NAME;
  });

  afterAll(() => {
    if (savedDbName === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = savedDbName;
  });

  it('import AppModule trong test mà DB là sales_db → lỗi ngay, trước khi kết nối', () => {
    expect(() =>
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../src/app.module');
      }),
    ).toThrow(REFUSE_PRODUCTION_DB_ERROR);
  });

  it('mọi DataSource trỏ sales_db trong Jest đều bị chặn (setupFiles)', async () => {
    const ds = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port: 1,
      username: 'postgres',
      password: 'postgres',
      database: 'sales_db',
      synchronize: true,
    });
    await expect(ds.initialize()).rejects.toThrow(REFUSE_PRODUCTION_DB_ERROR);
    expect(ds.isInitialized).toBe(false);
  });

  it('database khác sales_db thì guard cho qua (lỗi là do không có server ở cổng 1)', async () => {
    const ds = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port: 1,
      username: 'postgres',
      password: 'postgres',
      database: 'sales_db_test',
      connectTimeoutMS: 2000,
    });
    const error = await ds.initialize().then(
      () => null,
      (e: unknown) => e as { message?: string; code?: string },
    );
    expect(error).not.toBeNull();
    expect(error?.message).not.toContain(REFUSE_PRODUCTION_DB_ERROR);
    expect(error?.code ?? error?.message).toMatch(/ECONNREFUSED/);
  });
});
