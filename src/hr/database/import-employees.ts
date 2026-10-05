import 'dotenv/config';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { DataSource, EntityManager } from 'typeorm';
import { HrAuditLog } from '../audit/entities/hr-audit-log.entity';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { hrToday } from '../common/effective-date';
import {
  checksumOf,
  DecisionValidation,
  ImportState,
  parseDecisionFile,
  validateDecisionFile,
} from '../employee-import/decision-file';
import { HrEmployee } from '../employees/entities/hr-employee.entity';
import { insertEmployeeCore } from '../employees/hr-employee-core';
import { assertApplyAllowed } from './migration-risk';

/**
 * Phase 1.2.4 — nhập hồ sơ Employee Core từ decision file ĐÃ DUYỆT.
 *
 *   # Xem trước (mặc định; session chỉ đọc, kiểm tra toàn bộ file)
 *   HR_MIGRATION_DATABASE_URL=... npm run hr:employees:import -- --file=<decisions.csv> --reason="..."
 *   # Thực thi
 *   HR_MIGRATION_DATABASE_URL=... npm run hr:employees:import -- --file=<decisions.csv> --reason="..." \
 *     --apply --confirm-db=<tên_db>
 *
 * - Chỉ dòng IMPORT được ghi; còn REVIEW / giá trị lạ / bất kỳ lỗi nào → không
 *   ghi gì. ALL-OR-NOTHING: một transaction cho cả file, dưới advisory lock
 *   (import đồng thời chạy tuần tự); đọc lại trạng thái và kiểm tra lại trước
 *   khi ghi. Sequence mã NV có thể nhảy số khi rollback — chấp nhận.
 * - Idempotency: `hr.employee_import_batches.checksum` — chạy lại đúng file đã
 *   áp dụng → không làm gì (exit 0).
 * - Chỉ Employee Core; đơn vị đề xuất lưu ở `hr.employee_import_items` cho
 *   Phase 1.4, không ghi vào hồ sơ. Không nhập dữ liệu định danh nhạy cảm.
 * - Console và audit không in họ tên/email/SĐT — chỉ số dòng, id tài khoản,
 *   mã NV, số đếm, checksum.
 */

const CLI_ACTOR: HrAuditActor = {
  accountId: null,
  name: 'hr:employees:import (CLI)',
  roles: [],
};

/** Khoá tư vấn riêng cho import hồ sơ — hai lần import không chạy chồng. */
const HR_EMPLOYEE_IMPORT_LOCK = 791_700_412;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function assertTables(manager: EntityManager) {
  const [{ t }] = await manager.query<{ t: string | null }[]>(
    `SELECT to_regclass('"hr"."employee_import_batches"')::text AS t`,
  );
  if (!t)
    throw new Error(
      'Chưa có hr.employee_import_batches — chạy migration HR 1791700001000 trước.',
    );
}

async function findBatch(manager: EntityManager, checksum: string) {
  const [row] = await manager.query<
    { id: number; batchId: string; appliedAt: string }[]
  >(
    `SELECT "id", "batch_id" AS "batchId", "applied_at"::text AS "appliedAt"
       FROM "hr"."employee_import_batches" WHERE "checksum" = $1`,
    [checksum],
  );
  return row ?? null;
}

async function loadState(
  manager: EntityManager,
  today: string,
): Promise<ImportState> {
  const accounts = await manager.query<{ id: number; isActive: boolean }[]>(
    `SELECT "id", "isActive" FROM "public"."employee"`,
  );
  const employees = await manager.query<
    {
      code: string;
      accountId: number | null;
      phone: string | null;
      workEmail: string | null;
      personalEmail: string | null;
    }[]
  >(
    `SELECT "employee_code" AS "code", "account_id" AS "accountId", "phone",
            "work_email" AS "workEmail", "personal_email" AS "personalEmail"
       FROM "hr"."employees"`,
  );
  const units = await manager.query<{ id: number; code: string }[]>(
    `SELECT u."id", u."code"
       FROM "hr"."org_units" u
       JOIN "hr"."org_unit_revisions" r ON r."org_unit_id" = u."id"
      WHERE r."effective_from" <= $1::date
        AND (r."effective_to" IS NULL OR r."effective_to" >= $1::date)
        AND r."status" = 'ACTIVE'`,
    [today],
  );
  return {
    accounts: new Map(accounts.map((a) => [a.id, { isActive: a.isActive }])),
    linkedAccounts: new Map(
      employees
        .filter((e) => e.accountId !== null)
        .map((e) => [e.accountId!, e.code]),
    ),
    activeOrgUnits: new Map(units.map((u) => [u.code, u.id])),
    existingPhones: new Set(
      employees.map((e) => e.phone).filter((p): p is string => !!p),
    ),
    existingEmails: new Set(
      employees
        .flatMap((e) => [e.workEmail, e.personalEmail])
        .filter((m): m is string => !!m),
    ),
  };
}

function printReport(v: DecisionValidation) {
  const modes = v.toImport.reduce<Record<string, number>>((m, r) => {
    m[r.input.attendanceMode] = (m[r.input.attendanceMode] ?? 0) + 1;
    return m;
  }, {});
  console.log('\nTổng hợp decision file:');
  console.table([
    {
      IMPORT: v.importCount,
      SKIP: v.skipCount,
      REVIEW: v.reviewCount,
      FAILED: v.failedCount,
      lỗi: v.errors.length,
      cảnh_báo: v.warnings.length,
    },
  ]);
  if (v.toImport.length) {
    console.log('Kiểu chấm công của các dòng IMPORT hợp lệ:');
    console.table([modes]);
  }
  if (v.warnings.length) {
    console.log(`\n${v.warnings.length} cảnh báo (không chặn):`);
    for (const w of v.warnings.slice(0, 100)) console.log(`  • ${w}`);
  }
  if (v.errors.length) {
    console.error(`\n${v.errors.length} LỖI — không ghi gì:`);
    for (const e of v.errors.slice(0, 200)) console.error(`  • ${e}`);
  }
}

