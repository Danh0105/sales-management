import 'dotenv/config';
import { readFileSync } from 'fs';
import { DataSource } from 'typeorm';
import {
  assertConnectedToDev,
  assertStatementAllowed,
  parseDevTarget,
} from './dev-target';

/**
 * Chạy SQL trên DB test `sales_db_hr_dev` ở localhost — và CHỈ ở đó.
 *
 *   npx ts-node -r tsconfig-paths/register src/hr/database/hr-dev-sql.ts "SELECT 1"
 *   ... hr-dev-sql.ts --file=path/to/query.sql
 *   ... hr-dev-sql.ts --write "INSERT INTO hr.x ..."
 *
 * Mặc định session read-only; `--write` mới cho ghi. Kết nối lấy từ
 * HR_MIGRATION_DATABASE_URL và bị `dev-target.ts` kiểm tra hai lần: trước khi
 * kết nối (host/tên DB trong URL) và sau khi kết nối (DB/địa chỉ server thật).
 */

const MAX_ROWS_PRINTED = 200;

function readSql(args: string[]): string {
  const file = args
    .find((a) => a.startsWith('--file='))
    ?.slice('--file='.length);
  if (file) return readFileSync(file, 'utf8');

  const sql = args
    .filter((a) => !a.startsWith('--'))
    .join(' ')
    .trim();
  if (!sql) throw new Error('Thiếu câu SQL (tham số hoặc --file=...).');
  return sql;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const sql = readSql(args);

  const target = parseDevTarget(process.env.HR_MIGRATION_DATABASE_URL);
  assertStatementAllowed(sql);

  const ds = new DataSource({
    type: 'postgres',
    ...target,
    entities: [],
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    extra: {
      max: 1,
      options:
        '-c statement_timeout=30000 -c lock_timeout=5000' +
        (write ? '' : ' -c default_transaction_read_only=on'),
    },
  });

  await ds.initialize();
  try {
    const [info] = await ds.query<{ db: string; addr: string | null }[]>(
      `SELECT current_database() AS db, inet_server_addr()::text AS addr`,
    );
    assertConnectedToDev(info);

    console.log(
      `[hr-dev-sql] ${info.db}@${target.host} — ${write ? 'GHI' : 'chỉ đọc'}`,
    );

    const result: unknown = await ds.query(sql);
    const rows = Array.isArray(result) ? (result as unknown[]) : [];
    if (rows.length) {
      console.table(rows.slice(0, MAX_ROWS_PRINTED));
      if (rows.length > MAX_ROWS_PRINTED) {
        console.log(`... còn ${rows.length - MAX_ROWS_PRINTED} dòng không in.`);
      }
    }
    console.log(`${rows.length} dòng.`);
  } finally {
    await ds.destroy();
  }
}

main().catch((error: Error) => {
  console.error(`[hr-dev-sql] DỪNG: ${error.message}`);
  process.exit(1);
});
