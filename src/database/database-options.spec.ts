import {
  assertSafeDatabaseTarget,
  isTestRun,
  REFUSE_PRODUCTION_DB_ERROR,
  resolveDatabaseOptions,
} from './database-options';

const PRODUCTION_ENV = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const DEV_ENV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('resolveDatabaseOptions', () => {
  it('production không đặt biến nào → giữ nguyên cấu hình cứng trước đây', () => {
    expect(resolveDatabaseOptions(PRODUCTION_ENV)).toEqual({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
      database: 'sales_db',
      autoLoadEntities: true,
      synchronize: true,
    });
    expect(resolveDatabaseOptions(DEV_ENV)).toMatchObject({
      database: 'sales_db',
      synchronize: true,
    });
  });

  it('NODE_ENV=test + sales_db (mặc định hoặc đặt tường minh) → từ chối', () => {
    expect(() => resolveDatabaseOptions({ NODE_ENV: 'test' })).toThrow(
      REFUSE_PRODUCTION_DB_ERROR,
    );
    expect(() =>
      resolveDatabaseOptions({ NODE_ENV: 'test', DB_NAME: ' sales_db ' }),
    ).toThrow(REFUSE_PRODUCTION_DB_ERROR);
  });

  it('chạy trong Jest dù NODE_ENV=production vẫn bị chặn (JEST_WORKER_ID)', () => {
    expect(() =>
      resolveDatabaseOptions({ NODE_ENV: 'production', JEST_WORKER_ID: '1' }),
    ).toThrow(REFUSE_PRODUCTION_DB_ERROR);
  });

  it('test với database riêng → cho phép, đọc DB_SYNCHRONIZE', () => {
    expect(
      resolveDatabaseOptions({ NODE_ENV: 'test', DB_NAME: 'sales_db_test' }),
    ).toMatchObject({ database: 'sales_db_test', synchronize: true });
    expect(
      resolveDatabaseOptions({
        NODE_ENV: 'test',
        DB_NAME: 'sales_db_test',
        DB_SYNCHRONIZE: 'false',
      }),
    ).toMatchObject({ synchronize: false });
  });
});

describe('assertSafeDatabaseTarget / isTestRun', () => {
  it('Jest luôn được nhận là đang test', () => {
    expect(process.env.JEST_WORKER_ID).toBeDefined();
    expect(isTestRun()).toBe(true);
  });

  it('ngoài test thì không chặn gì', () => {
    expect(() =>
      assertSafeDatabaseTarget('sales_db', PRODUCTION_ENV),
    ).not.toThrow();
  });

  it('trong test: chặn sales_db và tên rỗng, cho database khác', () => {
    expect(() => assertSafeDatabaseTarget('sales_db')).toThrow(
      REFUSE_PRODUCTION_DB_ERROR,
    );
    expect(() => assertSafeDatabaseTarget(undefined)).toThrow(
      REFUSE_PRODUCTION_DB_ERROR,
    );
    expect(() => assertSafeDatabaseTarget('sales_db_test')).not.toThrow();
  });
});
