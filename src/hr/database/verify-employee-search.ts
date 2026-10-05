import 'dotenv/config';
import { normalizeVietnameseName } from '../employees/hr-employee-profile';
import { nameSearchCorpus } from '../employees/name-search-corpus';
import { HrEmployeeCoreProfile1791700000800 } from '../migrations/1791700000800-hr-employee-core-profile';
import { createHrMigrationDataSource } from './hr-data-source';

/**
 * Phase 1.2.3 — kiểm tra hợp đồng chuẩn hoá họ tên trên DB đích. CHỈ ĐỌC.
 *
 *   HR_MIGRATION_DATABASE_URL=... npm run hr:employees:verify-search
 *
 * 1. Chạy biểu thức SQL của migration 0800 trên bộ đối chiếu (toàn bộ chữ
 *    tiếng Việt, NFC/NFD, khoảng trắng Unicode) và so với
 *    `normalizeVietnameseName()` — phát hiện khác biệt do phiên bản
 *    PostgreSQL/encoding/locale của DB đích.
 * 2. Nếu migration 0800 đã chạy: mọi `hr.employees.full_name_search` phải
 *    bằng kết quả chuẩn hoá phía ứng dụng của `full_name`.
 *
 * Không in họ tên — chỉ in id hồ sơ lệch và số liệu tổng hợp.
 * Exit code: 0 = khớp hoàn toàn, 1 = có lệch, 2 = lỗi cấu hình.
 */
async function main() {
  const url = process.env.HR_MIGRATION_DATABASE_URL;
  if (!url) {
    console.error(
      'Thiếu HR_MIGRATION_DATABASE_URL — không có kết nối mặc định.',
    );
    process.exit(2);
  }
  const ds = createHrMigrationDataSource(url, { readOnly: true });
  await ds.initialize();
  let failures = 0;
  try {
    const [target] = await ds.query<Record<string, unknown>[]>(
      `SELECT current_database() AS db, current_setting('server_version') AS version,
              pg_encoding_to_char(encoding) AS encoding, datcollate AS collate, datctype AS ctype,
              current_setting('default_transaction_read_only') AS read_only
         FROM pg_database WHERE datname = current_database()`,
    );
    console.log('Chế độ: CHỈ ĐỌC');
    console.table([target]);

    const corpus = nameSearchCorpus();
    const rows = await ds.query<{ i: number; s: string }[]>(
      `SELECT t.i::int AS i, ${HrEmployeeCoreProfile1791700000800.fullNameSearchSql('t.v')} AS s
         FROM unnest($1::text[]) WITH ORDINALITY AS t(v, i)`,
      [corpus.map((c) => c.input)],
    );
    if (rows.length !== corpus.length) {
      console.log(`Số mẫu SQL trả về ${rows.length} ≠ ${corpus.length}`);
      failures += 1;
    }
    const corpusMismatch = rows.filter((r) => {
      const entry = corpus[r.i - 1];
      return (
        r.s !== normalizeVietnameseName(entry.input) || r.s !== entry.expected
      );
    });
    console.log(
      `Bộ đối chiếu: ${corpus.length} mẫu, lệch ${corpusMismatch.length}`,
    );
    for (const r of corpusMismatch.slice(0, 20)) {
      const e = corpus[r.i - 1];
      console.log(
        `  mẫu #${r.i}: code points ${[...e.input].map((c) => c.codePointAt(0)!.toString(16)).join(' ')} → SQL "${r.s}" / mong đợi "${e.expected}"`,
      );
    }
    failures += corpusMismatch.length;

    const [{ col }] = await ds.query<{ col: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'hr' AND table_name = 'employees'
                         AND column_name = 'full_name_search') AS col`,
    );
    if (!col) {
      console.log('Migration 0800 chưa chạy — bỏ qua kiểm tra dữ liệu hồ sơ.');
    } else {
      const employees = await ds.query<
        { id: number; full_name: string; full_name_search: string | null }[]
      >(
        `SELECT "id", "full_name", "full_name_search" FROM "hr"."employees" ORDER BY "id"`,
      );
      const bad = employees.filter(
        (e) => e.full_name_search !== normalizeVietnameseName(e.full_name),
      );
      console.log(`Hồ sơ: ${employees.length}, lệch ${bad.length}`);
      if (bad.length)
        console.log(
          `  id lệch: ${bad
            .slice(0, 50)
            .map((e) => e.id)
            .join(', ')}`,
        );
      failures += bad.length;
    }
  } finally {
    await ds.destroy();
  }
  console.log(failures ? 'KẾT QUẢ: CÓ LỆCH' : 'KẾT QUẢ: KHỚP');
  process.exit(failures ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
