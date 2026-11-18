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
import { RecruitmentAiOwnershipService } from '../ai/recruitment-ai-ownership.service';
import {
  AiRequestContext,
  channelConversationId,
  type RecruitmentAiRequestContext,
} from '../ai/recruitment-ai-subject';
import {
  RecruitmentAiIdempotencyInterceptor,
  RequireIdempotencyKey,
} from '../ai/recruitment-ai-idempotency.interceptor';
import { RecruitmentAiRateLimitGuard } from '../ai/recruitment-ai-rate-limit.guard';
import { RecruitmentAiRuntimeGuard } from '../ai/recruitment-ai-runtime.guard';
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
import { ConversationChannel } from '../recruitment.enums';
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
 *
 * Request của kênh tin cậy (có subject, xem `RecruitmentAiAuthGuard`) chỉ được
 * đụng tới hồ sơ của đúng người gửi: mọi id trong request được kiểm qua quan hệ
 * DB trước khi gọi service (`SUBJECT_MISMATCH`). Vị trí tuyển và slot phỏng vấn
 * là dữ liệu chung, đọc tự do.
 */
@ApiTags('Recruitment AI (OpenClaw)')
@ApiBearerAuth()
@ApiHeader({ name: 'Idempotency-Key', required: false })
@Controller('recruitment/ai')
@UseGuards(
  RecruitmentAiAuthGuard,
  RecruitmentAiRuntimeGuard,
  RecruitmentAiRateLimitGuard,
)
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
    private readonly ownership: RecruitmentAiOwnershipService,
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
  async findOrCreateCandidate(
    @Body() dto: AiFindOrCreateCandidateDto,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    const { subject } = ai;
    if (subject && dto.zaloUserId && dto.zaloUserId !== subject.userId) {
      await this.ownership.denyIdentityClaim(subject, 'findOrCreateCandidate');
    }
    return this.candidates.aiFindOrCreate(dto, subject);
  }

  // getCandidate()
  @Get('candidates/:id')
  async getCandidate(
    @Param('id', ParseIntPipe) id: number,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject)
      await this.ownership.assertCandidate(ai.subject, id, 'getCandidate');
    return this.candidates.aiGet(id);
  }

  // updateCandidate()
  @Patch('candidates/:id')
  async updateCandidate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AiUpdateCandidateDto,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject)
      await this.ownership.assertCandidate(ai.subject, id, 'updateCandidate');
    return this.candidates.aiUpdate(id, dto);
  }

  /** Ứng viên xin xoá dữ liệu khi chưa có hồ sơ nào (có hồ sơ thì dùng handoff `DATA_DELETION_REQUEST`). */
  @Post('candidates/:id/deletion-request')
  @HttpCode(200)
  async requestDeletion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AiDeletionRequestDto,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject)
      await this.ownership.assertCandidate(
        ai.subject,
        id,
        'requestCandidateDeletion',
      );
    return this.privacy.requestDeletion(id, AI_ACTOR, { note: dto.note });
  }

  // findOrCreateApplication()
  @Post('applications/find-or-create')
  @HttpCode(200)
  async findOrCreateApplication(
    @Body() dto: AiFindOrCreateApplicationDto,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject) {
      await this.ownership.assertCandidate(
        ai.subject,
        dto.candidateId,
        'findOrCreateApplication',
      );
    }
    return this.applications.aiFindOrCreate(dto);
  }

  // getApplicationContext()
  @Get('applications/:id/context')
  async getApplicationContext(
    @Param('id', ParseIntPipe) id: number,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject)
      await this.ownership.assertApplication(
        ai.subject,
        id,
        'getApplicationContext',
      );
    return this.applications.getAiContext(id);
  }

  // screenCandidate()
  @Post('applications/:id/screen')
  @HttpCode(200)
  async screenCandidate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AiScreenApplicationDto,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject)
      await this.ownership.assertApplication(ai.subject, id, 'screenCandidate');
    return this.screening.screen(id, dto);
  }

  // handoffToHR()
  @Post('applications/:id/handoff')
  @HttpCode(200)
  async handoffToHr(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AiHandoffDto,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject)
      await this.ownership.assertApplication(ai.subject, id, 'handoffToHR');
    return this.handoffs.aiHandoff(id, dto);
  }

  // saveCandidateMessage()
  @Post('conversations/message')
  @HttpCode(200)
  async saveCandidateMessage(
    @Body() dto: AiSaveMessageDto,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    const { subject } = ai;
    if (subject) {
      await this.ownership.assertCandidate(
        subject,
        dto.candidateId,
        'saveMessage',
      );
      if (dto.applicationId != null) {
        await this.ownership.assertApplication(
          subject,
          dto.applicationId,
          'saveMessage',
        );
      }
      // Hội thoại của kênh luôn gắn đúng người gửi — không theo giá trị model khai.
      return this.conversations.saveMessage({
        ...dto,
        channel: ConversationChannel.ZALO,
        externalConversationId: channelConversationId(subject),
      });
    }
    return this.conversations.saveMessage(dto);
  }

  @Get('conversations/:id/context')
  async getConversationContext(
    @Param('id', ParseIntPipe) id: number,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject)
      await this.ownership.assertConversation(
        ai.subject,
        id,
        'getConversationContext',
      );
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
  async proposeInterview(
    @Body() dto: AiProposeInterviewDto,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject) {
      await this.ownership.assertApplication(
        ai.subject,
        dto.applicationId,
        'proposeInterview',
      );
    }
    return this.interviews.aiPropose(dto);
  }

  // confirmInterview()
  @Post('interviews/:id/confirm')
  @HttpCode(200)
  async confirmInterview(
    @Param('id', ParseIntPipe) id: number,
    @AiRequestContext() ai: RecruitmentAiRequestContext,
  ) {
    if (ai.subject)
      await this.ownership.assertInterview(ai.subject, id, 'confirmInterview');
    return this.interviews.aiConfirm(id);
  }
}
