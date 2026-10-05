import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthUser } from '../../type/auth-user.type';
import { HrPermission } from '../access/hr-permission';
import {
  HrPermissionGuard,
  HrRequestAccess,
  RequireHrPermission,
} from '../access/hr-permission.guard';
import { auditActorFromRequest } from '../audit/hr-audit-actor';
import { AssignHrRoleDto } from './dto/assign-hr-role.dto';
import { RevokeHrRoleAssignmentDto } from './dto/revoke-hr-role-assignment.dto';
import { HrRoleAdminService } from './hr-role-admin.service';

type HrRequest = {
  hrAccess: HrRequestAccess;
  user?: AuthUser;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
};

/**
 * Quản lý HR role. Guard chỉ chặn thô (có ACCESS_VIEW/ACCESS_ADMIN hay không);
 * phạm vi tài khoản đích, chống tự nâng quyền, trần scope đều kiểm tra ở service.
 */
@ApiTags('HR — Access admin')
@ApiBearerAuth()
@Controller('api/hr/v1/access')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class HrRoleAdminController {
  constructor(private readonly service: HrRoleAdminService) {}

  @Get('roles')
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  roles() {
    return this.service.listRoles();
  }

  /** Số quản trị HR hợp lệ hiện tại so với mức tối thiểu — để phát hiện thiếu hụt. */
  @Get('admin-status')
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  adminStatus() {
    return this.service.adminStatus();
  }

  @Get('roles/:code/permissions')
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  rolePermissions(@Param('code') code: string) {
    return this.service.rolePermissions(code);
  }

  @Get('accounts/:accountId/role-assignments')
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  accountAssignments(
    @Req() req: HrRequest,
    @Param('accountId', ParseIntPipe) accountId: number,
  ) {
    return this.service.accountAssignments(req.hrAccess.accountId, accountId);
  }

  @Post('accounts/:accountId/role-assignments')
  @RequireHrPermission(HrPermission.ACCESS_ADMIN)
  assign(
    @Req() req: HrRequest,
    @Param('accountId', ParseIntPipe) accountId: number,
    @Body() dto: AssignHrRoleDto,
  ) {
    return this.service.assign(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      accountId,
      dto,
    );
  }

  /** POST (không phải DELETE): cần body chứa lý do + version. */
  @Post('role-assignments/:assignmentId/revoke')
  @HttpCode(200)
  @RequireHrPermission(HrPermission.ACCESS_ADMIN)
  revoke(
    @Req() req: HrRequest,
    @Param('assignmentId', ParseIntPipe) assignmentId: number,
    @Body() dto: RevokeHrRoleAssignmentDto,
  ) {
    return this.service.revoke(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      assignmentId,
      dto,
    );
  }
}
