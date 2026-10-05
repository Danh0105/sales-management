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
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';

import { RecruitmentAiAuthGuard } from '../ai/recruitment-ai-auth.guard';
import {
  RecruitmentAiIdempotencyInterceptor,
  RequireIdempotencyKey,
} from '../ai/recruitment-ai-idempotency.interceptor';
import { RecruitmentAiRateLimitGuard } from '../ai/recruitment-ai-rate-limit.guard';
import {
  AiDeletionRequestDto,
  AiFindOrCreateApplicationDto,
  AiFindOrCreateCandidateDto,
  AiHandoffDto,
  AiInterviewSlotsQueryDto,
  AiProposeInterviewDto,
  AiSaveMessageDto,
  AiScreenApplicationDto,
  AiUpdateCandidateDto,
} from '../dto/ai.dto';
import { AI_ACTOR } from '../recruitment.roles';
import { CandidatePrivacyService } from '../services/candidate-privacy.service';
import { RecruitmentApplicationService } from '../services/recruitment-application.service';
import { RecruitmentCandidateService } from '../services/recruitment-candidate.service';
import { RecruitmentConversationService } from '../services/recruitment-conversation.service';
import { RecruitmentHandoffService } from '../services/recruitment-handoff.service';
import { RecruitmentInterviewService } from '../services/recruitment-interview.service';
import { RecruitmentJobService } from '../services/recruitment-job.service';
import { RecruitmentScreeningService } from '../services/recruitment-screening.service';
import { recruitmentValidationPipe } from './validation';

/**
 * API dành riêng cho OpenClaw AI Recruiter. Xác thực bằng
 * `Authorization: Bearer <RECRUITMENT_AI_API_KEY>` — không dùng JWT nhân viên
 * và không đụng tới API admin.
 *
 * AI chỉ được thu thập dữ liệu, sàng lọc, đề xuất/xác nhận lịch trong slot HR
 * mở và chuyển HR. Không có endpoint nào cho OFFER/HIRED/REJECTED.
 *
 * Mọi POST đều trả 200 và đều idempotent (khoá tự nhiên hoặc
 * `Idempotency-Key`). Lỗi nghiệp vụ trả `{ code, message }` để OpenClaw rẽ nhánh.
 */
@ApiTags('Recruitment AI (OpenClaw)')
@ApiBearerAuth()
@ApiHeader({ name: 'Idempotency-Key', required: false })
@Controller('recruitment/ai')
@UseGuards(RecruitmentAiAuthGuard, RecruitmentAiRateLimitGuard)
@UseInterceptors(RecruitmentAiIdempotencyInterceptor)
@UsePipes(recruitmentValidationPipe())
export class RecruitmentAiController {
  constructor(
    private readonly jobs: RecruitmentJobService,
    private readonly candidates: RecruitmentCandidateService,
    private readonly applications: RecruitmentApplicationService,
    private readonly conversations: RecruitmentConversationService,
    private readonly screening: RecruitmentScreeningService,
    private readonly interviews: RecruitmentInterviewService,
    private readonly handoffs: RecruitmentHandoffService,
    private readonly privacy: CandidatePrivacyService,
  ) {}

  // getActiveJobs()
  @Get('jobs/active')
  getActiveJobs() {
    return this.jobs.findActiveForAi();
  }

  // getJobDetail(jobId)
  @Get('jobs/:id')
  getJobDetail(@Param('id', ParseIntPipe) id: number) {
    return this.jobs.findOneForAi(id);
  }

  // findOrCreateCandidate()
  @Post('candidates/find-or-create')
  @HttpCode(200)
  findOrCreateCandidate(@Body() dto: AiFindOrCreateCandidateDto) {
    return this.candidates.aiFindOrCreate(dto);
  }

  // getCandidate()
  @Get('candidates/:id')
  getCandidate(@Param('id', ParseIntPipe) id: number) {
    return this.candidates.aiGet(id);
  }

  // updateCandidate()
  @Patch('candidates/:id')
  updateCandidate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AiUpdateCandidateDto,
  ) {
    return this.candidates.aiUpdate(id, dto);
  }

  /** Ứng viên xin xoá dữ liệu khi chưa có hồ sơ nào (có hồ sơ thì dùng handoff `DATA_DELETION_REQUEST`). */
  @Post('candidates/:id/deletion-request')
  @HttpCode(200)
  requestDeletion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AiDeletionRequestDto,
  ) {
    return this.privacy.requestDeletion(id, AI_ACTOR, { note: dto.note });
  }

  // findOrCreateApplication()
  @Post('applications/find-or-create')
  @HttpCode(200)
  findOrCreateApplication(@Body() dto: AiFindOrCreateApplicationDto) {
    return this.applications.aiFindOrCreate(dto);
  }

  // getApplicationContext()
  @Get('applications/:id/context')
  getApplicationContext(@Param('id', ParseIntPipe) id: number) {
    return this.applications.getAiContext(id);
  }

  // screenCandidate()
  @Post('applications/:id/screen')
  @HttpCode(200)
  screenCandidate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AiScreenApplicationDto,
  ) {
    return this.screening.screen(id, dto);
  }

  // handoffToHR()
  @Post('applications/:id/handoff')
  @HttpCode(200)
  handoffToHr(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AiHandoffDto,
  ) {
    return this.handoffs.aiHandoff(id, dto);
  }

  // saveCandidateMessage()
  @Post('conversations/message')
  @HttpCode(200)
  saveCandidateMessage(@Body() dto: AiSaveMessageDto) {
    return this.conversations.saveMessage(dto);
  }

  @Get('conversations/:id/context')
  getConversationContext(@Param('id', ParseIntPipe) id: number) {
    return this.conversations.getContext(id);
  }

  // getInterviewSlots()
  @Get('interview-slots')
  getInterviewSlots(@Query() query: AiInterviewSlotsQueryDto) {
    return this.interviews.aiListSlots(query);
  }

  // proposeInterview() — giữ chỗ slot nên bắt buộc Idempotency-Key.
  @Post('interviews/propose')
  @HttpCode(200)
  @RequireIdempotencyKey()
  proposeInterview(@Body() dto: AiProposeInterviewDto) {
    return this.interviews.aiPropose(dto);
  }

  // confirmInterview()
  @Post('interviews/:id/confirm')
  @HttpCode(200)
  confirmInterview(@Param('id', ParseIntPipe) id: number) {
    return this.interviews.aiConfirm(id);
  }
}
