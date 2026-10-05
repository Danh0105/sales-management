import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { HrAccountRoleAssignment } from '../access/entities/hr-account-role-assignment.entity';
import { HrAccessRepository } from '../access/hr-access.repository';
import { HrAccessService, HrGrant } from '../access/hr-access.service';
import { HrPermission, HrScope } from '../access/hr-permission';
import { scopeRefError } from '../access/hr-scope-rules';
import { hrToday } from '../common/effective-date';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { AssignHrRoleDto } from './dto/assign-hr-role.dto';
import { RevokeHrRoleAssignmentDto } from './dto/revoke-hr-role-assignment.dto';
import { HrAccessSafetyService } from '../access-safety/hr-access-safety.service';
import {
  grantScopeCovers,
  isSensitiveAccess,
  latestSensitiveEffectiveTo,
  MAX_SENSITIVE_ACCESS_DAYS,
  sensitiveDurationError,
  uncoveredPermissions,
} from './hr-grant-policy';
import { HrRoleAdminRepository } from './hr-role-admin.repository';
import { isScopeOptionType } from '../organization/org-scope-options';
import { OrgScopeUnitValidator } from '../organization/org-scope-unit.validator';

const AUDIT_ENTITY = 'account_role_assignment';
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code ===
      UNIQUE_VIOLATION
  );
}

/** Ảnh chụp assignment cho audit — không kèm dữ liệu cá nhân nào. */
function snapshot(a: HrAccountRoleAssignment) {
  return {
    id: a.id,
    accountId: a.accountId,
    roleCode: a.roleCode,
    scope: a.scope,
    scopeRefId: a.scopeRefId,
    effectiveFrom: a.effectiveFrom,
    effectiveTo: a.effectiveTo,
    revokedAt: a.revokedAt,
    revokedBy: a.revokedBy,
    version: a.version,
  };
}

/**
 * Cấp / thu hồi HR role. Mọi luật đều enforce ở đây (backend), không dựa vào FE:
 *
 * 0. Scope BRANCH/ORG_UNIT phải gắn đơn vị thật, ACTIVE, đúng loại tại
 *    effectiveFrom (OrgScopeUnitValidator) — sai → 400 HR_SCOPE_UNIT_INVALID.
 * 1. Cần ACCESS_ADMIN (guard) VÀ tài khoản đích nằm trong phạm vi ACCESS_ADMIN
 *    của người thao tác — ngoài phạm vi trả 404 như không tồn tại (chống IDOR).
 * 2. Không tự cấp / tự thu hồi quyền của chính mình.
 * 3. Không cấp/thu hồi scope rộng hơn phạm vi ACCESS_ADMIN của chính mình.
 *    M1: mọi quyền trong role được cấp phải nằm trong quyền hiệu lực của người
 *    cấp, ở phạm vi chứa phạm vi được cấp (hr-grant-policy.ts) → 403.
 *    M2: role chứa quyền xem dữ liệu nhạy cảm phải có effectiveTo, tối đa
 *    MAX_SENSITIVE_ACCESS_DAYS ngày → 400.
 * 4. Chống trùng: kiểm tra trước + unique index trong DB (chặn cả race).
 * 5. Thu hồi theo version → lệch version trả 409, không ghi đè im lặng.
 * 6. Ghi dữ liệu + audit trong CÙNG một transaction.
 * 7. Thu hồi không được làm số protected HR admin giảm xuống dưới mức tối
 *    thiểu (409 HR_ADMIN_MINIMUM) — HrAccessSafetyService, dưới advisory lock
 *    + SELECT FOR UPDATE.
 */
