import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { HrPermission } from '../access/hr-permission';
import {
  HrAuthenticatedOnly,
  HrPermissionGuard,
  RequireHrPermission,
} from '../access/hr-permission.guard';
import { auditActorFromRequest } from '../audit/hr-audit-actor';
import { HR_VALIDATION } from '../employees/hr-request';
import type { HrRequest } from '../employees/hr-request';
import {
  AsOfQuery,
  AssignOrgLeaderDto,
  CreateLegacyOrgMappingDto,
  CreateOrgUnitDto,
  CreatePositionDto,
  EndOrgLeaderDto,
  ReviseOrgUnitDto,
  ScopeOptionsQuery,
  UpdatePositionDto,
  VersionReasonDto,
} from './dto/organization.dto';
import { OrgCatalogService } from './org-catalog.service';
import { OrgLeaderService } from './org-leader.service';
import { OrgUnitService } from './org-unit.service';

/**
 * Cơ cấu tổ chức (Phase 1.1). Xem: EMPLOYEE_VIEW hoặc ORG_MANAGE (kiểm tra ở
 * service). Sửa: ORG_MANAGE + phạm vi trên cây (kiểm tra ở service). Không có
 * PATCH đè lịch sử đơn vị, không có DELETE.
 */
@ApiTags('HR — Organization')
@ApiBearerAuth()
@Controller('api/hr/v1')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
@UsePipes(new ValidationPipe(HR_VALIDATION))
export class OrganizationController {
  constructor(
    private readonly units: OrgUnitService,
    private readonly leaders: OrgLeaderService,
    private readonly catalog: OrgCatalogService,
  ) {}

  /**
   * Lựa chọn đơn vị cho phạm vi khi cấp quyền HR — chỉ ACCESS_ADMIN, chỉ
   * projection tối thiểu, lọc theo phạm vi quản trị của người gọi. POST cấp
   * quyền vẫn kiểm tra M1 đầy đủ.
   */
  @Get('organization/scope-options')
  @RequireHrPermission(HrPermission.ACCESS_ADMIN)
  scopeOptions(@Req() req: HrRequest, @Query() q: ScopeOptionsQuery) {
    return this.units.scopeOptions(req.hrAccess.grants, q.scopeType, q.asOf);
  }

  @Get('org-units')
  @HrAuthenticatedOnly()
  list(@Req() req: HrRequest, @Query() q: AsOfQuery) {
    return this.units.list(
      req.hrAccess.accountId,
      q.asOf,
      q.includeInactive ?? false,
    );
  }

  @Get('org-units/:id')
  @HrAuthenticatedOnly()
  get(
    @Req() req: HrRequest,
    @Param('id', ParseIntPipe) id: number,
    @Query() q: AsOfQuery,
  ) {
    return this.units.get(req.hrAccess.accountId, id, q.asOf);
  }

  @Get('org-units/:id/approvers')
  @HrAuthenticatedOnly()
  approvers(
    @Req() req: HrRequest,
    @Param('id', ParseIntPipe) id: number,
    @Query() q: AsOfQuery,
  ) {
    return this.units.approverPreview(req.hrAccess.accountId, id, q.asOf);
  }

  @Post('org-units')
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  create(@Req() req: HrRequest, @Body() dto: CreateOrgUnitDto) {
    return this.units.create(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      dto,
    );
  }

  @Post('org-units/:id/revisions')
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  revise(
    @Req() req: HrRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviseOrgUnitDto,
  ) {
    return this.units.revise(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      id,
      dto,
    );
  }

  @Post('org-units/:id/leaders')
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  assignLeader(
    @Req() req: HrRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignOrgLeaderDto,
  ) {
    return this.leaders.assign(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      id,
      dto,
    );
  }

  @Post('org-unit-leaders/:id/end')
  @HttpCode(200)
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  endLeader(
    @Req() req: HrRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: EndOrgLeaderDto,
  ) {
    return this.leaders.end(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      id,
      dto,
    );
  }

  @Get('positions')
  @HrAuthenticatedOnly()
  async positions(@Req() req: HrRequest) {
    await this.units.assertCanView(req.hrAccess.accountId);
    return this.catalog.listPositions();
  }

  @Post('positions')
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  createPosition(@Req() req: HrRequest, @Body() dto: CreatePositionDto) {
    return this.catalog.createPosition(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      dto,
    );
  }

  @Patch('positions/:id')
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  updatePosition(
    @Req() req: HrRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePositionDto,
  ) {
    return this.catalog.updatePosition(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      id,
      dto,
    );
  }

  @Post('positions/:id/deactivate')
  @HttpCode(200)
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  deactivatePosition(
    @Req() req: HrRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VersionReasonDto,
  ) {
    return this.catalog.deactivatePosition(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      id,
      dto,
    );
  }

  @Get('legacy-org-mappings')
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  mappings() {
    return this.catalog.listMappings();
  }

  @Post('legacy-org-mappings')
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  createMapping(@Req() req: HrRequest, @Body() dto: CreateLegacyOrgMappingDto) {
    return this.catalog.createMapping(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      dto,
    );
  }

  @Post('legacy-org-mappings/:id/deactivate')
  @HttpCode(200)
  @RequireHrPermission(HrPermission.ORG_MANAGE)
  deactivateMapping(
    @Req() req: HrRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VersionReasonDto,
  ) {
    return this.catalog.deactivateMapping(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      id,
      dto,
    );
  }
}
