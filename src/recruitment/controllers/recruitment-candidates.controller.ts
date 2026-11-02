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
  CreateCandidateDto,
  DeletionRequestDto,
  QueryCandidateDto,
  UpdateCandidateDto,
} from '../dto/candidate.dto';
import {
  hrActor,
  RECRUITMENT_MANAGE_ROLES,
  RECRUITMENT_VIEW_ROLES,
} from '../recruitment.roles';
import { CandidatePrivacyService } from '../services/candidate-privacy.service';
import { RecruitmentCandidateService } from '../services/recruitment-candidate.service';
import { recruitmentValidationPipe } from './validation';

@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment/candidates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...RECRUITMENT_VIEW_ROLES)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentCandidatesController {
  constructor(
    private readonly candidates: RecruitmentCandidateService,
    private readonly privacy: CandidatePrivacyService,
  ) {}

  /** Trùng SĐT/email → 409 `POSSIBLE_DUPLICATE` kèm danh sách; gửi `allowDuplicate: true` để vẫn tạo. */
  @Post()
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  create(@Body() dto: CreateCandidateDto, @Req() req: Request) {
    return this.candidates.create(dto, hrActor(req.user!));
  }

  @Get()
  findAll(@Query() query: QueryCandidateDto) {
    return this.candidates.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.candidates.findOne(id);
  }

  @Patch(':id')
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCandidateDto,
    @Req() req: Request,
  ) {
    return this.candidates.update(id, dto, hrActor(req.user!));
  }

  /** HR ghi nhận yêu cầu xoá dữ liệu nhận qua kênh khác (điện thoại, email...). */
  @Post(':id/deletion-request')
  @HttpCode(200)
  @Roles(...RECRUITMENT_MANAGE_ROLES)
  requestDeletion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeletionRequestDto,
    @Req() req: Request,
  ) {
    return this.privacy.requestDeletion(id, hrActor(req.user!), {
      note: dto.note,
    });
  }
}