@Injectable()
export class HrRoleAdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly repo: HrRoleAdminRepository,
    private readonly accounts: HrAccessRepository,
    private readonly access: HrAccessService,
    private readonly audit: HrAuditService,
    private readonly safety: HrAccessSafetyService,
    private readonly scopeUnits: OrgScopeUnitValidator,
  ) {}

  listRoles() {
    return this.repo.listRoles();
  }

  async rolePermissions(code: string) {
    const role = await this.repo.findRole(code);
    if (!role) throw new NotFoundException('Không tìm thấy HR role');
    return {
      role,
      permissions: await this.repo.listRolePermissionCodes(code),
    };
  }

  async accountAssignments(viewerId: number, accountId: number) {
    await this.access.assertCanAccess(viewerId, HrPermission.ACCESS_VIEW, {
      accountId,
    });
    const on = hrToday();
    const rows = await this.repo.listAssignments(accountId);
    return {
      accountId,
      on,
      assignments: rows.map((a) => ({
        ...a,
        active:
          a.revokedAt === null &&
          a.effectiveFrom <= on &&
          (a.effectiveTo === null || a.effectiveTo >= on),
      })),
    };
  }

  async assign(
    actorId: number,
    actor: HrAuditActor,
    accountId: number,
    dto: AssignHrRoleDto,
  ): Promise<HrAccountRoleAssignment> {
    if (accountId === actorId) {
      throw new ForbiddenException(
        'Không được tự cấp HR role cho chính mình — cần một quản trị viên khác',
      );
    }

    // Thứ tự kiểm tra (chốt 01/10/2026): ngày → hình dạng scope → đơn vị của
    // scope → tài khoản đích trong phạm vi → M2 → M1 → ghi.
    const today = hrToday();
    const effectiveFrom = dto.effectiveFrom ?? today;
    const effectiveTo = dto.effectiveTo ?? null;
    if (effectiveFrom < today) {
      throw new BadRequestException(
        'Không cấp quyền hiệu lực từ quá khứ (effectiveFrom < hôm nay)',
      );
    }
    if (effectiveTo !== null && effectiveTo < effectiveFrom) {
      throw new BadRequestException(
        'effectiveTo phải sau hoặc bằng effectiveFrom',
      );
    }

    const requested = {
      scope: dto.scope,
      scopeRefId: dto.scopeRefId ?? null,
    };
    const refError = scopeRefError(requested.scope, dto.scopeRefId);
    if (refError) throw new BadRequestException(refError);

    // Đơn vị của scope BRANCH/ORG_UNIT phải là đơn vị thật, ACTIVE, đúng loại
    // tại effectiveFrom (luật của Organization — một nguồn sự thật). Một lỗi
    // chung, không nói lý do. Đơn vị hợp lệ nhưng ngoài quyền người cấp vẫn do
    // kiểm tra phạm vi / M1 bên dưới xử lý như trước.
    if (
      isScopeOptionType(requested.scope) &&
      !(await this.scopeUnits.isValid(
        requested.scope,
        requested.scopeRefId!,
        effectiveFrom,
      ))
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'HR_SCOPE_UNIT_INVALID',
        message:
          'Đơn vị của phạm vi quyền không hợp lệ tại ngày hiệu lực — chọn lại đơn vị.',
      });
    }

    // Phạm vi tài khoản đích — ngoài phạm vi thì 404, không lộ thêm gì.
    await this.access.assertCanAccess(actorId, HrPermission.ACCESS_ADMIN, {
      accountId,
    });

    const role = await this.repo.findRole(dto.roleCode);
    if (!role || !role.isActive) {
      throw new BadRequestException(
        `HR role ${dto.roleCode} không tồn tại hoặc đã tắt`,
      );
    }
    const rolePermissions = await this.repo.listRolePermissionCodes(role.code);

    // M2 — role chứa quyền xem dữ liệu nhạy cảm phải có hạn, tối đa
    // MAX_SENSITIVE_ACCESS_DAYS ngày lịch (tính cả hai đầu). Kiểm tra TRƯỚC M1
    // để thiếu effectiveTo báo đúng lỗi, không bị M1 báo "thời hạn không phủ".
    const sensitiveAccess = isSensitiveAccess(rolePermissions);
    const durationError = sensitiveAccess
      ? sensitiveDurationError(effectiveFrom, effectiveTo)
      : null;
    if (durationError) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'HR_SENSITIVE_ACCESS_DURATION',
        message: durationError,
        maxDays: MAX_SENSITIVE_ACCESS_DAYS,
        latestEffectiveTo: latestSensitiveEffectiveTo(effectiveFrom),
      });
    }

    // M1 — permission + scope + thời hạn phải nằm trong quyền hiệu lực THỰC
    // TẾ của người cấp (mọi nguồn, đọc mới từ DB). Không tự rút ngắn thời hạn.
    const actorGrants = await this.access.getGrants(actorId);
    this.assertScopeWithinOwnAdmin(actorGrants, requested, 'cấp');
    const uncovered = uncoveredPermissions(
      rolePermissions,
      actorGrants,
      requested,
      { effectiveFrom, effectiveTo },
    );
    if (uncovered.length) {
      const list = uncovered
        .map((u) =>
          u.reason === 'PERIOD_NOT_COVERED'
            ? `${u.permission} (period)`
            : u.permission,
        )
        .join(', ');
      throw new ForbiddenException({
        statusCode: 403,
        code: 'HR_GRANT_EXCEEDS_OWN_ACCESS',
        message: `Cannot grant permissions beyond your own access (permission, scope or period): ${list}.`,
        messageVi: `Không được cấp quyền vượt quyền của chính bạn (loại quyền, phạm vi hoặc thời hạn): ${list}.`,
        missingPermissions: uncovered
          .filter((u) => u.reason === 'NOT_HELD_AT_SCOPE')
          .map((u) => u.permission),
        periodNotCovered: uncovered
          .filter((u) => u.reason === 'PERIOD_NOT_COVERED')
          .map((u) => ({
            permission: u.permission,
            yourEffectiveTo: u.actorEffectiveTo ?? null,
          })),
      });
    }

    const account = await this.accounts.findAccount(accountId);
    if (!account) throw new NotFoundException('Không tìm thấy dữ liệu');
    if (!account.isActive) {
      throw new BadRequestException('Tài khoản đã bị khoá — không cấp quyền');
    }

    const row = {
      accountId,
      roleCode: role.code,
      ...requested,
      effectiveFrom,
      effectiveTo,
      reason: dto.reason,
      grantedBy: actorId,
    };

    try {
      return await this.dataSource.manager.transaction(async (manager) => {
        const duplicate = await this.repo.findUnrevokedDuplicate(manager, row);
        if (duplicate) {
          throw new ConflictException({
            message: `Tài khoản đã có ${role.code} (${requested.scope}) chưa thu hồi — assignment #${duplicate.id}`,
            existingAssignmentId: duplicate.id,
          });
        }

        const created = await this.repo.insertAssignment(manager, row);
        await this.audit.record(manager, {
          actor,
          action: HrAuditAction.ACCESS_GRANT,
          entity: AUDIT_ENTITY,
          entityId: created.id,
          oldValue: null,
          newValue: {
            ...snapshot(created),
            grantedPermissions: rolePermissions,
            sensitiveAccess,
          },
          reason: dto.reason,
        });
        return created;
      });
    } catch (error) {
      // Hai request cấp cùng lúc: request sau vấp unique index trong DB.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Tài khoản đã có ${role.code} (${requested.scope}) chưa thu hồi`,
        );
      }
      throw error;
    }
  }

  async revoke(
    actorId: number,
    actor: HrAuditActor,
    assignmentId: number,
    dto: RevokeHrRoleAssignmentDto,
  ): Promise<HrAccountRoleAssignment> {
    const current = await this.repo.findAssignment(assignmentId);
    if (!current) throw new NotFoundException('Không tìm thấy dữ liệu');

    // Kiểm tra phạm vi TRƯỚC mọi phản hồi khác: ngoài phạm vi = 404 giống hệt
    // không tồn tại, không để lộ assignment của người khác có thật hay không.
    await this.access.assertCanAccess(actorId, HrPermission.ACCESS_ADMIN, {
      accountId: current.accountId,
    });

    if (current.accountId === actorId) {
      throw new ForbiddenException(
        'Không được tự thu hồi HR role của chính mình — cần một quản trị viên khác',
      );
    }
    this.assertScopeWithinOwnAdmin(
      await this.access.getGrants(actorId, HrPermission.ACCESS_ADMIN),
      current,
      'thu hồi',
    );

    // Kiểm tra sớm để trả lỗi rõ ràng; kiểm tra lại dưới khoá bên trong transaction.
    this.assertRevocable(current, dto.version);

    return this.dataSource.manager.transaction(async (manager) => {
      // 1. Xếp hàng mọi thao tác có thể làm giảm số quản trị (advisory lock), rồi
      //    khoá dòng assignment. Từ đây tới commit không ai đổi được hai thứ này.
      await this.safety.lock(manager);
      const locked = await this.repo.findAssignmentForUpdate(
        manager,
        assignmentId,
      );
      if (!locked) throw new NotFoundException('Không tìm thấy dữ liệu');
      this.assertRevocable(locked, dto.version);

      // 2. Đếm protected admin trước/sau NGAY TRONG khoá (service trung tâm,
      //    dùng chung với module employee) — 409 HR_ADMIN_MINIMUM nếu thiếu.
      const quota = await this.safety.assertCanRevokeAssignment(
        manager,
        assignmentId,
      );

      const affected = await this.repo.revokeAssignment(
        manager,
        assignmentId,
        dto.version,
        actorId,
        dto.reason,
      );
      if (affected !== 1) {
        throw new ConflictException(
          'Dữ liệu đã bị người khác thay đổi — tải lại rồi thử lại',
        );
      }

      const revoked = (await this.repo.findAssignment(assignmentId, manager))!;
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.ACCESS_REVOKE,
        entity: AUDIT_ENTITY,
        entityId: assignmentId,
        oldValue: snapshot(locked),
        newValue: {
          ...snapshot(revoked),
          protectedAdminCount: quota,
        },
        reason: dto.reason,
      });
      return revoked;
    });
  }

  adminStatus() {
    return this.safety.getAdminStatus();
  }

  private assertRevocable(a: HrAccountRoleAssignment, version: number): void {
    if (a.revokedAt) {
      throw new ConflictException('Assignment đã được thu hồi trước đó');
    }
    if (a.version !== version) {
      throw new ConflictException({
        message: 'Dữ liệu đã bị người khác thay đổi — tải lại rồi thử lại',
        currentVersion: a.version,
      });
    }
  }

  /**
   * Không cấp/thu hồi scope rộng hơn phạm vi ACCESS_ADMIN của chính mình —
   * cùng luật "tập con theo dữ liệu" của M1 (`grantScopeCovers`).
   */
  private assertScopeWithinOwnAdmin(
    actorGrants: readonly HrGrant[],
    requested: { scope: HrScope; scopeRefId: number | null },
    verb: string,
  ): void {
    const covered = actorGrants.some(
      (g) =>
        g.permission === HrPermission.ACCESS_ADMIN &&
        grantScopeCovers(g, requested),
    );
    if (!covered) {
      throw new ForbiddenException(
        `Không được ${verb} scope ${requested.scope} — rộng hơn phạm vi quản trị của bạn`,
      );
    }
  }
}
