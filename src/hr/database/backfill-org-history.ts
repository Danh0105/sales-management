import 'dotenv/config';
import { readFileSync } from 'fs';
import { DataSource, EntityManager } from 'typeorm';
import { HrAuditLog } from '../audit/entities/hr-audit-log.entity';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { hrToday } from '../common/effective-date';
import {
  BackfillResult,
  ExistingOrgState,
  isRefKey,
  OrgBackfillPlan,
  planHash,
  refKey,
  validateBackfill,
} from '../organization/backfill/org-history';
import {
  allocateCode,
  ORG_UNIT_CODES,
  predictCodes,
  readSequenceState,
} from '../organization/org-code';
import type {
  OrgLeaderRole,
  OrgUnitStatus,
  OrgUnitType,
} from '../organization/org-policy';
import { HR_ORG_STRUCTURE_LOCK } from '../organization/org-structure.repository';
import { assertApplyAllowed } from './migration-risk';

/**
 * Phase 1.2.2 — backfill LỊCH SỬ cơ cấu tổ chức (được lùi ngày). Chỉ dùng khi
 * thiết lập; API thường vẫn không cho lùi ngày.
 *
 *   # Xem trước (mặc định; session chỉ đọc, mô phỏng trong bộ nhớ)
 *   HR_MIGRATION_DATABASE_URL=... npm run hr:org:backfill -- --plan=org-history.json --reason="..."
 *   # Thực thi
 *   HR_SETUP_MODE=yes HR_MIGRATION_DATABASE_URL=... npm run hr:org:backfill -- \
 *     --plan=org-history.json --reason="..." --apply --confirm-db=<tên_db>
 *
 * Mã đơn vị: đơn vị MỚI khai bằng `ref` tạm; hệ thống sinh DV#### theo thứ tự
 * phụ thuộc (cha trước con). Xem trước in mã DỰ KIẾN; sau khi ghi in mã THẬT.
 * Đơn vị đã có tham chiếu bằng mã thật.
 *
 * Idempotency: `hr.org_backfill_runs.plan_hash` — chạy lại đúng kế hoạch đã
 * áp dụng → không làm gì (exit 0). Ref đã tạo ở lần trước → lỗi (tham chiếu
 * bằng mã đã cấp, không khai lại).
 *
 * Apply: advisory lock của cơ cấu → đọc lại trạng thái TRONG transaction →
 * kiểm tra lại → ghi + audit (source BACKFILL_CLI). Có lỗi → không ghi gì.
 */

