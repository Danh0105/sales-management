import { randomUUID } from 'crypto';
import { EntityManager, IsNull } from 'typeorm';
import { HrAccountRoleAssignment } from '../access/entities/hr-account-role-assignment.entity';
import { HrRole } from '../access/entities/hr-role.entity';
import { HrScope } from '../access/hr-permission';
import { hrToday } from '../common/effective-date';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditService } from '../audit/hr-audit.service';
import { HrAccessSafetyService } from '../access-safety/hr-access-safety.service';
import {
  isSensitiveAccess,
  latestSensitiveEffectiveTo,
  sensitiveDurationError,
} from './hr-grant-policy';

export const BOOTSTRAP_SCOPES: readonly HrScope[] = [
  HrScope.COMPANY,
  HrScope.ALL,
];

export interface BootstrapParams {
  accountId: number;
  roleCode: string;
  scope: HrScope;
  reason: string;
  /**
   * Ngày cuối còn hiệu lực (YYYY-MM-DD, inclusive). BẮT BUỘC với role chứa
   * quyền dữ liệu nhạy cảm (M2, tối đa MAX_SENSITIVE_ACCESS_DAYS ngày tính cả
   * hai đầu). Bỏ trống với role thường = không thời hạn (vd. protected HR_ADMIN).
   */
  effectiveTo?: string | null;
}

export class BootstrapError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Kiểm tra thời hạn bootstrap — dùng cả ở bước xem trước của CLI lẫn lúc ghi.
 * Trả lỗi, hoặc null nếu hợp lệ. Không tự sửa ngày người vận hành nhập.
 */
export function bootstrapPeriodError(
  rolePermissions: readonly string[],
  effectiveFrom: string,
  effectiveTo: string | null,
): string | null {
  if (effectiveTo !== null) {
    if (!ISO_DATE.test(effectiveTo) || Number.isNaN(Date.parse(effectiveTo))) {
      return `--effective-to phải có dạng YYYY-MM-DD, nhận được "${effectiveTo}"`;
    }
    if (effectiveTo < effectiveFrom) {
      return `--effective-to (${effectiveTo}) phải từ ngày ${effectiveFrom} trở đi`;
    }
  }
  if (isSensitiveAccess(rolePermissions)) {
    const error = sensitiveDurationError(effectiveFrom, effectiveTo);
    if (error) {
      return `${error} Role chứa quyền dữ liệu nhạy cảm: bootstrap bắt buộc --effective-to, muộn nhất ${latestSensitiveEffectiveTo(effectiveFrom)}.`;
    }
  }
  return null;
}

/**
 * Lõi của `hr:access:bootstrap` — cấp HR role quản trị khi chưa ai (hoặc không
 * còn ai) gọi được API. Phải chạy trong transaction: assignment + audit cùng
 * commit/rollback, và giữ khoá quản trị để không chồng lên thao tác thu hồi.
 *
 * Chỉ THÊM quản trị — không bao giờ làm giảm số quản trị, nên không bị luật
 * tối thiểu chặn (kể cả lúc mới có 0 quản trị). Không sửa `employee.roles`.
 */
