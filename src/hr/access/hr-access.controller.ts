import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { HrAccessQueryService } from './hr-access-query.service';
import { HrPermission } from './hr-permission';
import {
  HrAuthenticatedOnly,
  HrPermissionGuard,
  HrRequestAccess,
  RequireHrPermission,
} from './hr-permission.guard';

/**
 * Chỉ đọc. API cấp/thu hồi quyền sẽ thêm khi HR Audit (Task 0.3) sẵn sàng —
 * thay đổi quyền mà không có vết là không chấp nhận được.
 */
@ApiTags('HR — Access')
@ApiBearerAuth()
@Controller('api/hr/v1/access')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
export class HrAccessController {
  constructor(private readonly query: HrAccessQueryService) {}

  @Get('me')
  @HrAuthenticatedOnly()
  me(@Req() req: { hrAccess: HrRequestAccess }) {
    return this.query.myPermissions(req.hrAccess.accountId);
  }

  @Get('permissions')
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  permissions() {
    return this.query.listPermissions();
  }

  @Get('role-permissions')
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  rolePermissions() {
    return this.query.listRolePermissions();
  }

  @Get('accounts/:accountId/grants')
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  accountGrants(
    @Req() req: { hrAccess: HrRequestAccess },
    @Param('accountId', ParseIntPipe) accountId: number,
  ) {
    return this.query.accountGrants(req.hrAccess.accountId, accountId);
  }
}
