import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { HrAccessService } from '../access/hr-access.service';
import { HrPermission } from '../access/hr-permission';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { hrToday } from '../common/effective-date';
import {
  HrEmployee,
  HrEmployeeStatus,
} from '../employees/entities/hr-employee.entity';
import { AssignOrgLeaderDto, EndOrgLeaderDto } from './dto/organization.dto';
import { OrgUnitLeader } from './entities/org-unit-leader.entity';
import { HrPosition } from './entities/position.entity';
import { OrgUnit } from './entities/org-unit.entity';
import { canManageUnit, outOfOrgScope } from './org-scope';
import { OrgStructureRepository } from './org-structure.repository';
import { periodsOverlap } from './org-policy';
import { leaderViolation } from './org-validation';
import { versionConflict, violation } from './org-unit.service';

const AUDIT_ENTITY = 'org_unit_leader';

function leaderView(l: OrgUnitLeader) {
  return {
    id: l.id,
    orgUnitId: l.orgUnitId,
    employeeId: l.employeeId,
    leaderRole: l.leaderRole,
    positionId: l.positionId,
    isApprovalAuthority: l.isApprovalAuthority,
    effectiveFrom: l.effectiveFrom,
    effectiveTo: l.effectiveTo,
    version: l.version,
  };
}

/**
 * Lãnh đạo đơn vị theo thời gian. Mỗi (đơn vị, vai trò) có tối đa MỘT người
 * duyệt chính tại mỗi thời điểm; phó không bao giờ là người duyệt chính.
 * Đặt lãnh đạo là thao tác `ORG_MANAGE` (có lý do + audit) — không phải
 * bổ nhiệm/điều chuyển nhân viên (Phase 1.4).
 */
