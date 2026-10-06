import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const PRODUCTION_DATABASE_NAMES: readonly string[] = ['sales_db'];

export const REFUSE_PRODUCTION_DB_ERROR =
  'REFUSING_TO_RUN_TESTS_AGAINST_PRODUCTION_DATABASE';

export const MISSING_DATABASE_CONFIG_ERROR =
  'MISSING_PRODUCTION_DATABASE_CONFIGURATION';

const DEFAULT_CONNECTION = {
  host: 'localhost',
  port: 5432,
  username: 'postgres',
  password: 'postgres',
  database: 'sales_db',
} as const;

export interface DatabaseConnectionSettings {
  type: 'postgres';
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  synchronize: boolean;
}

export function isTestRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.JEST_WORKER_ID !== undefined;
}

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

function readConnectionValue(
  env: NodeJS.ProcessEnv,
  key: 'DB_HOST' | 'DB_PORT' | 'DB_NAME' | 'DB_USER' | 'DB_PASSWORD',
  developmentDefault: string,
): string {
  const raw = env[key];
  const empty = raw === undefined || raw.trim() === '';

  if (empty && env.NODE_ENV === 'production' && !isTestRun(env)) {
    throw new Error(`${MISSING_DATABASE_CONFIG_ERROR}: ${key} is required`);
  }

  if (empty) return developmentDefault;
  return key === 'DB_PASSWORD' ? raw : raw.trim();
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`INVALID_DATABASE_CONFIGURATION: DB_PORT="${value}"`);
  }
  return port;
}

function parseSynchronize(env: NodeJS.ProcessEnv): boolean {
  const raw = env.DB_SYNCHRONIZE;
  if (raw === undefined || raw.trim() === '') {
    return env.NODE_ENV !== 'production';
  }

  if (raw !== 'true' && raw !== 'false') {
    throw new Error(
      'INVALID_DATABASE_CONFIGURATION: DB_SYNCHRONIZE must be "true" or "false"',
    );
  }
  return raw === 'true';
}

export function resolveDatabaseConnectionSettings(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConnectionSettings {
  // Resolve the target first so Jest always gets the production-DB guard,
  // even when a test deliberately passes NODE_ENV=production.
  const database = env.DB_NAME?.trim() || DEFAULT_CONNECTION.database;
  assertSafeDatabaseTarget(database, env);

  return {
    type: 'postgres',
    host: readConnectionValue(env, 'DB_HOST', DEFAULT_CONNECTION.host),
    port: parsePort(
      readConnectionValue(env, 'DB_PORT', String(DEFAULT_CONNECTION.port)),
    ),
    username: readConnectionValue(env, 'DB_USER', DEFAULT_CONNECTION.username),
    password: readConnectionValue(
      env,
      'DB_PASSWORD',
      DEFAULT_CONNECTION.password,
    ),
    database: readConnectionValue(env, 'DB_NAME', DEFAULT_CONNECTION.database),
    synchronize: parseSynchronize(env),
  };
}

export function resolveDatabaseOptions(
  env: NodeJS.ProcessEnv = process.env,
): TypeOrmModuleOptions {
  return {
    ...resolveDatabaseConnectionSettings(env),
    autoLoadEntities: true,
  };
}