export async function performBootstrap(
  manager: EntityManager,
  audit: HrAuditService,
  safety: HrAccessSafetyService,
  params: BootstrapParams,
) {
  const reason = params.reason.trim();
  if (reason.length < 5) {
    throw new BootstrapError('Thiếu lý do (tối thiểu 5 ký tự)');
  }
  if (!BOOTSTRAP_SCOPES.includes(params.scope)) {
    throw new BootstrapError(
      `Bootstrap chỉ nhận scope ${BOOTSTRAP_SCOPES.join('/')}`,
    );
  }

  await safety.lock(manager);

  const [account] = await manager.query<{ id: number; isActive: boolean }[]>(
    `SELECT "id", "isActive" FROM "public"."employee" WHERE "id" = $1`,
    [params.accountId],
  );
  if (!account) {
    throw new BootstrapError(`Không có tài khoản id=${params.accountId}`);
  }
  if (!account.isActive) throw new BootstrapError('Tài khoản đã bị khoá');

  const role = await manager
    .getRepository(HrRole)
    .findOne({ where: { code: params.roleCode } });
  if (!role || !role.isActive) {
    throw new BootstrapError(
      `HR role ${params.roleCode} không tồn tại hoặc đã tắt`,
    );
  }

  // M2: role chứa quyền xem dữ liệu nhạy cảm (lương, CCCD, tài khoản ngân
  // hàng) chỉ được bootstrap CÓ THỜI HẠN, không quá MAX_SENSITIVE_ACCESS_DAYS
  // ngày. Chỉ cấp đúng các quyền của role được chỉ định — không thêm gì khác.
  // SQL thuần (không qua entity) để script CLI không cần đăng ký thêm entity.
  const permissions = (
    await manager.query<{ code: string }[]>(
      `SELECT "permission_code" AS code FROM "hr"."hr_role_permissions" WHERE "role_code" = $1`,
      [role.code],
    )
  ).map((p) => p.code);
  const on = hrToday();
  const effectiveTo = params.effectiveTo ?? null;
  const periodError = bootstrapPeriodError(permissions, on, effectiveTo);
  if (periodError) throw new BootstrapError(periodError);
  const sensitiveAccess = isSensitiveAccess(permissions);

  const repo = manager.getRepository(HrAccountRoleAssignment);
  const duplicate = await repo.findOne({
    where: {
      accountId: params.accountId,
      roleCode: params.roleCode,
      scope: params.scope,
      scopeRefId: IsNull(),
      revokedAt: IsNull(),
    },
  });
  if (duplicate) {
    throw new BootstrapError(
      `Tài khoản đã có ${params.roleCode} (${params.scope}) chưa thu hồi — assignment #${duplicate.id}. Không tạo trùng.`,
    );
  }

  const before = await safety.protectedAdminIds(manager, on);

  const result = await repo.insert({
    accountId: params.accountId,
    roleCode: params.roleCode,
    scope: params.scope,
    scopeRefId: null,
    effectiveFrom: on,
    effectiveTo,
    reason,
    grantedBy: null,
  });
  const id = (result.identifiers[0] as { id: number }).id;
  const assignment = (await repo.findOne({ where: { id } }))!;
  const after = await safety.protectedAdminIds(manager, on);

  await audit.record(manager, {
    actor: {
      accountId: null,
      name: 'hr-bootstrap-script',
      roles: [],
      ip: null,
      userAgent: 'hr:access:bootstrap',
      requestId: randomUUID(),
    },
    action: HrAuditAction.ACCESS_GRANT,
    entity: 'account_role_assignment',
    entityId: id,
    oldValue: null,
    newValue: {
      id,
      accountId: params.accountId,
      roleCode: params.roleCode,
      scope: params.scope,
      effectiveFrom: assignment.effectiveFrom,
      effectiveTo: assignment.effectiveTo,
      grantedPermissions: permissions,
      sensitiveAccess,
      via: 'bootstrap',
      protectedAdminCount: { before: before.length, after: after.length },
    },
    reason,
  });

  return { assignment, adminsBefore: before, adminsAfter: after };
}

export interface PermissionBootstrapParams {
  accountId: number;
  permissionCode: string;
  scope: HrScope;
  reason: string;
  effectiveTo?: string | null;
}

/**
 * Phase 1.3 — break-glass cấp MỘT quyền lẻ ĐẦU TIÊN (vd. HEALTH_DOCUMENT_VIEW:
 * M1 không cho ai cấp quyền mà chính mình chưa có). Cùng luật thời hạn (M2)
 * với bootstrap role; sau đó người giữ quyền cấp tiếp qua Access Admin API.
 * ACCESS_ADMIN không cấp lẻ (quản trị chỉ qua role HR_ADMIN + luật tối thiểu).
 * Phải chạy trong transaction: quyền + audit cùng commit/rollback.
 */