@Injectable()
export class OrgLeaderService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly repo: OrgStructureRepository,
    private readonly access: HrAccessService,
    private readonly audit: HrAuditService,
  ) {}

  async assign(
    actorId: number,
    actor: HrAuditActor,
    orgUnitId: number,
    dto: AssignOrgLeaderDto,
  ) {
    const grants = await this.access.getGrants(
      actorId,
      HrPermission.ORG_MANAGE,
    );
    const from = dto.effectiveFrom;
    const to = dto.effectiveTo ?? null;
    if (from < hrToday()) {
      throw violation(
        {
          code: 'HR_ORG_LEADER_PAST',
          message: 'Vai trò lãnh đạo chỉ có hiệu lực từ hôm nay trở đi',
        },
        400,
      );
    }
    if (to !== null && to < from) {
      throw violation(
        {
          code: 'HR_ORG_LEADER_PERIOD',
          message: 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu',
        },
        400,
      );
    }
    if (dto.leaderRole === 'DEPUTY' && dto.isApprovalAuthority) {
      throw violation(
        {
          code: 'HR_ORG_DEPUTY_AUTHORITY',
          message: 'Phó không được đặt làm người duyệt chính',
        },
        400,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      await this.repo.lock(manager);
      if (!(await manager.exists(OrgUnit, { where: { id: orgUnitId } }))) {
        throw new NotFoundException('Không tìm thấy đơn vị');
      }
      const snapshot = await this.repo.snapshot(manager, from);
      if (!canManageUnit(grants, snapshot, orgUnitId)) throw outOfOrgScope();

      const employee = await manager.findOne(HrEmployee, {
        where: { id: dto.employeeId },
      });
      if (!employee || employee.status !== HrEmployeeStatus.ACTIVE) {
        throw violation(
          {
            code: 'HR_ORG_LEADER_EMPLOYEE',
            message: 'Nhân viên không tồn tại hoặc không còn hoạt động',
          },
          400,
        );
      }
      if (dto.positionId !== undefined) {
        const position = await manager.findOne(HrPosition, {
          where: { id: dto.positionId },
        });
        if (!position || !position.isActive) {
          throw violation(
            {
              code: 'HR_ORG_POSITION_INACTIVE',
              message: 'Chức danh không tồn tại hoặc đã ngừng dùng',
            },
            400,
          );
        }
      }

      // Đơn vị phải hoạt động và đúng loại trong suốt khoảng hiệu lực.
      const dates = [
        from,
        ...(await this.repo.checkpointsAfter(manager, from)),
      ].filter((d) => to === null || d <= to);
      for (const date of dates) {
        const v = leaderViolation(
          await this.repo.snapshot(manager, date),
          orgUnitId,
          dto.leaderRole,
        );
        if (v) throw violation(v);
      }

      const existing = await this.repo.leadersOverlapping(
        manager,
        orgUnitId,
        from,
        to,
      );
      const mine = { from, to };
      if (
        existing.some(
          (l) =>
            l.employeeId === dto.employeeId &&
            l.leaderRole === dto.leaderRole &&
            periodsOverlap(mine, { from: l.effectiveFrom, to: l.effectiveTo }),
        )
      ) {
        throw violation({
          code: 'HR_ORG_LEADER_DUPLICATE',
          message: 'Nhân viên đã giữ vai trò này trong khoảng thời gian đó',
        });
      }
      if (
        dto.isApprovalAuthority &&
        existing.some(
          (l) =>
            l.leaderRole === dto.leaderRole &&
            l.isApprovalAuthority &&
            periodsOverlap(mine, { from: l.effectiveFrom, to: l.effectiveTo }),
        )
      ) {
        throw violation({
          code: 'HR_ORG_APPROVER_EXISTS',
          message:
            'Đơn vị đã có người duyệt chính cho vai trò này trong khoảng thời gian đó — kết thúc vai trò cũ trước',
        });
      }

      const inserted = await manager.insert(OrgUnitLeader, {
        orgUnitId,
        employeeId: dto.employeeId,
        leaderRole: dto.leaderRole,
        positionId: dto.positionId ?? null,
        isApprovalAuthority: dto.isApprovalAuthority,
        effectiveFrom: from,
        effectiveTo: to,
        reason: dto.reason,
        endReason: to === null ? null : dto.reason,
        createdBy: actorId,
        version: 1,
      } as QueryDeepPartialEntity<OrgUnitLeader>);
      const id = (inserted.identifiers[0] as { id: number }).id;
      const row = await manager.findOneByOrFail(OrgUnitLeader, { id });
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.ORG_LEADER_ASSIGN,
        entity: AUDIT_ENTITY,
        entityId: id,
        newValue: leaderView(row),
        reason: dto.reason,
      });
      return leaderView(row);
    });
  }

  async end(
    actorId: number,
    actor: HrAuditActor,
    leaderId: number,
    dto: EndOrgLeaderDto,
  ) {
    const grants = await this.access.getGrants(
      actorId,
      HrPermission.ORG_MANAGE,
    );
    return this.dataSource.transaction(async (manager) => {
      await this.repo.lock(manager);
      const row = await manager
        .getRepository(OrgUnitLeader)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.id = :id', { id: leaderId })
        .getOne();
      if (!row) throw new NotFoundException('Không tìm thấy vai trò lãnh đạo');
      if (row.version !== dto.version) throw versionConflict();
      if (row.effectiveTo !== null) {
        throw violation({
          code: 'HR_ORG_LEADER_ENDED',
          message: 'Vai trò này đã có ngày kết thúc',
        });
      }
      const minTo =
        row.effectiveFrom > hrToday() ? row.effectiveFrom : hrToday();
      if (dto.effectiveTo < minTo) {
        throw violation(
          {
            code: 'HR_ORG_LEADER_PERIOD',
            message:
              'Ngày kết thúc không được trước hôm nay hoặc trước ngày bắt đầu',
          },
          400,
        );
      }
      const snapshot = await this.repo.snapshot(manager, dto.effectiveTo);
      if (!canManageUnit(grants, snapshot, row.orgUnitId))
        throw outOfOrgScope();

      await manager.update(OrgUnitLeader, { id: row.id }, {
        effectiveTo: dto.effectiveTo,
        endReason: dto.reason,
        endedAt: () => 'now()',
        endedBy: actorId,
        version: row.version + 1,
      } as QueryDeepPartialEntity<OrgUnitLeader>);
      const updated = await manager.findOneByOrFail(OrgUnitLeader, {
        id: row.id,
      });
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.ORG_LEADER_END,
        entity: AUDIT_ENTITY,
        entityId: row.id,
        oldValue: leaderView(row),
        newValue: leaderView(updated),
        reason: dto.reason,
      });
      return leaderView(updated);
    });
  }
}
