import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Database production. Test **không bao giờ** được trỏ vào đây: `AppModule`
 * chạy `synchronize: true`, nên chỉ cần boot là schema production bị sửa theo
 * entity trong working tree (sự cố 05/10/2026 do `test/app.e2e-spec.ts`).
 */
export const PRODUCTION_DATABASE_NAMES: readonly string[] = ['sales_db'];

export const REFUSE_PRODUCTION_DB_ERROR =
  'REFUSING_TO_RUN_TESTS_AGAINST_PRODUCTION_DATABASE';

/** Mặc định giữ đúng cấu hình production trước đây (cấu hình cứng). */
const DEFAULT_DATABASE = 'sales_db';

/**
 * Đang chạy trong test. Xét cả `JEST_WORKER_ID` (Jest luôn đặt, kể cả
 * `--runInBand`) để `NODE_ENV=production npx jest` cũng không lọt qua.
 */
export function isTestRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.JEST_WORKER_ID !== undefined;
}

/** Ném lỗi nếu đang test mà database đích là production. */
export function assertSafeDatabaseTarget(
  database: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isTestRun(env)) return;
  const name = typeof database === 'string' ? database.trim() : '';
  if (!name || PRODUCTION_DATABASE_NAMES.includes(name)) {
    throw new Error(
      `${REFUSE_PRODUCTION_DB_ERROR}: test đang trỏ vào database "${name || '(trống)'}". ` +
        'Đặt DB_NAME tới database test riêng (vd. sales_db_test) hoặc mock phần cần DB.',
    );
  }
}

/**
 * Cấu hình TypeORM của `AppModule`. Production giữ nguyên hành vi cũ
 * (`sales_db`, `synchronize: true`) khi không đặt biến nào — pm2 và `.env`
 * hiện không đặt `DB_NAME`/`DB_SYNCHRONIZE`.
 *
 * Gọi lúc `AppModule` được import, nên test trỏ nhầm production bị chặn
 * trước khi TypeORM kịp tạo kết nối.
 *
 * Bỏ `synchronize` ở production là việc riêng (tech debt), không làm ở đây.
 */
export function resolveDatabaseOptions(
  env: NodeJS.ProcessEnv = process.env,
): TypeOrmModuleOptions {
  const database = env.DB_NAME?.trim() || DEFAULT_DATABASE;
  assertSafeDatabaseTarget(database, env);

  return {
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: 'postgres',
    database,
    autoLoadEntities: true,
    synchronize:
      env.DB_SYNCHRONIZE === undefined ? true : env.DB_SYNCHRONIZE === 'true',
  };
}
