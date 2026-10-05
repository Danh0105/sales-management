import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HrAccountRoleAssignment } from '../access/entities/hr-account-role-assignment.entity';
import { HrRoleDefinitionPermission } from '../access/entities/hr-role-definition-permission.entity';
import { HrRole } from '../access/entities/hr-role.entity';
import { HrAccessModule } from '../access/hr-access.module';
import { HrAccessSafetyModule } from '../access-safety/hr-access-safety.module';
import { HrAuditModule } from '../audit/hr-audit.module';
import { HrOrganizationModule } from '../organization/hr-organization.module';
import { HrRoleAdminController } from './hr-role-admin.controller';
import { HrRoleAdminRepository } from './hr-role-admin.repository';
import { HrRoleAdminService } from './hr-role-admin.service';

/**
 * Tách khỏi HrAccessModule để tránh vòng phụ thuộc: HrAuditModule cần
 * HrAccessModule (guard), còn cấp/thu hồi quyền lại cần HrAuditService.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      HrRole,
      HrRoleDefinitionPermission,
      HrAccountRoleAssignment,
    ]),
    HrAccessModule,
    HrAuditModule,
    HrAccessSafetyModule,
    // Chỉ đọc: kiểm tra đơn vị của scope BRANCH/ORG_UNIT khi cấp quyền.
    HrOrganizationModule,
  ],
  controllers: [HrRoleAdminController],
  providers: [HrRoleAdminRepository, HrRoleAdminService],
})
export class HrAccessAdminModule {}
