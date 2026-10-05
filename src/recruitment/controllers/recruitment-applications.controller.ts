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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/role-guard';
import { Roles } from '../../auth/roles.decorator';
import {
  CreateApplicationDto,
  QueryApplicationDto,
  ResumeAiDto,
  UpdateApplicationStatusDto,
} from '../dto/application.dto';
import {
  hrActor,
  RECRUITMENT_MANAGE_ROLES,
  RECRUITMENT_VIEW_ROLES,
} from '../recruitment.roles';
import { RecruitmentApplicationService } from '../services/recruitment-application.service';
import { recruitmentValidationPipe } from './validation';

@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentApplicationsController {
  constructor(private readonly applications: RecruitmentApplicationService) {}

  @Post()
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  create(@Body() dto: CreateApplicationDto, @Req() req: Request) {
    return this.applications.create(dto, hrActor(req.user!));
  }

  @Get()
  findAll(@Query() query: QueryApplicationDto) {
    return this.applications.findAll(query);
  }

  /** Khai báo trước `:id` để "pipeline" không bị nuốt vào tham số. */
  @Get('pipeline')
  pipeline(@Query() query: QueryApplicationDto) {
    return this.applications.pipeline(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.applications.findOne(id);
  }

  /** Quyết định của HR — đi qua state machine, REJECTED bắt buộc `rejectedReason`. */
  @Patch(':id/status')
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  changeStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateApplicationStatusDto,
    @Req() req: Request,
  ) {
    return this.applications.changeStatus(id, dto, hrActor(req.user!));
  }

  /** Trả hồ sơ đã handoff về cho AI xử lý tiếp. */
  @Post(':id/resume-ai')
  @HttpCode(200)
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  resumeAi(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResumeAiDto,
    @Req() req: Request,
  ) {
    return this.applications.resumeAi(id, dto, hrActor(req.user!));
  }
}
