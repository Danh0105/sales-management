import 'dotenv/config';
import { DataSource } from 'typeorm';
import { HrAccountRoleAssignment } from '../access/entities/hr-account-role-assignment.entity';
import { HrRole } from '../access/entities/hr-role.entity';
import { HrScope } from '../access/hr-permission';
import { MIN_PROTECTED_HR_ADMINS } from '../access-safety/hr-admin-quota';
import { HrAccessSafetyService } from '../access-safety/hr-access-safety.service';
import {
  BOOTSTRAP_SCOPES,
  bootstrapPeriodError,
  performBootstrap,
  performPermissionBootstrap,
} from '../access-admin/hr-bootstrap';
import { HrAuditLog } from '../audit/entities/hr-audit-log.entity';
import { HrAuditService } from '../audit/hr-audit.service';
import { hrToday } from '../common/effective-date';
import { assertApplyAllowed } from './migration-risk';

/**
 * Break-glass: cấp HR role quản trị ĐẦU TIÊN (lúc chưa ai có ACCESS_ADMIN để
 * gọi API), khôi phục khi mất hết quản trị, và cấp quyền nhạy cảm BAN ĐẦU có
 * thời hạn (Task 0.3.1 — vì M1 không cho ai cấp quyền mà chính mình chưa có).
 *
 *   npm run hr:access:bootstrap -- --account-id=158 --reason="Trưởng phòng nhân sự"
 *   npm run hr:access:bootstrap -- --account-id=158 --reason="..." --apply --confirm-db=<tên_db>
 *   npm run hr:access:bootstrap -- --account-id=158 --role=HR_SENSITIVE_VIEWER \
 *     --effective-to=2026-12-31 --reason="Initial sensitive access" --apply --confirm-db=<tên_db>
 *
 * Phase 1.3 — cấp MỘT quyền lẻ đầu tiên (vd. HEALTH_DOCUMENT_VIEW):
 *   npm run hr:access:bootstrap -- --account-id=158 --permission=HEALTH_DOCUMENT_VIEW  *     --effective-to=2026-12-31 --reason="Initial health document access" --apply --confirm-db=<tên_db>
 *
 * Role chứa quyền dữ liệu nhạy cảm BẮT BUỘC --effective-to (M2: tối đa
 * MAX_SENSITIVE_ACCESS_DAYS ngày, tính cả hai đầu). Không có assignment nhạy
 * cảm vĩnh viễn qua bootstrap.
 *
 * Mặc định chỉ XEM TRƯỚC (session read-only). Chỉ cấp được scope COMPANY/ALL.
 * Ghi assignment + audit (actor = script) trong cùng một transaction.
 * Production cần thêm HR_ALLOW_PRODUCTION_MIGRATION=yes do người vận hành tự đặt.
 */

function arg(argv: string[], name: string): string | undefined {
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const permissionCode = arg(argv, 'permission');
  if (permissionCode) return bootstrapPermission(argv, permissionCode);
  const apply = argv.includes('--apply');
  const accountId = Number(arg(argv, 'account-id'));
  const roleCode = arg(argv, 'role') ?? 'HR_ADMIN';
  const scope = (arg(argv, 'scope') ?? HrScope.COMPANY) as HrScope;
  const reason = arg(argv, 'reason')?.trim() ?? '';
  const effectiveTo = arg(argv, 'effective-to')?.trim() || null;

  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error('Thiếu hoặc sai --account-id=<id trong public.employee>');
  }
  if (!BOOTSTRAP_SCOPES.includes(scope)) {
    throw new Error(`--scope chỉ nhận ${BOOTSTRAP_SCOPES.join('/')}`);
  }
  if (reason.length < 5) throw new Error('Thiếu --reason (tối thiểu 5 ký tự)');

  const url = process.env.HR_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Thiếu HR_MIGRATION_DATABASE_URL.');

  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: [HrAccountRoleAssignment, HrRole, HrAuditLog],
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
    console.log('Database đích:');
    console.table([target]);

    const [account] = await ds.query<
      { id: number; name: string; roles: string[]; isActive: boolean }[]
    >(
      `SELECT "id", "name", "roles", "isActive" FROM "public"."employee" WHERE "id" = $1`,
      [accountId],
    );
    if (!account) throw new Error(`Không có tài khoản id=${accountId}`);
    if (!account.isActive) throw new Error('Tài khoản đã bị khoá');

    const role = await ds
      .getRepository(HrRole)
      .findOne({ where: { code: roleCode } });
    if (!role || !role.isActive)
      throw new Error(`HR role ${roleCode} không tồn tại hoặc đã tắt`);

    // Kiểm tra thời hạn ngay ở bước xem trước (cùng luật với lúc ghi).
    const permissions = (
      await ds.query<{ code: string }[]>(
        `SELECT "permission_code" AS code FROM "hr"."hr_role_permissions" WHERE "role_code" = $1`,
        [role.code],
      )
    ).map((p) => p.code);
    const periodError = bootstrapPeriodError(
      permissions,
      hrToday(),
      effectiveTo,
    );
    if (periodError) throw new Error(periodError);

    const existing = await ds.getRepository(HrAccountRoleAssignment).find({
      where: { accountId },
    });
    console.log('Tài khoản:');
    console.table([account]);
    console.log('HR role đang có:');
    console.table(
      existing.map(({ id, roleCode: r, scope: s, revokedAt }) => ({
        id,
        role: r,
        scope: s,
        revokedAt,
      })),
    );
    const preview = new HrAccessSafetyService(ds, new HrAuditService(ds));
    const admins = await preview.protectedAdminIds(ds.manager, hrToday());
    console.log(
      `Protected HR admin hiện tại: ${admins.length} [${admins.join(', ')}] (tối thiểu ${MIN_PROTECTED_HR_ADMINS})`,
    );
    console.log(
      `Dự định: cấp ${roleCode} (${scope}) [${permissions.join(', ')}] cho #${accountId} ` +
        `từ ${hrToday()} đến ${effectiveTo ?? 'không thời hạn'} — lý do: "${reason}"`,
    );

    if (!apply) {
      console.log(
        'Xem trước xong — chưa ghi gì. Thêm --apply --confirm-db=<tên_db> để thực thi.',
      );
      return;
    }

    assertApplyAllowed({
      apply,
      confirmDb: arg(argv, 'confirm-db'),
      actualDb: String(target.db),
      nodeEnv: process.env.NODE_ENV,
      allowProduction: process.env.HR_ALLOW_PRODUCTION_MIGRATION,
      allowCaution: true,
      pending: [{ name: `bootstrap ${roleCode}`, risk: 'SAFE' }],
    });

    const audit = new HrAuditService(ds);
    const safety = new HrAccessSafetyService(ds, audit);
    const result = await ds.transaction((manager) =>
      performBootstrap(manager, audit, safety, {
        accountId,
        roleCode,
        scope,
        reason,
        effectiveTo,
      }),
    );
    console.log(
      `Đã cấp: assignment #${result.assignment.id} — ${roleCode} (${scope}) cho #${accountId}. ` +
        `Protected HR admin: ${result.adminsBefore.length} → ${result.adminsAfter.length} ` +
        `(tối thiểu ${MIN_PROTECTED_HR_ADMINS} để vận hành).`,
    );
  } finally {
    await ds.destroy();
  }
}

