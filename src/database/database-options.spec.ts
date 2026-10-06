import {
  assertSafeDatabaseTarget,
  isTestRun,
  MISSING_DATABASE_CONFIG_ERROR,
  REFUSE_PRODUCTION_DB_ERROR,
  resolveDatabaseConnectionSettings,
  resolveDatabaseOptions,
} from './database-options';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
  DB_NAME: 'sales_db',
  DB_USER: 'sales_app',
  DB_PASSWORD: 'secret with spaces',
  DB_SYNCHRONIZE: 'false',
} as NodeJS.ProcessEnv;
const DEV_ENV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('resolveDatabaseOptions', () => {
  it('production đọc đủ cấu hình từ ENV và giữ synchronize=false', () => {
    expect(resolveDatabaseOptions(PRODUCTION_ENV)).toEqual({
      type: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      username: 'sales_app',
      password: 'secret with spaces',
      database: 'sales_db',
      autoLoadEntities: true,
      synchronize: false,
    });
  });

  it.each(['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'])(
    'production thiếu %s → fail-fast',
    (key) => {
      const env = { ...PRODUCTION_ENV };
      delete env[key];
      expect(() => resolveDatabaseOptions(env)).toThrow(
        MISSING_DATABASE_CONFIG_ERROR,
      );
    },
  );

  it('development giữ mặc định tương thích', () => {
    expect(resolveDatabaseConnectionSettings(DEV_ENV)).toEqual({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
      database: 'sales_db',
      synchronize: true,
    });
  });

  it('production mặc định synchronize=false nếu biến bị bỏ trống', () => {
    const env = { ...PRODUCTION_ENV };
    delete env.DB_SYNCHRONIZE;
    expect(resolveDatabaseOptions(env)).toMatchObject({ synchronize: false });
  });

  it('từ chối port và DB_SYNCHRONIZE không hợp lệ', () => {
    expect(() =>
      resolveDatabaseOptions({ ...PRODUCTION_ENV, DB_PORT: '70000' }),
    ).toThrow('INVALID_DATABASE_CONFIGURATION');
    expect(() =>
      resolveDatabaseOptions({ ...PRODUCTION_ENV, DB_SYNCHRONIZE: 'yes' }),
    ).toThrow('INVALID_DATABASE_CONFIGURATION');
  });

  it('NODE_ENV=test + sales_db (mặc định hoặc đặt tường minh) → từ chối', () => {
    expect(() => resolveDatabaseOptions({ NODE_ENV: 'test' })).toThrow(
      REFUSE_PRODUCTION_DB_ERROR,
    );
    expect(() =>
      resolveDatabaseOptions({ NODE_ENV: 'test', DB_NAME: ' sales_db ' }),
    ).toThrow(REFUSE_PRODUCTION_DB_ERROR);
  });

  it('chạy trong Jest dù NODE_ENV=production vẫn bị chặn', () => {
    expect(() =>
      resolveDatabaseOptions({ NODE_ENV: 'production', JEST_WORKER_ID: '1' }),
    ).toThrow(REFUSE_PRODUCTION_DB_ERROR);
  });

  it('test với database riêng → cho phép và đọc DB_SYNCHRONIZE', () => {
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
