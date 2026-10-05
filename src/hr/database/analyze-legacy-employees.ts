import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { hrToday } from '../common/effective-date';
import {
  analyzeLegacyAccounts,
  LegacyAccountRow,
  MappingRule,
  toCsv,
} from '../employee-import/legacy-employee-classifier';
import { toDecisionTemplate } from '../employee-import/decision-file';
import { createHrMigrationDataSource } from './hr-data-source';

/**
 * Phase 1.2.1 — phân tích tài khoản cũ để chuẩn bị nhập hồ sơ HR. CHỈ ĐỌC:
 * session mở với `default_transaction_read_only=on`, không có chế độ ghi.
 *
 *   HR_MIGRATION_DATABASE_URL=... npm run hr:employees:analyze [-- --out=<file.csv>]
 *
 * Kết quả chi tiết (có tên, email, SĐT) ghi ra CSV trong `backup/hr-import/`
 * (đã .gitignore). Console chỉ in số liệu tổng hợp — không in từng người.
 */

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<URL không hợp lệ>';
  }
}

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

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
  try {
    const [target] = await ds.query<Record<string, unknown>[]>(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr,
              current_setting('server_version') AS version,
              current_setting('default_transaction_read_only') AS read_only`,
    );
    console.log(`Kết nối: ${redact(url)}`);
    console.log('Chế độ: CHỈ ĐỌC (không có thao tác ghi)');
    console.table([target]);

    const today = hrToday();
    const accounts = await ds.query<LegacyAccountRow[]>(
      `SELECT e."id", e."name", e."email", e."phone", e."isActive", e."roles",
              e."department_id" AS "departmentId", d."name" AS "departmentName",
              h."id" AS "linkedEmployeeId"
         FROM "public"."employee" e
         LEFT JOIN "public"."department" d ON d."id" = e."department_id"
         LEFT JOIN "hr"."employees" h ON h."account_id" = e."id"
        ORDER BY e."id"`,
    );
    const departments = await ds.query<{ id: number }[]>(
      `SELECT "id" FROM "public"."department"`,
    );

    const hasOrg = (
      await ds.query<{ t: string | null }[]>(
        `SELECT to_regclass('"hr"."legacy_org_mappings"')::text AS t`,
      )
    )[0].t;
    const rules: MappingRule[] = hasOrg
      ? await ds.query<MappingRule[]>(
          `SELECT m."source_type" AS "sourceType", m."source_value" AS "sourceValue",
                  m."org_unit_id" AS "orgUnitId", r."name" AS "orgUnitName", u."code" AS "orgUnitCode", m."priority"
             FROM "hr"."legacy_org_mappings" m
             JOIN "hr"."org_units" u ON u."id" = m."org_unit_id"
             JOIN "hr"."org_unit_revisions" r ON r."org_unit_id" = m."org_unit_id"
              AND r."effective_from" <= $1::date
              AND (r."effective_to" IS NULL OR r."effective_to" >= $1::date)
              AND r."status" = 'ACTIVE'
            WHERE m."is_active"`,
          [today],
        )
      : [];
    if (!hasOrg)
      console.warn(
        'Chưa có bảng hr.legacy_org_mappings (chưa chạy migration Phase 1.1) — mọi dòng sẽ thiếu tổ chức.',
      );

    const rows = analyzeLegacyAccounts(
      accounts.map((a) => ({ ...a, roles: a.roles ?? [] })),
      rules,
      new Set(departments.map((d) => d.id)),
    );

    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .slice(0, 13);
    const out = resolve(
      argValue('--out') ??
        join(
          process.cwd(),
          'backup',
          'hr-import',
          `legacy-employee-analysis-${String(target.db)}-${stamp}.csv`,
        ),
    );
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, toCsv(rows), 'utf8');
    // Bản nháp decision file cho 1.2.4: NO → SKIP, còn lại → REVIEW (người duyệt quyết).
    const decisionOut = join(
      out,
      '..',
      `legacy-employee-decisions-${String(target.db)}-${stamp}.csv`,
    );
    writeFileSync(decisionOut, toDecisionTemplate(rows), 'utf8');

    // ── Tổng hợp (không có dữ liệu cá nhân) ──
    const tally = <T extends string>(values: T[]) =>
      values.reduce<Record<string, number>>(
        (m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }),
        {},
      );
    console.log(
      `\nNgày tham chiếu tổ chức: ${today} · mapping đang dùng: ${rules.length}`,
    );
    console.log(`Tổng tài khoản: ${rows.length}`);
    console.log('\nTheo nhóm × khả năng nhập:');
    const categories = [...new Set(rows.map((r) => r.category))];
    console.table(
      categories.map((c) => {
        const inCat = rows.filter((r) => r.category === c);
        return {
          category: c,
          total: inCat.length,
          YES: inCat.filter((r) => r.importable === 'YES').length,
          REVIEW: inCat.filter((r) => r.importable === 'REVIEW').length,
          NO: inCat.filter((r) => r.importable === 'NO').length,
        };
      }),
    );
    console.log('Cảnh báo (số tài khoản):');
    console.table(tally(rows.flatMap((r) => r.warnings)));
    console.log('Role cũ gặp trong dữ liệu:');
    console.table(
      tally(
        rows.flatMap((r) =>
          r.legacyRoles ? r.legacyRoles.split('|') : ['(không role)'],
        ),
      ),
    );
    console.log('Đơn vị đề xuất:');
    console.table(tally(rows.map((r) => r.proposedOrgUnit || '(chưa có)')));
    console.log(
      `\nChi tiết từng tài khoản (CÓ dữ liệu cá nhân — không chia sẻ công khai): ${out}`,
    );
    console.log(
      `Bản nháp decision file (sửa cột decision: IMPORT / SKIP; REVIEW chặn import): ${decisionOut}`,
    );
    console.log(
      'Chưa ghi gì vào DB. Bước nhập (Phase 1.2.4) chỉ chạy từ file quyết định đã được duyệt.',
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('LỖI:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
