import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { HrAccessService } from '../access/hr-access.service';
import { HrPermission } from '../access/hr-permission';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { hrToday } from '../common/effective-date';
import {
  CreateLegacyOrgMappingDto,
  CreatePositionDto,
  UpdatePositionDto,
  VersionReasonDto,
} from './dto/organization.dto';
import { LegacyOrgMapping } from './entities/legacy-org-mapping.entity';
import { HrPosition } from './entities/position.entity';
import { allocateCode, POSITION_CODES } from './org-code';
import { hasUnrestrictedOrgManage, outOfOrgScope } from './org-scope';
import { OrgStructureRepository } from './org-structure.repository';
import { versionConflict, violation } from './org-unit.service';

const uniqueViolation = (error: unknown, constraint: string) =>
  error instanceof QueryFailedError &&
  (error.driverError as { constraint?: string })?.constraint === constraint;

function positionView(p: HrPosition) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    level: p.level,
    isActive: p.isActive,
    version: p.version,
  };
}

/**
 * Danh mục dùng chung toàn công ty (chức danh, mapping import) — chỉ
 * `ORG_MANAGE` ở phạm vi COMPANY/ALL được sửa; xem cần EMPLOYEE_VIEW/ORG_MANAGE.
 */
@Injectable()
export class OrgCatalogService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly repo: OrgStructureRepository,
    private readonly access: HrAccessService,
    private readonly audit: HrAuditService,
  ) {}

  private async assertCatalogManager(actorId: number) {
    const grants = await this.access.getGrants(
      actorId,
      HrPermission.ORG_MANAGE,
    );
    if (!hasUnrestrictedOrgManage(grants)) throw outOfOrgScope();
  }

  listPositions() {
    return this.dataSource
      .getRepository(HrPosition)
      .find({ order: { code: 'ASC' } })
      .then((r) => r.map(positionView));
  }

  async createPosition(
    actorId: number,
    actor: HrAuditActor,
    dto: CreatePositionDto,
  ) {
    await this.assertCatalogManager(actorId);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const code = await allocateCode(manager, POSITION_CODES);
        const inserted = await manager.insert(HrPosition, {
          code,
          name: dto.name,
          level: dto.level ?? null,
          isActive: true,
          createdBy: actorId,
          updatedBy: actorId,
          version: 1,
        } as QueryDeepPartialEntity<HrPosition>);
        const id = (inserted.identifiers[0] as { id: number }).id;
        const row = await manager.findOneByOrFail(HrPosition, { id });
        await this.audit.record(manager, {
          actor,
          action: HrAuditAction.POSITION_CREATE,
          entity: 'position',
          entityId: id,
          newValue: positionView(row),
        });
        return positionView(row);
      });
    } catch (error) {
      if (uniqueViolation(error, 'UQ_hr_positions_code')) {
        throw new ConflictException({
          statusCode: 409,
          code: 'HR_POSITION_CODE_EXISTS',
          message: 'Không cấp được mã chức danh mới — thử lại',
        });
      }
      throw error;
    }
  }

  async updatePosition(
    actorId: number,
    actor: HrAuditActor,
    id: number,
    dto: UpdatePositionDto,
  ) {
    await this.assertCatalogManager(actorId);
    return this.dataSource.transaction(async (manager) => {
      const row = await manager
        .getRepository(HrPosition)
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id = :id', { id })
        .getOne();
      if (!row) throw new NotFoundException('Không tìm thấy chức danh');
      if (row.version !== dto.version) throw versionConflict();
      const patch = {
        name: dto.name ?? row.name,
        level: dto.level === undefined ? row.level : dto.level,
      };
      if (patch.name === row.name && patch.level === row.level) {
        throw violation(
          { code: 'HR_ORG_NO_CHANGE', message: 'Không có thay đổi nào' },
          400,
        );
      }
      await manager.update(HrPosition, { id }, {
        ...patch,
        updatedBy: actorId,
        updatedAt: () => 'now()',
        version: row.version + 1,
      } as QueryDeepPartialEntity<HrPosition>);
      const updated = await manager.findOneByOrFail(HrPosition, { id });
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.POSITION_UPDATE,
        entity: 'position',
        entityId: id,
        oldValue: positionView(row),
        newValue: positionView(updated),
      });
      return positionView(updated);
    });
  }

  async deactivatePosition(
    actorId: number,
    actor: HrAuditActor,
    id: number,
    dto: VersionReasonDto,
  ) {
    await this.assertCatalogManager(actorId);
    return this.dataSource.transaction(async (manager) => {
      const row = await manager
        .getRepository(HrPosition)
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id = :id', { id })
        .getOne();
      if (!row) throw new NotFoundException('Không tìm thấy chức danh');
      if (row.version !== dto.version) throw versionConflict();
      if (!row.isActive)
        throw violation({
          code: 'HR_POSITION_INACTIVE',
          message: 'Chức danh đã ngừng dùng',
        });
      await manager.update(HrPosition, { id }, {
        isActive: false,
        updatedBy: actorId,
        updatedAt: () => 'now()',
        version: row.version + 1,
      } as QueryDeepPartialEntity<HrPosition>);
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.POSITION_DEACTIVATE,
        entity: 'position',
        entityId: id,
        oldValue: positionView(row),
        reason: dto.reason,
      });
      return {
        ...positionView(row),
        isActive: false,
        version: row.version + 1,
      };
    });
  }

  listMappings() {
    return this.dataSource.getRepository(LegacyOrgMapping).find({
      order: { sourceType: 'ASC', priority: 'ASC', sourceValue: 'ASC' },
    });
  }

  async createMapping(
    actorId: number,
    actor: HrAuditActor,
    dto: CreateLegacyOrgMappingDto,
  ) {
    await this.assertCatalogManager(actorId);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const unit = (await this.repo.snapshot(manager, hrToday())).get(
          dto.orgUnitId,
        );
        if (!unit || unit.status !== 'ACTIVE') {
          throw violation(
            {
              code: 'HR_ORG_UNIT_INACTIVE',
              message: 'Đơn vị không hoạt động hôm nay',
            },
            400,
          );
        }
        const inserted = await manager.insert(LegacyOrgMapping, {
          sourceType: dto.sourceType,
          sourceValue: dto.sourceValue,
          orgUnitId: dto.orgUnitId,
          priority: dto.priority ?? 100,
          isActive: true,
          createdBy: actorId,
          version: 1,
        } as QueryDeepPartialEntity<LegacyOrgMapping>);
        const id = (inserted.identifiers[0] as { id: number }).id;
        const row = await manager.findOneByOrFail(LegacyOrgMapping, { id });
        await this.audit.record(manager, {
          actor,
          action: HrAuditAction.LEGACY_ORG_MAPPING_CREATE,
          entity: 'legacy_org_mapping',
          entityId: id,
          newValue: {
            sourceType: row.sourceType,
            sourceValue: row.sourceValue,
            orgUnitId: row.orgUnitId,
            priority: row.priority,
          },
        });
        return row;
      });
    } catch (error) {
      if (uniqueViolation(error, 'UQ_hr_legacy_org_mappings_active')) {
        throw new ConflictException({
          statusCode: 409,
          code: 'HR_LEGACY_MAPPING_EXISTS',
          message: 'Nguồn này đã có mapping đang dùng',
        });
      }
      throw error;
    }
  }

  async deactivateMapping(
    actorId: number,
    actor: HrAuditActor,
    id: number,
    dto: VersionReasonDto,
  ) {
    await this.assertCatalogManager(actorId);
    return this.dataSource.transaction(async (manager) => {
      const row = await manager
        .getRepository(LegacyOrgMapping)
        .createQueryBuilder('m')
        .setLock('pessimistic_write')
        .where('m.id = :id', { id })
        .getOne();
      if (!row) throw new NotFoundException('Không tìm thấy mapping');
      if (row.version !== dto.version) throw versionConflict();
      if (!row.isActive)
        throw violation({
          code: 'HR_LEGACY_MAPPING_INACTIVE',
          message: 'Mapping đã ngừng dùng',
        });
      await manager.update(
        LegacyOrgMapping,
        { id },
        { isActive: false, version: row.version + 1 },
      );
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.LEGACY_ORG_MAPPING_DEACTIVATE,
        entity: 'legacy_org_mapping',
        entityId: id,
        oldValue: {
          sourceType: row.sourceType,
          sourceValue: row.sourceValue,
          orgUnitId: row.orgUnitId,
        },
        reason: dto.reason,
      });
      return { ...row, isActive: false, version: row.version + 1 };
    });
  }
}
