import {
  Controller,
  Get,
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
  HrPermissionGuard,
  HrRequestAccess,
  RequireHrPermission,
} from '../access/hr-permission.guard';
import { QueryHrAuditLogDto } from './dto/query-hr-audit-log.dto';
import { HrAuditQueryService } from './hr-audit-query.service';

/** Chỉ đọc — audit không có API sửa/xoá, và DB cũng không cho. */
@ApiTags('HR — Audit')
@ApiBearerAuth()
@Controller('api/hr/v1/audit-logs')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class HrAuditController {
  constructor(private readonly query: HrAuditQueryService) {}

  @Get()
  @RequireHrPermission(HrPermission.AUDIT_VIEW)
  list(
    @Req() req: { hrAccess: HrRequestAccess },
    @Query() query: QueryHrAuditLogDto,
  ) {
    return this.query.list(req.hrAccess.grants, query);
  }
}