/** Nhánh --permission: cấp một quyền lẻ đầu tiên (cùng luật thời hạn M2). */
async function bootstrapPermission(
  argv: string[],
  permissionCode: string,
): Promise<void> {
  if (arg(argv, 'role')) {
    throw new Error('Chỉ dùng một trong --role / --permission');
  }
  const apply = argv.includes('--apply');
  const accountId = Number(arg(argv, 'account-id'));
  const scope = (arg(argv, 'scope') ?? HrScope.COMPANY) as HrScope;
  const reason = arg(argv, 'reason')?.trim() ?? '';
  const effectiveTo = arg(argv, 'effective-to')?.trim() || null;
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error('Thiếu hoặc sai --account-id=<id trong public.employee>');
  }
  if (!BOOTSTRAP_SCOPES.includes(scope)) {
    throw new Error(`--scope chỉ nhận ${BOOTSTRAP_SCOPES.join('/')}`);
  }
  if (reason.length < 5) throw new Error('Thiếu --reason (tối thiểu 5 ký tự)');
  const url = process.env.HR_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Thiếu HR_MIGRATION_DATABASE_URL.');

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
    console.log('Database đích:');
    console.table([target]);
    const periodError = bootstrapPeriodError(
      [permissionCode],
      hrToday(),
      effectiveTo,
    );
    if (periodError) throw new Error(periodError);
    const existing = await ds.query<Record<string, unknown>[]>(
      `SELECT "id", "permission_code" AS "permission", "scope", "effective_from"::text AS "from",
              "effective_to"::text AS "to", "revoked_at" AS "revokedAt"
         FROM "hr"."account_permission_grants" WHERE "account_id" = $1 ORDER BY "id"`,
      [accountId],
    );
    console.log('Quyền lẻ đang có:');
    console.table(existing);
    console.log(
      `Dự định: cấp quyền lẻ ${permissionCode} (${scope}) cho #${accountId} ` +
        `từ ${hrToday()} đến ${effectiveTo ?? 'không thời hạn'} — lý do: "${reason}"`,
    );
    if (!apply) {
      console.log(
        'Xem trước xong — chưa ghi gì. Thêm --apply --confirm-db=<tên_db> để thực thi.',
      );
      return;
    }
    assertApplyAllowed({
      apply,
      confirmDb: arg(argv, 'confirm-db'),
      actualDb: String(target.db),
      nodeEnv: process.env.NODE_ENV,
      allowProduction: process.env.HR_ALLOW_PRODUCTION_MIGRATION,
      allowCaution: true,
      pending: [{ name: `bootstrap ${permissionCode}`, risk: 'SAFE' }],
    });
    const audit = new HrAuditService(ds);
    const result = await ds.transaction((manager) =>
      performPermissionBootstrap(manager, audit, {
        accountId,
        permissionCode,
        scope,
        reason,
        effectiveTo,
      }),
    );
    console.log(
      `Đã cấp: quyền lẻ #${result.grantId} — ${permissionCode} (${scope}) cho #${accountId}, ` +
        `${result.effectiveFrom} → ${result.effectiveTo ?? 'không thời hạn'}.`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((error: Error & { driverError?: { code?: string } }) => {
  const duplicate = error.driverError?.code === '23505';
  console.error(
    `\n[hr-bootstrap] DỪNG: ${duplicate ? 'Tài khoản đã có role này (chưa thu hồi).' : error.message}`,
  );
  process.exit(1);
});
