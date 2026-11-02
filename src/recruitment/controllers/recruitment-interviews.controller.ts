import {
  Body,
  Controller,
  Get,
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
  CreateInterviewDto,
  CreateInterviewSlotDto,
  QueryInterviewDto,
  QueryInterviewSlotDto,
  UpdateInterviewDto,
  UpdateInterviewSlotDto,
} from '../dto/interview.dto';
import {
  hrActor,
  RECRUITMENT_MANAGE_ROLES,
  RECRUITMENT_VIEW_ROLES,
} from '../recruitment.roles';
import { RecruitmentInterviewService } from '../services/recruitment-interview.service';
import { recruitmentValidationPipe } from './validation';

@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/interviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentInterviewsController {
  constructor(private readonly interviews: RecruitmentInterviewService) {}

  @Post()
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  create(@Body() dto: CreateInterviewDto, @Req() req: Request) {
    return this.interviews.create(dto, hrActor(req.user!));
  }

  @Get()
  findAll(@Query() query: QueryInterviewDto) {
    return this.interviews.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.interviews.findOne(id);
  }

  @Patch(':id')
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInterviewDto,
    @Req() req: Request,
  ) {
    return this.interviews.update(id, dto, hrActor(req.user!));
  }
}

/** Khung giờ HR mở để AI đề xuất cho ứng viên. */
@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/interview-slots')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentInterviewSlotsController {
  constructor(private readonly interviews: RecruitmentInterviewService) {}

  @Post()
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  create(@Body() dto: CreateInterviewSlotDto, @Req() req: Request) {
    return this.interviews.createSlot(dto, hrActor(req.user!));
  }

  @Get()
  findAll(@Query() query: QueryInterviewSlotDto) {
    return this.interviews.listSlots(query);
  }

  @Patch(':id')
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInterviewSlotDto,
    @Req() req: Request,
  ) {
    return this.interviews.updateSlot(id, dto, hrActor(req.user!));
  }
}
