import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  QueryFailedError,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { addDays } from '../access-admin/hr-grant-policy';
import { HrAccessService } from '../access/hr-access.service';
import type { HrGrant } from '../access/hr-access.service';
import { HrPermission } from '../access/hr-permission';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { hrToday } from '../common/effective-date';
import { CreateOrgUnitDto, ReviseOrgUnitDto } from './dto/organization.dto';
import { OrgUnitRevision } from './entities/org-unit-revision.entity';
import { OrgUnit } from './entities/org-unit.entity';
import { OrgApproverResolver } from './org-approver.resolver';
import {
  canManageUnit,
  canPlaceUnder,
  hasUnrestrictedOrgManage,
  outOfOrgScope,
} from './org-scope';
import { OrgStructureRepository } from './org-structure.repository';
import { OrgNode, OrgSnapshot } from './org-tree';
import { allocateCode, ORG_UNIT_CODES } from './org-code';
import { scopeOptions } from './org-scope-options';
import type { ScopeOptionType } from './org-scope-options';
import { leaderRoleAllowed, OrgLeaderRole } from './org-policy';
import { OrgViolation, structureViolation } from './org-validation';

export function violation(v: OrgViolation, status: 400 | 409 = 409) {
  const body = { statusCode: status, code: v.code, message: v.message };
  return status === 400
    ? new BadRequestException(body)
    : new ConflictException(body);
}

export function versionConflict() {
  return new ConflictException({
    statusCode: 409,
    code: 'HR_VERSION_CONFLICT',
    message: 'Dữ liệu đã bị người khác thay đổi — tải lại rồi thử lại',
  });
}

const AUDIT_ENTITY = 'org_unit';

function revisionView(r: OrgUnitRevision | OrgNode) {
  return {
    unitType: r.unitType,
    name: r.name,
    parentId: r.parentId,
    status: r.status,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  };
}

/**
 * Đơn vị tổ chức có ngày hiệu lực. Không bao giờ UPDATE thuộc tính của một
 * revision: thay đổi = revision mới (thêm vào cuối) + đóng revision trước ở
 * ngày liền trước. Mọi thay đổi chạy dưới advisory lock của cơ cấu và được
 * kiểm tra tại ngày hiệu lực VÀ mọi mốc revision sau đó.
 */
