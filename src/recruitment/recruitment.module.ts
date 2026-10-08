import { Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Department } from '../department/department.entity';
import { Employee } from '../employee/employee.entity';
import { RecruitmentAiAuthGuard } from './ai/recruitment-ai-auth.guard';
import { RecruitmentAiIdempotencyInterceptor } from './ai/recruitment-ai-idempotency.interceptor';
import { RecruitmentAiOwnershipService } from './ai/recruitment-ai-ownership.service';
import { RecruitmentAiRateLimitGuard } from './ai/recruitment-ai-rate-limit.guard';
import { assertRecruitmentAiConfig } from './ai/recruitment-ai-subject';
import { RecruitmentChannelEventQueue } from './channels/recruitment-channel-event.queue';
import { RecruitmentChannelOutboxQueue } from './channels/recruitment-channel-outbox.queue';
import { assertRecruitmentWorkerConfig } from './channels/recruitment-channel-worker.config';
import { RecruitmentChannelWorker } from './channels/recruitment-channel-worker.service';
import { RecruitmentZaloWebhookController } from './channels/recruitment-zalo-webhook.controller';
import { RecruitmentZaloCredentialStore } from './channels/recruitment-zalo-credential.store';
import { RecruitmentZaloSender } from './channels/recruitment-zalo-sender.service';
import { RecruitmentZaloWebhookService } from './channels/recruitment-zalo-webhook.service';
import { assertZaloOutboundConfig } from './channels/zalo-outbound.config';
import { assertRecruitmentZaloConfig } from './channels/zalo-recruitment-event';
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
import { RecruitmentChannelEvent } from './entities/recruitment-channel-event.entity';
import { RecruitmentChannelOutbox } from './entities/recruitment-channel-outbox.entity';
import { RecruitmentConversation } from './entities/recruitment-conversation.entity';
import { RecruitmentHandoff } from './entities/recruitment-handoff.entity';
import { RecruitmentInterviewSlot } from './entities/recruitment-interview-slot.entity';
import { RecruitmentInterview } from './entities/recruitment-interview.entity';
import { RecruitmentJob } from './entities/recruitment-job.entity';
import { RecruitmentMessage } from './entities/recruitment-message.entity';
import { RecruitmentZaloCredential } from './entities/recruitment-zalo-credential.entity';
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
 *
 * Khởi động: production bật API AI mà không bắt buộc subject kênh thì dừng
 * (`assertRecruitmentAiConfig`); bật webhook Zalo OA tuyển dụng mà thiếu/sai
 * cấu hình OA cũng dừng (`assertRecruitmentZaloConfig`); bật worker OpenClaw mà
 * thiếu/sai cấu hình cũng dừng (`assertRecruitmentWorkerConfig`); bật gửi tin ra
 * Zalo mà thiếu credential/khoá cũng dừng (`assertZaloOutboundConfig`) — fail-closed.
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
      RecruitmentChannelEvent,
      RecruitmentChannelOutbox,
      RecruitmentZaloCredential,
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
    RecruitmentZaloWebhookController,
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
    RecruitmentAiOwnershipService,
    RecruitmentZaloWebhookService,
    RecruitmentChannelEventQueue,
    RecruitmentChannelWorker,
    RecruitmentChannelOutboxQueue,
    RecruitmentZaloCredentialStore,
    RecruitmentZaloSender,
  ],
})
export class RecruitmentModule implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const get = (key: string) => this.config.get<string>(key);
    assertRecruitmentAiConfig(get);
    assertRecruitmentZaloConfig(get);
    assertRecruitmentWorkerConfig(get);
    assertZaloOutboundConfig(get);
  }
}
