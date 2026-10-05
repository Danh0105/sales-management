import 'dotenv/config';
import { DataSource } from 'typeorm';
import { createHrMigrationDataSource } from './hr-data-source';
import {
  assertApplyAllowed,
  MigrationRisk,
  PendingMigration,
} from './migration-risk';

/**
 * Runner migration HR.
 *
 *   npm run hr:migration:show
 *   npm run hr:migration:run -- --confirm-db=<tên_db> [--allow-caution]
 *
 * Mặc định chỉ XEM TRƯỚC, trên session read-only. Muốn thực thi phải có đủ
 * `--apply` + `--confirm-db` khớp tên DB thật; môi trường production còn cần
 * `HR_ALLOW_PRODUCTION_MIGRATION=yes`. Xem `src/hr/README-MIGRATIONS.md`.
 */

/** Khoá tư vấn cố định — hai runner chạy cùng lúc thì runner sau dừng ngay. */
const ADVISORY_LOCK_KEY = 791_700_001;

interface CliOptions {
  apply: boolean;
  confirmDb?: string;
  allowCaution: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (flag: string) =>
    argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

  return {
    apply: argv.includes('--apply'),
    confirmDb: value('--confirm-db'),
    allowCaution: argv.includes('--allow-caution'),
  };
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<URL không hợp lệ>';
  }
}

function migrationName(instance: object): string {
  return (instance as { name?: string }).name ?? instance.constructor.name;
}

function migrationRisk(instance: object): MigrationRisk | null {
  return (instance.constructor as { risk?: MigrationRisk }).risk ?? null;
}

async function findPending(ds: DataSource): Promise<PendingMigration[]> {
  const [{ exists }] = await ds.query<{ exists: boolean }[]>(
    `SELECT to_regclass('hr.migrations') IS NOT NULL AS exists`,
  );
  const rows = exists
    ? await ds.query<{ name: string }[]>(`SELECT name FROM hr.migrations`)
    : [];
  const executed = new Set(rows.map((r) => r.name));

  return ds.migrations
    .filter((m) => !executed.has(migrationName(m)))
    .map((m) => ({ name: migrationName(m), risk: migrationRisk(m) }));
}

async function describeTarget(ds: DataSource): Promise<string> {
  const [info] = await ds.query<Record<string, unknown>[]>(
    `SELECT current_database() AS db, current_user AS usr,
            inet_server_addr()::text AS addr, pg_is_in_recovery() AS replica,
            current_setting('server_version') AS version`,
  );
  console.log('Database đích:');
  console.table([info]);
  return String(info.db);
}

async function main(): Promise<void> {
  const url = process.env.HR_MIGRATION_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Thiếu HR_MIGRATION_DATABASE_URL. Không có giá trị mặc định — cố ý.',
    );
  }

  const options = parseArgs(process.argv.slice(2));
  console.log(`Kết nối: ${redact(url)}`);
  console.log(
    options.apply ? 'Chế độ: THỰC THI' : 'Chế độ: xem trước (read-only)',
  );

  // Lần đầu luôn mở read-only: xác định đích và danh sách chờ mà không ghi gì.
  const preview = createHrMigrationDataSource(url, { readOnly: true });
  await preview.initialize();
  let actualDb: string;
  let pending: PendingMigration[];
  try {
    actualDb = await describeTarget(preview);
    pending = await findPending(preview);
  } finally {
    await preview.destroy();
  }

  if (!pending.length) {
    console.log('Không có migration HR nào đang chờ.');
    return;
  }
  console.log('Migration HR đang chờ:');
  console.table(pending.map((m) => ({ ...m, risk: m.risk ?? 'THIẾU NHÃN' })));

  if (!options.apply) {
    console.log(
      'Xem trước xong — chưa ghi gì. Thực thi: npm run hr:migration:run -- --confirm-db=<tên_db>',
    );
    return;
  }

  assertApplyAllowed({
    ...options,
    actualDb,
    nodeEnv: process.env.NODE_ENV,
    allowProduction: process.env.HR_ALLOW_PRODUCTION_MIGRATION,
    pending,
  });

  const ds = createHrMigrationDataSource(url, { readOnly: false });
  await ds.initialize();
  const lock = ds.createQueryRunner();
  try {
    await lock.connect();
    const [{ locked }] = (await lock.query(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [ADVISORY_LOCK_KEY],
    )) as { locked: boolean }[];
    if (!locked) throw new Error('Một runner migration HR khác đang chạy.');

    // Bảng `hr.migrations` nằm trong schema hr, nên schema phải có trước khi
    // TypeORM tạo bảng theo dõi. Idempotent, không đụng gì ngoài schema hr.
    await ds.query(`CREATE SCHEMA IF NOT EXISTS hr`);

    const done = await ds.runMigrations({ transaction: 'each' });
    console.log(`Đã chạy ${done.length} migration HR:`);
    for (const m of done) console.log(`  - ${m.name}`);
  } finally {
    await lock
      .query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    await lock.release();
    await ds.destroy();
  }
}

main().catch((error: Error) => {
  console.error(`\n[hr-migration] DỪNG: ${error.message}`);
  process.exit(1);
});
