import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HrAccessModule } from '../access/hr-access.module';
import { HrAuditModule } from '../audit/hr-audit.module';
import { HrEmployee } from '../employees/entities/hr-employee.entity';
import { LegacyOrgMapping } from './entities/legacy-org-mapping.entity';
import { OrgUnitLeader } from './entities/org-unit-leader.entity';
import { OrgUnitRevision } from './entities/org-unit-revision.entity';
import { OrgUnit } from './entities/org-unit.entity';
import { HrPosition } from './entities/position.entity';
import { OrgApproverResolver } from './org-approver.resolver';
import { OrgCatalogService } from './org-catalog.service';
import { OrgLeaderService } from './org-leader.service';
import { OrgStructureRepository } from './org-structure.repository';
import { OrgScopeUnitValidator } from './org-scope-unit.validator';
import { OrgUnitService } from './org-unit.service';
import { OrganizationController } from './organization.controller';

/**
 * Cơ cấu tổ chức. Export repository + resolver cho các phase sau (lịch sử
 * công tác, approval engine) và validator đơn vị-phạm vi cho Access Admin —
 * chỉ đọc, không cho module khác ghi cơ cấu.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrgUnit,
      OrgUnitRevision,
      OrgUnitLeader,
      HrPosition,
      LegacyOrgMapping,
      HrEmployee,
    ]),
    HrAccessModule,
    HrAuditModule,
  ],
  controllers: [OrganizationController],
  providers: [
    OrgStructureRepository,
    OrgApproverResolver,
    OrgUnitService,
    OrgLeaderService,
    OrgCatalogService,
    OrgScopeUnitValidator,
  ],
  exports: [OrgStructureRepository, OrgApproverResolver, OrgScopeUnitValidator],
})
export class HrOrganizationModule {}