const CLI_ACTOR: HrAuditActor = {
  accountId: null,
  name: 'hr:org:backfill (CLI)',
  roles: [],
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function assertRunsTable(manager: EntityManager) {
  const [{ t }] = await manager.query<{ t: string | null }[]>(
    `SELECT to_regclass('"hr"."org_backfill_runs"')::text AS t`,
  );
  if (!t)
    throw new Error(
      'Chưa có hr.org_backfill_runs — chạy migration HR 1791700000900 trước.',
    );
}

async function findRun(manager: EntityManager, hash: string) {
  const [run] = await manager.query<{ id: number; appliedAt: string }[]>(
    `SELECT "id", "applied_at"::text AS "appliedAt" FROM "hr"."org_backfill_runs" WHERE "plan_hash" = $1`,
    [hash],
  );
  return run ?? null;
}

async function loadState(manager: EntityManager): Promise<ExistingOrgState> {
  const units = await manager.query<{ id: number; code: string }[]>(
    `SELECT "id", "code" FROM "hr"."org_units"`,
  );
  const codeOf = new Map(units.map((u) => [u.id, u.code]));
  const revisions = await manager.query<
    {
      orgUnitId: number;
      unitType: OrgUnitType;
      name: string;
      parentId: number | null;
      status: OrgUnitStatus;
      effectiveFrom: string;
      effectiveTo: string | null;
    }[]
  >(
    `SELECT "org_unit_id" AS "orgUnitId", "unit_type" AS "unitType", "name", "parent_id" AS "parentId", "status",
            "effective_from"::text AS "effectiveFrom", "effective_to"::text AS "effectiveTo"
       FROM "hr"."org_unit_revisions"`,
  );
  const leaders = await manager.query<
    {
      orgUnitId: number;
      employeeId: number;
      leaderRole: OrgLeaderRole;
      isApprovalAuthority: boolean;
      effectiveFrom: string;
      effectiveTo: string | null;
    }[]
  >(
    `SELECT "org_unit_id" AS "orgUnitId", "employee_id" AS "employeeId", "leader_role" AS "leaderRole",
            "is_approval_authority" AS "isApprovalAuthority",
            "effective_from"::text AS "effectiveFrom", "effective_to"::text AS "effectiveTo"
       FROM "hr"."org_unit_leaders"`,
  );
  const employees = await manager.query<
    { id: number; code: string; status: string; name: string }[]
  >(
    `SELECT "id", "employee_code" AS "code", "status", "full_name" AS "name" FROM "hr"."employees"`,
  );
  const positions = await manager.query<
    { id: number; code: string; isActive: boolean }[]
  >(`SELECT "id", "code", "is_active" AS "isActive" FROM "hr"."positions"`);
  const runs = await manager.query<
    { id: number; refCodes: Record<string, string> }[]
  >(`SELECT "id", "ref_codes" AS "refCodes" FROM "hr"."org_backfill_runs"`);
  const appliedRefs = new Map<string, { code: string; runId: number }>();
  for (const run of runs)
    for (const [ref, code] of Object.entries(run.refCodes ?? {}))
      appliedRefs.set(ref, { code, runId: run.id });
  return {
    unitIds: new Map(units.map((u) => [u.code, u.id])),
    revisions: revisions.map((r) => ({
      unitCode: codeOf.get(r.orgUnitId)!,
      unitType: r.unitType,
      name: r.name,
      parentCode: r.parentId === null ? null : (codeOf.get(r.parentId) ?? null),
      status: r.status,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
    })),
    leaders: leaders.map((l) => ({ ...l, unitCode: codeOf.get(l.orgUnitId)! })),
    employees: new Map(
      employees.map((e) => [
        e.code,
        { id: e.id, status: e.status, name: e.name },
      ]),
    ),
    positions: new Map(
      positions.map((p) => [p.code, { id: p.id, isActive: p.isActive }]),
    ),
    appliedRefs,
  };
}

/** Khoá nội bộ → nhãn hiển thị: mã thật, hoặc mã đã cấp/dự kiến kèm ref. */
function labeler(codes: Map<string, string>) {
  return (key: string | null) => {
    if (key === null) return '';
    if (!isRefKey(key)) return key;
    const ref = key.slice(4);
    const code = codes.get(ref);
    return code ? `${code} (ref ${ref})` : `ref ${ref}`;
  };
}

function printReport(result: BackfillResult, codes: Map<string, string>) {
  const label = labeler(codes);
  console.log(
    `\nĐơn vị mới: ${result.newUnitRefs.length} · revision: ${result.revisions.length} · lãnh đạo: ${result.leaders.length} · mốc kiểm tra: ${result.checkpoints}`,
  );
  if (result.revisions.length) {
    console.table(
      result.revisions.map((r) => ({
        unit: label(r.unitCode),
        source: r.source,
        type: r.unitType,
        name: r.name,
        parent: label(r.parentCode),
        status: r.status,
        from: r.effectiveFrom,
        to: r.effectiveTo ?? '(mở)',
      })),
    );
  }
  if (result.leaders.length) {
    console.table(
      result.leaders.map((l) => ({
        unit: label(l.unitCode),
        employee: l.employeeCode,
        role: l.leaderRole,
        authority: l.isApprovalAuthority,
        from: l.effectiveFrom,
        to: l.effectiveTo ?? '(mở)',
      })),
    );
  }
  if (result.errors.length) {
    console.error(`\n${result.errors.length} LỖI — không ghi gì:`);
    for (const e of result.errors) console.error(`  • ${e}`);
  }
}

async function write(
  manager: EntityManager,
  audit: HrAuditService,
  result: BackfillResult,
  reason: string,
  state: ExistingOrgState,
  hash: string,
): Promise<Map<string, string>> {
  const idOf = new Map(state.unitIds);
  const refCodes = new Map<string, string>();
  // Cấp mã theo thứ tự phụ thuộc (cha trước con) — cùng thứ tự với xem trước.
  for (const ref of result.newUnitRefs) {
    const code = await allocateCode(manager, ORG_UNIT_CODES);
    const [row] = await manager.query<{ id: number }[]>(
      `INSERT INTO "hr"."org_units" ("code", "version") VALUES ($1, 1) RETURNING "id"`,
      [code],
    );
    idOf.set(refKey(ref), row.id);
    refCodes.set(ref, code);
  }
  const codeOf = (key: string | null) =>
    key === null ? null : isRefKey(key) ? refCodes.get(key.slice(4))! : key;

  for (const r of result.revisions) {
    await manager.query(
      `INSERT INTO "hr"."org_unit_revisions"
         ("org_unit_id","unit_type","name","parent_id","status","effective_from","effective_to","reason")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        idOf.get(r.unitCode),
        r.unitType,
        r.name,
        r.parentCode === null ? null : idOf.get(r.parentCode),
        r.status,
        r.effectiveFrom,
        r.effectiveTo,
        reason,
      ],
    );
  }
  // Đơn vị có sẵn bị chèn lịch sử: tăng version để form đang mở phải tải lại.
  const prepended = [
    ...new Set(
      result.revisions
        .filter((r) => r.source === 'PREPEND')
        .map((r) => r.unitCode),
    ),
  ];
  for (const code of prepended) {
    await manager.query(
      `UPDATE "hr"."org_units" SET "version" = "version" + 1 WHERE "id" = $1`,
      [idOf.get(code)],
    );
  }
  for (const key of new Set(result.revisions.map((r) => r.unitCode))) {
    const isNew = isRefKey(key);
    await audit.record(manager, {
      actor: CLI_ACTOR,
      action: isNew
        ? HrAuditAction.ORG_UNIT_CREATE
        : HrAuditAction.ORG_UNIT_REVISE,
      entity: 'org_unit',
      entityId: idOf.get(key),
      newValue: {
        source: 'BACKFILL_CLI',
        planHash: hash,
        code: codeOf(key),
        ...(isNew && { ref: key.slice(4) }),
        revisions: result.revisions
          .filter((r) => r.unitCode === key)
          .map((r) => ({
            unitType: r.unitType,
            name: r.name,
            parentCode: codeOf(r.parentCode),
            status: r.status,
            effectiveFrom: r.effectiveFrom,
            effectiveTo: r.effectiveTo,
          })),
      },
      reason,
    });
  }
  for (const l of result.leaders) {
    const [row] = await manager.query<{ id: number }[]>(
      `INSERT INTO "hr"."org_unit_leaders"
         ("org_unit_id","employee_id","leader_role","position_id","is_approval_authority",
          "effective_from","effective_to","reason","end_reason")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING "id"`,
      [
        idOf.get(l.unitCode),
        l.employeeId,
        l.leaderRole,
        l.positionId,
        l.isApprovalAuthority,
        l.effectiveFrom,
        l.effectiveTo,
        reason,
        l.effectiveTo === null ? null : reason,
      ],
    );
    await audit.record(manager, {
      actor: CLI_ACTOR,
      action: HrAuditAction.ORG_LEADER_ASSIGN,
      entity: 'org_unit_leader',
      entityId: row.id,
      newValue: {
        source: 'BACKFILL_CLI',
        planHash: hash,
        unitCode: codeOf(l.unitCode),
        employeeCode: l.employeeCode,
        leaderRole: l.leaderRole,
        isApprovalAuthority: l.isApprovalAuthority,
        effectiveFrom: l.effectiveFrom,
        effectiveTo: l.effectiveTo,
      },
      reason,
    });
  }
  await manager.query(
    `INSERT INTO "hr"."org_backfill_runs" ("plan_hash","reason","ref_codes","summary","applied_by")
     VALUES ($1,$2,$3,$4,$5)`,
    [
      hash,
      reason,
      JSON.stringify(Object.fromEntries(refCodes)),
      JSON.stringify({
        newUnits: result.newUnitRefs.length,
        revisions: result.revisions.length,
        leaders: result.leaders.length,
      }),
      CLI_ACTOR.name,
    ],
  );
  return refCodes;
}

async function main() {
  const planPath = arg('plan');
  const reason = (arg('reason') ?? '').trim();
  const apply = process.argv.includes('--apply');
  if (!planPath) throw new Error('Thiếu --plan=<file.json>');
  if (reason.length < 5) throw new Error('Thiếu --reason (tối thiểu 5 ký tự)');
  const url = process.env.HR_MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      'Thiếu HR_MIGRATION_DATABASE_URL — không có kết nối mặc định.',
    );
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as OrgBackfillPlan;
  const hash = planHash(plan);

  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: [HrAuditLog],
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    extra: {
      max: 1,
      options:
        '-c lock_timeout=5000 -c statement_timeout=60000' +
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
    console.log(`Plan hash: ${hash}`);
    await assertRunsTable(ds.manager);
    const today = hrToday();

    const done = await findRun(ds.manager, hash);
    if (done) {
      console.log(
        `\nKế hoạch này ĐÃ được áp dụng (lần #${done.id}, ${done.appliedAt}) — không làm gì.`,
      );
      return;
    }

    const state = await loadState(ds.manager);
    const preview = validateBackfill(plan, state, today);
    let predicted = new Map<string, string>();
    if (!preview.errors.length && preview.newUnitRefs.length) {
      const codes = predictCodes(
        ORG_UNIT_CODES,
        preview.newUnitRefs.length,
        await readSequenceState(ds.manager, ORG_UNIT_CODES),
        new Set(state.unitIds.keys()),
      );
      predicted = new Map(preview.newUnitRefs.map((r, i) => [r, codes[i]]));
    }
    printReport(preview, predicted);
    if (preview.errors.length) process.exit(1);
    if (predicted.size) {
      console.log(
        '\nMã DỰ KIẾN cho đơn vị mới (theo thứ tự phụ thuộc; mã thật in lại sau khi ghi):',
      );
      console.table([...predicted].map(([ref, code]) => ({ ref, code })));
    }
    if (!apply) {
      console.log(
        '\nXem trước hợp lệ — chưa ghi gì. Thêm --apply --confirm-db=<tên_db> (và HR_SETUP_MODE=yes) để thực thi.',
      );
      return;
    }

    if (process.env.HR_SETUP_MODE !== 'yes') {
      throw new Error(
        'Backfill lịch sử chỉ dùng khi thiết lập: người vận hành phải đặt HR_SETUP_MODE=yes.',
      );
    }
    assertApplyAllowed({
      apply,
      confirmDb: arg('confirm-db'),
      actualDb: String(target.db),
      nodeEnv: process.env.NODE_ENV,
      allowProduction: process.env.HR_ALLOW_PRODUCTION_MIGRATION,
      allowCaution: true,
      pending: [{ name: 'org history backfill', risk: 'CAUTION' }],
    });

    const audit = new HrAuditService(ds);
    const outcome = await ds.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [
        HR_ORG_STRUCTURE_LOCK,
      ]);
      const already = await findRun(manager, hash);
      if (already) return { alreadyRun: already.id, codes: null };
      const fresh = await loadState(manager);
      const result = validateBackfill(plan, fresh, today);
      if (result.errors.length) {
        printReport(result, new Map());
        throw new Error(
          'Trạng thái đã thay đổi so với lúc xem trước — không ghi gì.',
        );
      }
      const codes = await write(manager, audit, result, reason, fresh, hash);
      return { alreadyRun: null, codes };
    });
    if (outcome.alreadyRun !== null) {
      console.log(
        `\nKế hoạch vừa được áp dụng bởi lần #${outcome.alreadyRun} — không làm gì.`,
      );
      return;
    }
    if (outcome.codes?.size) {
      console.log('\nMã ĐÃ CẤP cho đơn vị mới:');
      console.table(
        [...outcome.codes].map(([ref, code]) => ({
          ref,
          code,
          ...(predicted.get(ref) !== code && {
            note: `khác dự kiến (${predicted.get(ref)})`,
          }),
        })),
      );
    }
    console.log(
      `\nĐã ghi: ${preview.newUnitRefs.length} đơn vị mới, ${preview.revisions.length} revision, ${preview.leaders.length} lãnh đạo (audit source BACKFILL_CLI, plan hash ${hash.slice(0, 12)}…).`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('LỖI:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
