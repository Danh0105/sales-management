import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Department } from '../department/department.entity';
import { Employee } from '../employee/employee.entity';
import { RecruitmentAiAuthGuard } from './ai/recruitment-ai-auth.guard';
import { RecruitmentAiIdempotencyInterceptor } from './ai/recruitment-ai-idempotency.interceptor';
import { RecruitmentAiRateLimitGuard } from './ai/recruitment-ai-rate-limit.guard';
import { RecruitmentAiController } from './controllers/recruitment-ai.controller';
import { RecruitmentApplicationsController } from './controllers/recruitment-applications.controller';
import { RecruitmentCandidatesController } from './controllers/recruitment-candidates.controller';
import {
  RecruitmentDashboardController,
  RecruitmentHandoffsController,
} from './controllers/recruitment-handoffs.controller';
import {
  RecruitmentInterviewSlotsController,
  RecruitmentInterviewsController,
} from './controllers/recruitment-interviews.controller';
import { RecruitmentJobsController } from './controllers/recruitment-jobs.controller';
import { RecruitmentAiIdempotencyKey } from './entities/recruitment-ai-idempotency-key.entity';
import { RecruitmentApplication } from './entities/recruitment-application.entity';
import { RecruitmentCandidate } from './entities/recruitment-candidate.entity';
import { RecruitmentConversation } from './entities/recruitment-conversation.entity';
import { RecruitmentHandoff } from './entities/recruitment-handoff.entity';
import { RecruitmentInterviewSlot } from './entities/recruitment-interview-slot.entity';
import { RecruitmentInterview } from './entities/recruitment-interview.entity';
import { RecruitmentJob } from './entities/recruitment-job.entity';
import { RecruitmentMessage } from './entities/recruitment-message.entity';
import { RecruitmentAuditService } from './recruitment-audit.service';
import { CandidatePrivacyService } from './services/candidate-privacy.service';
import {
  DbInterviewSlotProvider,
  INTERVIEW_SLOT_PROVIDER,
} from './services/interview-slot.provider';
import { RecruitmentApplicationService } from './services/recruitment-application.service';
import { RecruitmentCandidateService } from './services/recruitment-candidate.service';
import { RecruitmentConversationService } from './services/recruitment-conversation.service';
import { RecruitmentDashboardService } from './services/recruitment-dashboard.service';
import { RecruitmentHandoffService } from './services/recruitment-handoff.service';
import { RecruitmentInterviewService } from './services/recruitment-interview.service';
import { RecruitmentJobService } from './services/recruitment-job.service';
import { RecruitmentScreeningService } from './services/recruitment-screening.service';

/**
 * Tuyển dụng (Phase 1) + API riêng cho OpenClaw AI Recruiter.
 *
 * Audit dùng `ActivityLogService` (module global). Nguồn slot phỏng vấn đi qua
 * token `INTERVIEW_SLOT_PROVIDER` — đổi sang Google Calendar chỉ cần đổi
 * `useClass` ở đây.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RecruitmentJob,
      RecruitmentCandidate,
      RecruitmentApplication,
      RecruitmentConversation,
      RecruitmentMessage,
      RecruitmentInterviewSlot,
      RecruitmentInterview,
      RecruitmentHandoff,
      RecruitmentAiIdempotencyKey,
      Department,
      Employee,
    ]),
  ],
  controllers: [
    RecruitmentJobsController,
    RecruitmentCandidatesController,
    RecruitmentApplicationsController,
    RecruitmentInterviewsController,
    RecruitmentInterviewSlotsController,
    RecruitmentHandoffsController,
    RecruitmentDashboardController,
    RecruitmentAiController,
  ],
  providers: [
    RecruitmentAuditService,
    RecruitmentJobService,
    RecruitmentCandidateService,
    RecruitmentApplicationService,
    RecruitmentConversationService,
    RecruitmentScreeningService,
    RecruitmentInterviewService,
    RecruitmentHandoffService,
    RecruitmentDashboardService,
    CandidatePrivacyService,
    { provide: INTERVIEW_SLOT_PROVIDER, useClass: DbInterviewSlotProvider },
    RecruitmentAiAuthGuard,
    RecruitmentAiRateLimitGuard,
    RecruitmentAiIdempotencyInterceptor,
  ],
})
export class RecruitmentModule {}
