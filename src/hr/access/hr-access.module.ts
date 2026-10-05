import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HrAccountPermissionGrant } from './entities/hr-account-permission-grant.entity';
import { HrPermissionEntity } from './entities/hr-permission.entity';
import { HrRolePermission } from './entities/hr-role-permission.entity';
import { HrAccessQueryService } from './hr-access-query.service';
import { HrAccessController } from './hr-access.controller';
import { HrAccessRepository } from './hr-access.repository';
import { HrAccessService } from './hr-access.service';
import { HrPermissionGuard } from './hr-permission.guard';
import {
  FailClosedScopeResolver,
  HR_SCOPE_RESOLVER,
} from './hr-scope-resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HrPermissionEntity,
      HrRolePermission,
      HrAccountPermissionGrant,
    ]),
  ],
  controllers: [HrAccessController],
  providers: [
    HrAccessRepository,
    HrAccessService,
    HrAccessQueryService,
    HrPermissionGuard,
    { provide: HR_SCOPE_RESOLVER, useClass: FailClosedScopeResolver },
  ],
  exports: [HrAccessService, HrAccessRepository, HrPermissionGuard],
})
export class HrAccessModule {}
