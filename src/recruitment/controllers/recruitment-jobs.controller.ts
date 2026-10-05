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
import { CreateJobDto, QueryJobDto, UpdateJobDto } from '../dto/job.dto';
import {
  hrActor,
  RECRUITMENT_MANAGE_ROLES,
  RECRUITMENT_VIEW_ROLES,
} from '../recruitment.roles';
import { RecruitmentJobService } from '../services/recruitment-job.service';
import { recruitmentValidationPipe } from './validation';

@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentJobsController {
  constructor(private readonly jobs: RecruitmentJobService) {}

  @Post()
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  create(@Body() dto: CreateJobDto, @Req() req: Request) {
    return this.jobs.create(dto, hrActor(req.user!));
  }

  @Get()
  findAll(@Query() query: QueryJobDto) {
    return this.jobs.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.jobs.findOne(id);
  }

  @Patch(':id')
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateJobDto,
    @Req() req: Request,
  ) {
    return this.jobs.update(id, dto, hrActor(req.user!));
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  publish(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.jobs.publish(id, hrActor(req.user!));
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  pause(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.jobs.pause(id, hrActor(req.user!));
  }

  @Post(':id/close')
  @HttpCode(200)
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  close(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.jobs.close(id, hrActor(req.user!));
  }
}
