import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/role-guard';
import { Roles } from '../../auth/roles.decorator';
import {
  DashboardQueryDto,
  QueryHandoffDto,
  ResolveHandoffDto,
} from '../dto/handoff.dto';
import {
  hrActor,
  RECRUITMENT_MANAGE_ROLES,
  RECRUITMENT_VIEW_ROLES,
} from '../recruitment.roles';
import { RecruitmentDashboardService } from '../services/recruitment-dashboard.service';
import { RecruitmentHandoffService } from '../services/recruitment-handoff.service';
import { recruitmentValidationPipe } from './validation';

/** Hàng đợi việc AI chuyển cho HR. */
@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/handoffs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentHandoffsController {
  constructor(private readonly handoffs: RecruitmentHandoffService) {}

  @Get()
  findAll(@Query() query: QueryHandoffDto) {
    return this.handoffs.list(query);
  }

  /** Đánh dấu đã xử lý. Không mở lại AI — dùng `/applications/:id/resume-ai`. */
  @Post(':id/resolve')
  @HttpCode(200)
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  resolve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolveHandoffDto,
    @Req() req: Request,
  ) {
    return this.handoffs.resolve(id, dto, hrActor(req.user!));
  }
}

@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentDashboardController {
  constructor(private readonly dashboard: RecruitmentDashboardService) {}

  @Get('summary')
  summary(@Query() query: DashboardQueryDto) {
    return this.dashboard.summary(query);
  }
}
