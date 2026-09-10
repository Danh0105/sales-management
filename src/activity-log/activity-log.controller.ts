import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { HR_ROLE } from '../teaching/teaching-roles';
import { ActivityLogService } from './activity-log.service';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';

/**
 * Chỉ Nhân sự và Ban giám đốc đọc được nhật ký. Cố ý **không** mở cho Giáo vụ:
 * nhật ký tồn tại để giám sát chính họ.
 */
export const ACTIVITY_LOG_VIEW_ROLES = [
  HR_ROLE,
  'director',
  'director_la',
  'troly_gd',
];

@ApiBearerAuth()
@Controller('activity-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ACTIVITY_LOG_VIEW_ROLES)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class ActivityLogController {
  constructor(private readonly service: ActivityLogService) {}

  @Get()
  @ApiOperation({ summary: 'Nhật ký thao tác của Giáo vụ / Nhân sự' })
  find(@Query() dto: QueryActivityLogDto) {
    return this.service.find(dto);
  }

  @Get('actors')
  @ApiOperation({ summary: 'Danh sách người thao tác kèm số lượt' })
  actors() {
    return this.service.actors();
  }

  @Get(':resource/:resourceId')
  @ApiOperation({ summary: 'Lịch sử thao tác trên một bản ghi cụ thể' })
  byResource(
    @Param('resource') resource: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.service.findByResource(resource, resourceId);
  }
}