@Injectable()
export class OrgUnitService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly repo: OrgStructureRepository,
    private readonly access: HrAccessService,
    private readonly audit: HrAuditService,
    private readonly approvers: OrgApproverResolver,
  ) {}

  /**
   * Ô chọn phạm vi khi cấp quyền HR: guard đã yêu cầu ACCESS_ADMIN và vừa đọc
   * grant ACCESS_ADMIN của người gọi từ DB (`grants`). Không cần EMPLOYEE_VIEW
   * / ORG_MANAGE — chỉ trả projection tối thiểu, lọc theo phạm vi quản trị.
   */
  async scopeOptions(
    grants: readonly HrGrant[],
    scopeType: ScopeOptionType,
    asOf = hrToday(),
  ) {
    const snapshot = await this.repo.snapshot(this.dataSource.manager, asOf);
    return {
      scopeType,
      asOf,
      options: scopeOptions(snapshot, scopeType, grants),
    };
  }

  /** Xem cơ cấu: EMPLOYEE_VIEW hoặc ORG_MANAGE ở bất kỳ phạm vi nào. */
  async assertCanView(actorId: number) {
    const grants = await this.access.getGrants(actorId);
    if (
      !grants.some(
        (g) =>
          g.permission === HrPermission.EMPLOYEE_VIEW ||
          g.permission === HrPermission.ORG_MANAGE,
      )
    ) {
      throw new ForbiddenException('Bạn không có quyền xem cơ cấu tổ chức');
    }
  }

  async list(actorId: number, asOf = hrToday(), includeInactive = false) {
    await this.assertCanView(actorId);
    const manager = this.dataSource.manager;
    const snapshot = await this.repo.snapshot(manager, asOf);
    const nodes = snapshot
      .all()
      .filter((n) => includeInactive || n.status === 'ACTIVE');
    const leaders = await this.repo.leadersAt(
      manager,
      asOf,
      nodes.map((n) => n.id),
    );
    const units = nodes.length
      ? await manager.find(OrgUnit, {
          where: { id: In(nodes.map((n) => n.id)) },
        })
      : [];
    const versionOf = new Map(units.map((u) => [u.id, u.version]));
    return {
      asOf,
      units: nodes
        .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
        .map((n) => ({
          id: n.id,
          code: n.code,
          version: versionOf.get(n.id) ?? 1,
          ...revisionView(n),
          leaders: leaders
            .filter((l) => l.orgUnitId === n.id)
            .map((l) => ({
              id: l.id,
              employeeId: l.employeeId,
              employeeCode: l.employeeCode,
              employeeName: l.employeeName,
              leaderRole: l.leaderRole,
              isApprovalAuthority: l.isApprovalAuthority,
              positionName: l.positionName,
            })),
        })),
    };
  }

  async get(actorId: number, id: number, asOf = hrToday()) {
    await this.assertCanView(actorId);
    const manager = this.dataSource.manager;
    const unit = await manager.findOne(OrgUnit, { where: { id } });
    if (!unit) throw new NotFoundException('Không tìm thấy đơn vị');
    const revisions = await manager.find(OrgUnitRevision, {
      where: { orgUnitId: id },
      order: { effectiveFrom: 'ASC' },
    });
    const leaders = await manager.query<Record<string, unknown>[]>(
      `SELECT l."id", l."employee_id" AS "employeeId", e."employee_code" AS "employeeCode",
              e."full_name" AS "employeeName", l."leader_role" AS "leaderRole",
              l."is_approval_authority" AS "isApprovalAuthority",
              l."position_id" AS "positionId", p."name" AS "positionName",
              l."effective_from"::text AS "effectiveFrom", l."effective_to"::text AS "effectiveTo",
              l."reason", l."end_reason" AS "endReason", l."version"
         FROM "hr"."org_unit_leaders" l
         JOIN "hr"."employees" e ON e."id" = l."employee_id"
         LEFT JOIN "hr"."positions" p ON p."id" = l."position_id"
        WHERE l."org_unit_id" = $1
        ORDER BY l."effective_from", l."id"`,
      [id],
    );
    const current =
      revisions.find(
        (r) =>
          r.effectiveFrom <= asOf &&
          (r.effectiveTo === null || r.effectiveTo >= asOf),
      ) ?? null;
    return {
      id: unit.id,
      code: unit.code,
      version: unit.version,
      asOf,
      current: current ? revisionView(current) : null,
      revisions: revisions.map((r) => ({
        id: r.id,
        ...revisionView(r),
        reason: r.reason,
      })),
      leaders,
    };
  }

  /** Người duyệt resolve được cho đơn vị tại ngày (xem trước cấu hình). */
  async approverPreview(actorId: number, id: number, asOf = hrToday()) {
    await this.assertCanView(actorId);
    return this.approvers.preview(this.dataSource.manager, id, asOf);
  }

  async create(actorId: number, actor: HrAuditActor, dto: CreateOrgUnitDto) {
    const grants = await this.access.getGrants(
      actorId,
      HrPermission.ORG_MANAGE,
    );
    const from = dto.effectiveFrom ?? hrToday();
    if (dto.unitType === 'COMPANY' && dto.parentId !== undefined) {
      throw violation(
        { code: 'HR_ORG_PARENT_TYPE', message: 'Công ty không có đơn vị cha' },
        400,
      );
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.repo.lock(manager);
        const snapshot = await this.repo.snapshot(manager, from);
        if (
          dto.unitType === 'COMPANY'
            ? !hasUnrestrictedOrgManage(grants)
            : !canPlaceUnder(grants, snapshot, dto.parentId ?? -1)
        ) {
          throw outOfOrgScope();
        }
        const code = await allocateCode(manager, ORG_UNIT_CODES);
        const candidate: OrgNode = {
          id: -1,
          code,
          revisionId: -1,
          unitType: dto.unitType,
          name: dto.name,
          parentId: dto.parentId ?? null,
          status: 'ACTIVE',
          effectiveFrom: from,
          effectiveTo: null,
        };
        await this.assertValidOverTime(manager, candidate, from);

        const inserted = await manager.insert(OrgUnit, {
          code,
          createdBy: actorId,
          version: 1,
        } as QueryDeepPartialEntity<OrgUnit>);
        const id = (inserted.identifiers[0] as { id: number }).id;
        await manager.insert(OrgUnitRevision, {
          orgUnitId: id,
          unitType: candidate.unitType,
          name: candidate.name,
          parentId: candidate.parentId,
          status: 'ACTIVE',
          effectiveFrom: from,
          effectiveTo: null,
          reason: dto.reason,
          createdBy: actorId,
        } as QueryDeepPartialEntity<OrgUnitRevision>);
        await this.audit.record(manager, {
          actor,
          action: HrAuditAction.ORG_UNIT_CREATE,
          entity: AUDIT_ENTITY,
          entityId: id,
          newValue: { code, ...revisionView({ ...candidate, id }) },
          reason: dto.reason,
        });
        return { id, code, version: 1, ...revisionView(candidate) };
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { constraint?: string })?.constraint ===
          'UQ_hr_org_units_code'
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: 'HR_ORG_CODE_EXISTS',
          message: 'Không cấp được mã đơn vị mới — thử lại',
        });
      }
      throw error;
    }
  }

  async revise(
    actorId: number,
    actor: HrAuditActor,
    id: number,
    dto: ReviseOrgUnitDto,
  ) {
    const grants = await this.access.getGrants(
      actorId,
      HrPermission.ORG_MANAGE,
    );
    const from = dto.effectiveFrom;
    if (from < hrToday()) {
      throw violation(
        {
          code: 'HR_ORG_REVISION_PAST',
          message: 'Thay đổi cơ cấu chỉ có hiệu lực từ hôm nay trở đi',
        },
        400,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      await this.repo.lock(manager);
      const unit = await manager
        .getRepository(OrgUnit)
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :id', { id })
        .getOne();
      if (!unit) throw new NotFoundException('Không tìm thấy đơn vị');
      if (unit.version !== dto.version) throw versionConflict();

      const open = await manager.findOne(OrgUnitRevision, {
        where: { orgUnitId: id, effectiveTo: IsNull() },
      });
      if (!open || open.effectiveFrom >= from) {
        throw violation({
          code: 'HR_ORG_REVISION_CONFLICT',
          message:
            'Đã có revision bắt đầu từ ngày này hoặc muộn hơn — không chèn revision vào giữa lịch sử',
        });
      }

      const snapshotBefore = await this.repo.snapshot(manager, from);
      if (!canManageUnit(grants, snapshotBefore, id)) throw outOfOrgScope();

      const next: OrgNode = {
        id,
        code: unit.code,
        revisionId: -1,
        unitType: dto.unitType ?? open.unitType,
        name: dto.name ?? open.name,
        parentId: dto.parentId === undefined ? open.parentId : dto.parentId,
        status: dto.status ?? open.status,
        effectiveFrom: from,
        effectiveTo: null,
      };
      if (next.unitType === 'COMPANY' && dto.parentId === undefined)
        next.parentId = null;
      const changed = (
        ['unitType', 'name', 'parentId', 'status'] as const
      ).filter((k) => next[k] !== open[k]);
      if (!changed.length) {
        throw violation(
          { code: 'HR_ORG_NO_CHANGE', message: 'Không có thay đổi nào' },
          400,
        );
      }
      if (
        next.parentId !== open.parentId &&
        next.parentId !== null &&
        !canPlaceUnder(grants, snapshotBefore, next.parentId)
      ) {
        throw outOfOrgScope();
      }
      if (
        (next.unitType === 'COMPANY' || open.unitType === 'COMPANY') &&
        changed.some((k) => k === 'unitType' || k === 'status') &&
        !hasUnrestrictedOrgManage(grants)
      ) {
        throw outOfOrgScope();
      }

      await this.assertValidOverTime(manager, next, from);
      await this.assertLeadersCompatible(manager, next, from);

      await manager.update(
        OrgUnitRevision,
        { id: open.id },
        {
          effectiveTo: addDays(from, -1),
        },
      );
      await manager.insert(OrgUnitRevision, {
        orgUnitId: id,
        unitType: next.unitType,
        name: next.name,
        parentId: next.parentId,
        status: next.status,
        effectiveFrom: from,
        effectiveTo: null,
        reason: dto.reason,
        createdBy: actorId,
      } as QueryDeepPartialEntity<OrgUnitRevision>);
      await manager.update(OrgUnit, { id }, { version: unit.version + 1 });
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.ORG_UNIT_REVISE,
        entity: AUDIT_ENTITY,
        entityId: id,
        oldValue: revisionView(open),
        newValue: { ...revisionView(next), changed },
        reason: dto.reason,
      });
      return {
        id,
        code: unit.code,
        version: unit.version + 1,
        ...revisionView(next),
      };
    });
  }

  /** Kiểm tra cơ cấu hợp lệ tại `from` và mọi mốc revision sau đó. */
  private async assertValidOverTime(
    manager: EntityManager,
    candidate: OrgNode,
    from: string,
  ) {
    const dates = [from, ...(await this.repo.checkpointsAfter(manager, from))];
    for (const date of dates) {
      const snapshot: OrgSnapshot = (
        await this.repo.snapshot(manager, date)
      ).withNode({
        ...candidate,
        id: candidate.id,
      });
      const v = structureViolation(snapshot, candidate);
      if (v)
        throw violation(
          v,
          v.code === 'HR_ORG_PARENT_TYPE' || v.code === 'HR_ORG_PARENT_REQUIRED'
            ? 400
            : 409,
        );
    }
  }

  /** Đóng đơn vị / đổi loại không được bỏ lại lãnh đạo không hợp lệ. */
  private async assertLeadersCompatible(
    manager: EntityManager,
    next: OrgNode,
    from: string,
  ) {
    const leaders = await this.repo.leadersOverlapping(
      manager,
      next.id,
      from,
      null,
    );
    if (next.status === 'INACTIVE' && leaders.length) {
      throw violation({
        code: 'HR_ORG_HAS_ACTIVE_LEADERS',
        message:
          'Đơn vị còn lãnh đạo hiệu lực từ ngày đóng trở đi — kết thúc vai trò trước',
      });
    }
    const invalid = leaders.find(
      (l) => !leaderRoleAllowed(l.leaderRole as OrgLeaderRole, next.unitType),
    );
    if (invalid) {
      throw violation({
        code: 'HR_ORG_LEADER_ROLE',
        message: `Vai trò ${invalid.leaderRole} còn hiệu lực không phù hợp với loại ${next.unitType}`,
      });
    }
  }
}
