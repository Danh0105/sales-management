import 'dotenv/config';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { HrAuditLog } from '../audit/entities/hr-audit-log.entity';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditService } from '../audit/hr-audit.service';
import { assertApplyAllowed } from './migration-risk';

/**
 * Dọn role `HEALTH_DOCUMENT_VIEWER` (quyết định 05/10/2026: giữ nguyên 6 HR
 * role; HEALTH_DOCUMENT_VIEW cấp riêng từng người bằng quyền lẻ qua Access
 * Admin). Role này chỉ từng có ở DB dev/local qua migration 1791700001120
 * (đã gỡ khỏi repo, chưa lên production).
 *
 *   # Xem trước (mặc định, session chỉ đọc)
 *   HR_MIGRATION_DATABASE_URL=... npm run hr:access:cleanup-health-role
 *   # Thực thi
 *   HR_MIGRATION_DATABASE_URL=... npm run hr:access:cleanup-health-role -- \
 *     --reason="Gỡ role thứ 7 theo quyết định 05/10/2026" --apply --confirm-db=<tên_db>
 *
 * CHỈ đụng đúng role này + dòng `hr.migrations` của migration 1120 — không
 * phải revert chung, không rollback migration nào khác. Từ chối nếu role đã
 * từng được gán (kể cả đã thu hồi): khi đó phải xử lý tay. Chạy lại khi đã dọn
 * → "không còn gì để dọn".
 */
const ROLE = 'HEALTH_DOCUMENT_VIEWER';
const MIGRATION = 'HrHealthDocumentViewerRole1791700001120';

function arg(name: string): string | undefined {
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

async function inspect(manager: EntityManager) {
  const [state] = await manager.query<
    {
      role: number;
      rolePermissions: number;
      assignments: number;
      migration: number;
    }[]
  >(
    `SELECT (SELECT count(*) FROM "hr"."roles" WHERE "code" = $1)::int AS "role",
            (SELECT count(*) FROM "hr"."hr_role_permissions" WHERE "role_code" = $1)::int AS "rolePermissions",
            (SELECT count(*) FROM "hr"."account_role_assignments" WHERE "role_code" = $1)::int AS "assignments",
            (SELECT count(*) FROM "hr"."migrations" WHERE "name" = $2)::int AS "migration"`,
    [ROLE, MIGRATION],
  );
  return state;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const reason = (arg('reason') ?? '').trim();
  const url = process.env.HR_MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      'Thiếu HR_MIGRATION_DATABASE_URL — không có kết nối mặc định.',
    );
  if (apply && reason.length < 5)
    throw new Error('Thiếu --reason (tối thiểu 5 ký tự)');

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
    const state = await inspect(ds.manager);
    console.log(`Trạng thái ${ROLE}:`);
    console.table([state]);
    if (!state.role && !state.rolePermissions && !state.migration) {
      console.log('Không còn gì để dọn.');
      return;
    }
    if (state.assignments) {
      throw new Error(
        `${ROLE} đã từng được gán (${state.assignments} assignment) — không tự dọn; xử lý tay sau khi backup.`,
      );
    }
    if (!apply) {
      console.log(
        'Xem trước xong — chưa ghi gì. Thêm --reason="..." --apply --confirm-db=<tên_db> để thực thi.',
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
      pending: [{ name: `cleanup ${ROLE}`, risk: 'CAUTION' }],
    });

    const audit = new HrAuditService(ds);
    await ds.transaction(async (manager) => {
      // Khoá các dòng liên quan rồi kiểm tra lại trong transaction.
      await manager.query(
        `SELECT 1 FROM "hr"."roles" WHERE "code" = $1 FOR UPDATE`,
        [ROLE],
      );
      const fresh = await inspect(manager);
      if (fresh.assignments) {
        throw new Error(`${ROLE} vừa được gán — không dọn.`);
      }
      await manager.query(
        `DELETE FROM "hr"."hr_role_permissions" WHERE "role_code" = $1`,
        [ROLE],
      );
      await manager.query(`DELETE FROM "hr"."roles" WHERE "code" = $1`, [ROLE]);
      await manager.query(`DELETE FROM "hr"."migrations" WHERE "name" = $1`, [
        MIGRATION,
      ]);
      await audit.record(manager, {
        actor: {
          accountId: null,
          name: 'hr:access:cleanup-health-role (CLI)',
          roles: [],
          ip: null,
          userAgent: 'hr:access:cleanup-health-role',
          requestId: randomUUID(),
        },
        action: HrAuditAction.HR_ROLE_REMOVE,
        entity: 'hr_role',
        entityId: ROLE,
        oldValue: fresh,
        newValue: {
          removed: true,
          migrationRecordRemoved: fresh.migration > 0,
        },
        reason,
      });
    });
    console.log(`Đã dọn ${ROLE}:`);
    console.table([await inspect(ds.manager)]);
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('LỖI:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