async function main() {
  const file = arg('file');
  const reason = (arg('reason') ?? '').trim();
  const apply = process.argv.includes('--apply');
  if (!file) throw new Error('Thiếu --file=<decisions.csv>');
  if (reason.length < 5) throw new Error('Thiếu --reason (tối thiểu 5 ký tự)');
  const url = process.env.HR_MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      'Thiếu HR_MIGRATION_DATABASE_URL — không có kết nối mặc định.',
    );
  const content = readFileSync(file);
  const checksum = checksumOf(content);
  const parsed = parseDecisionFile(content.toString('utf8'));

  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: [HrAuditLog, HrEmployee],
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    extra: {
      max: 1,
      options:
        '-c lock_timeout=5000 -c statement_timeout=120000' +
        (apply ? '' : ' -c default_transaction_read_only=on'),
    },
  });
  await ds.initialize();
  try {
    const [target] = await ds.query<Record<string, unknown>[]>(
      `SELECT current_database() AS db, inet_server_addr()::text AS addr, current_user AS usr`,
    );
    console.log(
      apply ? 'Chế độ: THỰC THI' : 'Chế độ: XEM TRƯỚC (session chỉ đọc)',
    );
    console.table([target]);
    console.log(`Checksum decision file (SHA-256): ${checksum}`);
    await assertTables(ds.manager);
    const today = hrToday();

    const done = await findBatch(ds.manager, checksum);
    if (done) {
      console.log(
        `\nDecision file này ĐÃ được áp dụng (batch ${done.batchId}, ${done.appliedAt}) — không làm gì.`,
      );
      return;
    }

    const preview = validateDecisionFile(
      parsed,
      await loadState(ds.manager, today),
      today,
    );
    printReport(preview);
    if (preview.errors.length) process.exit(1);
    if (!apply) {
      console.log(
        '\nXem trước hợp lệ — chưa ghi gì. Thêm --apply --confirm-db=<tên_db> để thực thi.',
      );
      return;
    }

    assertApplyAllowed({
      apply,
      confirmDb: arg('confirm-db'),
      actualDb: String(target.db),
      nodeEnv: process.env.NODE_ENV,
      allowProduction: process.env.HR_ALLOW_PRODUCTION_MIGRATION,
      allowCaution: true,
      pending: [{ name: 'employee import', risk: 'CAUTION' }],
    });

    const audit = new HrAuditService(ds);
    const outcome = await ds.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [
        HR_EMPLOYEE_IMPORT_LOCK,
      ]);
      const already = await findBatch(manager, checksum);
      if (already) return { already, created: null };
      const fresh = validateDecisionFile(
        parsed,
        await loadState(manager, today),
        today,
      );
      if (fresh.errors.length) {
        printReport(fresh);
        throw new Error(
          'Trạng thái đã thay đổi so với lúc xem trước — không ghi gì.',
        );
      }
      const batchId = randomUUID();
      const [batch] = await manager.query<{ id: number }[]>(
        `INSERT INTO "hr"."employee_import_batches"
           ("batch_id","checksum","reason","import_count","skip_count","applied_by")
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING "id"`,
        [
          batchId,
          checksum,
          reason,
          fresh.importCount,
          fresh.skipCount,
          CLI_ACTOR.name,
        ],
      );
      const created: { code: string; accountId: number; mode: string }[] = [];
      for (const row of fresh.toImport) {
        const employee = await insertEmployeeCore(manager, audit, {
          actor: CLI_ACTOR,
          actorAccountId: null,
          input: row.input,
          auditExtra: { source: 'IMPORT', batchId },
        });
        await manager.query(
          `INSERT INTO "hr"."employee_import_items"
             ("batch_id","employee_id","account_id","proposed_org_unit_id")
           VALUES ($1,$2,$3,$4)`,
          [batch.id, employee.id, row.accountId, row.proposedOrgUnitId],
        );
        created.push({
          code: employee.employeeCode,
          accountId: row.accountId,
          mode: employee.attendanceMode,
        });
      }
      await audit.record(manager, {
        actor: CLI_ACTOR,
        action: HrAuditAction.EMPLOYEE_IMPORT,
        entity: 'employee_import_batch',
        entityId: batch.id,
        newValue: {
          batchId,
          checksum,
          importCount: fresh.importCount,
          skipCount: fresh.skipCount,
          firstEmployeeCode: created[0]?.code ?? null,
          lastEmployeeCode: created[created.length - 1]?.code ?? null,
        },
        reason,
      });
      return { already: null, created, batchId };
    });

    if (outcome.already) {
      console.log(
        `\nDecision file vừa được áp dụng bởi batch ${outcome.already.batchId} — không làm gì.`,
      );
      return;
    }
    const created = outcome.created ?? [];
    const modes = created.reduce<Record<string, number>>((m, c) => {
      m[c.mode] = (m[c.mode] ?? 0) + 1;
      return m;
    }, {});
    console.log(`\nĐÃ GHI — batch ${outcome.batchId}`);
    console.table([
      {
        IMPORT: created.length,
        SKIP: preview.skipCount,
        FAILED: 0,
        tài_khoản_đã_liên_kết: created.length,
        mã_đầu: created[0]?.code ?? '',
        mã_cuối: created[created.length - 1]?.code ?? '',
      },
    ]);
    console.log('Kiểu chấm công:');
    console.table([modes]);
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('LỖI:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