export async function performPermissionBootstrap(
  manager: EntityManager,
  audit: HrAuditService,
  params: PermissionBootstrapParams,
) {
  const reason = params.reason.trim();
  if (reason.length < 5) {
    throw new BootstrapError('Thiếu lý do (tối thiểu 5 ký tự)');
  }
  if (!BOOTSTRAP_SCOPES.includes(params.scope)) {
    throw new BootstrapError(
      `Bootstrap chỉ nhận scope ${BOOTSTRAP_SCOPES.join('/')}`,
    );
  }
  if (params.permissionCode === 'ACCESS_ADMIN') {
    throw new BootstrapError(
      'ACCESS_ADMIN không cấp lẻ — dùng --role=HR_ADMIN (luật số quản trị tối thiểu)',
    );
  }
  const [account] = await manager.query<{ id: number; isActive: boolean }[]>(
    `SELECT "id", "isActive" FROM "public"."employee" WHERE "id" = $1`,
    [params.accountId],
  );
  if (!account) {
    throw new BootstrapError(`Không có tài khoản id=${params.accountId}`);
  }
  if (!account.isActive) throw new BootstrapError('Tài khoản đã bị khoá');
  const [permission] = await manager.query<{ code: string }[]>(
    `SELECT "code" FROM "hr"."permissions" WHERE "code" = $1`,
    [params.permissionCode],
  );
  if (!permission) {
    throw new BootstrapError(
      `Quyền ${params.permissionCode} không có trong hr.permissions`,
    );
  }
  const on = hrToday();
  const effectiveTo = params.effectiveTo ?? null;
  const periodError = bootstrapPeriodError(
    [params.permissionCode],
    on,
    effectiveTo,
  );
  if (periodError) throw new BootstrapError(periodError);

  const [duplicate] = await manager.query<{ id: number }[]>(
    `SELECT "id" FROM "hr"."account_permission_grants"
      WHERE "account_id" = $1 AND "permission_code" = $2 AND "scope" = $3
        AND "scope_ref_id" IS NULL AND "revoked_at" IS NULL
        AND ("effective_to" IS NULL OR "effective_to" >= $4::date)
      FOR UPDATE`,
    [params.accountId, params.permissionCode, params.scope, on],
  );
  if (duplicate) {
    throw new BootstrapError(
      `Tài khoản đã có quyền ${params.permissionCode} (${params.scope}) chưa thu hồi — quyền lẻ #${duplicate.id}. Không tạo trùng.`,
    );
  }
  const [row] = await manager.query<
    { id: number; effectiveFrom: string; effectiveTo: string | null }[]
  >(
    `INSERT INTO "hr"."account_permission_grants"
       ("account_id","permission_code","scope","scope_ref_id","effective_from","effective_to","reason","granted_by")
     VALUES ($1,$2,$3,NULL,$4,$5,$6,NULL)
     RETURNING "id", "effective_from"::text AS "effectiveFrom", "effective_to"::text AS "effectiveTo"`,
    [
      params.accountId,
      params.permissionCode,
      params.scope,
      on,
      effectiveTo,
      reason,
    ],
  );
  const sensitiveAccess = isSensitiveAccess([params.permissionCode]);
  await audit.record(manager, {
    actor: {
      accountId: null,
      name: 'hr-bootstrap-script',
      roles: [],
      ip: null,
      userAgent: 'hr:access:bootstrap',
      requestId: randomUUID(),
    },
    action: HrAuditAction.ACCESS_GRANT,
    entity: 'account_permission_grant',
    entityId: row.id,
    oldValue: null,
    newValue: {
      id: row.id,
      accountId: params.accountId,
      permissionCode: params.permissionCode,
      scope: params.scope,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      grantedPermissions: [params.permissionCode],
      sensitiveAccess,
      via: 'bootstrap',
    },
    reason,
  });
  return { grantId: row.id, sensitiveAccess, ...row };
}
