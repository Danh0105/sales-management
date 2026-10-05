import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  DataSource,
  EntityManager,
  In,
  IsNull,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';

import type { AiFindOrCreateApplicationDto } from '../dto/ai.dto';
import type {
  CreateApplicationDto,
  QueryApplicationDto,
  ResumeAiDto,
  UpdateApplicationStatusDto,
} from '../dto/application.dto';
import type { Paginated } from '../dto/common.dto';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentConversation } from '../entities/recruitment-conversation.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import { RecruitmentMessage } from '../entities/recruitment-message.entity';
import {
  allowedNextStatuses,
  assertApplicationTransition,
} from '../application-status.state-machine';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  ApplicationStatus,
  CandidateSource,
  HandoffStatus,
  INACTIVE_APPLICATION_STATUSES,
  InterviewStatus,
  RecruitmentActorType,
  RecruitmentJobStatus,
  TERMINAL_APPLICATION_STATUSES,
} from '../recruitment.enums';
import { AI_ACTOR, type RecruitmentActor } from '../recruitment.roles';
import {
  isUniqueViolation,
  likePattern,
  toAiApplicationView,
  toAiCandidateView,
  toAiInterviewView,
  toAiJobView,
  vnDayEnd,
  vnDayStart,
} from '../recruitment.views';
import { requiredCandidateFields } from '../screening/screening-engine';
import {
  INTERVIEW_SLOT_PROVIDER,
  type InterviewSlotProvider,
} from './interview-slot.provider';

/** Việc OpenClaw được làm tiếp với hồ sơ — tính từ trạng thái thật, không để model tự đoán. */
export type AiAllowedAction =
  | 'SAVE_MESSAGE'
  | 'UPDATE_CANDIDATE'
  | 'FIND_OR_CREATE_APPLICATION'
  | 'SCREEN_CANDIDATE'
  | 'GET_INTERVIEW_SLOTS'
  | 'PROPOSE_INTERVIEW'
  | 'CONFIRM_INTERVIEW'
  | 'HANDOFF_TO_HR'
  | 'REQUEST_DATA_DELETION';

const RECENT_MESSAGE_LIMIT = 20;
const ACTIVE_INTERVIEW_STATUSES = [
  InterviewStatus.PROPOSED,
  InterviewStatus.CONFIRMED,
];
const SCREENABLE_STATUSES = [
  ApplicationStatus.NEW,
  ApplicationStatus.COLLECTING_INFO,
  ApplicationStatus.SCREENING,
  ApplicationStatus.QUALIFIED,
];

@Injectable()
export class RecruitmentApplicationService {
  constructor(
    @InjectRepository(RecruitmentApplication)
    private readonly applicationRepo: Repository<RecruitmentApplication>,
    @InjectRepository(RecruitmentCandidate)
    private readonly candidateRepo: Repository<RecruitmentCandidate>,
    @InjectRepository(RecruitmentJob)
    private readonly jobRepo: Repository<RecruitmentJob>,
    @InjectRepository(RecruitmentHandoff)
    private readonly handoffRepo: Repository<RecruitmentHandoff>,
    @InjectRepository(RecruitmentInterview)
    private readonly interviewRepo: Repository<RecruitmentInterview>,
    @InjectRepository(RecruitmentConversation)
    private readonly conversationRepo: Repository<RecruitmentConversation>,
    @InjectRepository(RecruitmentMessage)
    private readonly messageRepo: Repository<RecruitmentMessage>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(INTERVIEW_SLOT_PROVIDER)
    private readonly slots: InterviewSlotProvider,
    private readonly audit: RecruitmentAuditService,
  ) {}

  // ---------------------------------------------------------------- HR ----

  async create(dto: CreateApplicationDto, actor: RecruitmentActor) {
    await this.getCandidateOrThrow(dto.candidateId);
    const job = await this.getJobOrThrow(dto.jobId);
    if (
      ![RecruitmentJobStatus.ACTIVE, RecruitmentJobStatus.PAUSED].includes(
        job.status,
      )
    ) {
      throw new ConflictException({
        code: 'JOB_NOT_OPEN',
        message: `Vị trí đang ở trạng thái ${job.status}, không nhận hồ sơ`,
      });
    }

    const existing = await this.findActive(dto.candidateId, dto.jobId);
    if (existing) throw this.duplicateApplication(existing.id);

    let saved: RecruitmentApplication;
    try {
      saved = await this.applicationRepo.save(
        this.applicationRepo.create({
          candidateId: dto.candidateId,
          jobId: dto.jobId,
          source: dto.source ?? CandidateSource.MANUAL,
          status: ApplicationStatus.NEW,
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.findActive(dto.candidateId, dto.jobId);
      throw this.duplicateApplication(raced?.id);
    }

    await this.audit.record({
      actor,
      action: 'APPLICATION_CREATE',
      entity: 'applications',
      entityId: saved.id,
      after: saved,
      context: { candidateId: saved.candidateId, jobId: saved.jobId },
    });
    return this.findOne(saved.id);
  }

  async findAll(
    query: QueryApplicationDto,
  ): Promise<Paginated<RecruitmentApplication>> {
    const { page, limit } = query;
    const qb = this.listQuery();
    this.applyFilters(qb, query, true);

    const sortColumn = `a.${query.sort ?? 'createdAt'}`;
    const order = query.order ?? 'DESC';
    qb.orderBy(
      sortColumn,
      order,
      query.sort === 'aiMatchScore' ? 'NULLS LAST' : undefined,
    )
      .addOrderBy('a.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  /**
   * Danh sách + số hồ sơ theo từng trạng thái (cùng bộ lọc, bỏ lọc trạng thái)
   * để FE dựng kanban mà không phải gọi 10 lần.
   */
  async pipeline(query: QueryApplicationDto) {
    const list = await this.findAll(query);

    const countQb = this.applicationRepo
      .createQueryBuilder('a')
      .leftJoin('a.candidate', 'c')
      .select('a.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('a.status');
    this.applyFilters(countQb, query, false);
    const rows = await countQb.getRawMany<{
      status: ApplicationStatus;
      count: string;
    }>();

    const countsByStatus = Object.fromEntries(
      Object.values(ApplicationStatus).map((s) => [s, 0]),
    ) as Record<ApplicationStatus, number>;
    for (const row of rows) countsByStatus[row.status] = Number(row.count);

    return { ...list, countsByStatus };
  }

  async findOne(id: number) {
    const application = await this.applicationRepo.findOne({
      where: { id },
      relations: { candidate: true, job: true, reviewer: true },
    });
    if (!application) throw this.notFound(id);

    const [interviews, handoffs] = await Promise.all([
      this.interviewRepo.find({
        where: { applicationId: id },
        order: { scheduledStart: 'DESC' },
      }),
      this.handoffRepo.find({
        where: { applicationId: id },
        order: { createdAt: 'DESC' },
      }),
    ]);

    const { reviewer, ...rest } = application;
    return {
      ...rest,
      reviewer: reviewer ? { id: reviewer.id, name: reviewer.name } : null,
      allowedNextStatuses: allowedNextStatuses(
        application.status,
        RecruitmentActorType.HR,
      ),
      interviews,
      handoffs,
    };
  }

  /**
   * Quyết định của HR. Hồ sơ kết thúc (REJECTED/WITHDRAWN/HIRED) thì huỷ lịch
   * phỏng vấn còn treo (trả chỗ cho slot) và đóng các yêu cầu HR đang mở.
   */
  async changeStatus(
    id: number,
    dto: UpdateApplicationStatusDto,
    actor: RecruitmentActor,
  ) {
    const application = await this.getOrThrow(id);
    const before = { ...application };

    if (dto.status === ApplicationStatus.REJECTED && !dto.rejectedReason) {
      throw new BadRequestException({
        code: 'REJECTED_REASON_REQUIRED',
        message: 'Phải nhập lý do khi loại hồ sơ',
      });
    }
    assertApplicationTransition(application.status, dto.status, actor.type);

    const now = new Date();
    application.status = dto.status;
    application.hrReviewedAt = now;
    application.reviewedBy = actor.employeeId;
    if (dto.status === ApplicationStatus.REJECTED)
      application.rejectedReason = dto.rejectedReason!;

    const terminal = TERMINAL_APPLICATION_STATUSES.includes(dto.status);
    const saved = await this.dataSource.transaction(async (em) => {
      const result = await em
        .getRepository(RecruitmentApplication)
        .save(application);
      if (terminal) {
        await this.closeOpenWork(
          em,
          id,
          actor,
          `Hồ sơ kết thúc (${dto.status})`,
          now,
        );
      }
      return result;
    });

    await this.audit.record({
      actor,
      action: 'APPLICATION_STATUS_CHANGE',
      entity: 'applications',
      entityId: id,
      before,
      after: saved,
      context: { from: before.status, to: dto.status, note: dto.note ?? null },
    });
    return this.findOne(id);
  }

  /** HR trả hồ sơ cho AI làm tiếp sau handoff. */
  async resumeAi(id: number, dto: ResumeAiDto, actor: RecruitmentActor) {
    const application = await this.getOrThrow(id);
    const candidate = await this.getCandidateOrThrow(application.candidateId);

    if (candidate.aiStoppedAt) {
      throw new ConflictException({
        code: 'AI_STOPPED_FOR_CANDIDATE',
        message: 'Ứng viên đã yêu cầu xoá dữ liệu — không thể trả lại cho AI',
      });
    }
    if (TERMINAL_APPLICATION_STATUSES.includes(application.status)) {
      throw new ConflictException({
        code: 'APPLICATION_CLOSED',
        message: `Hồ sơ đã kết thúc (${application.status})`,
      });
    }
    const inReview = application.status === ApplicationStatus.NEEDS_HR_REVIEW;
    if (!application.aiPaused && !inReview) {
      throw new ConflictException({
        code: 'AI_NOT_PAUSED',
        message: 'Hồ sơ không ở trạng thái chờ HR',
      });
    }

    const before = { ...application };
    if (inReview) {
      const target = dto.status ?? ApplicationStatus.COLLECTING_INFO;
      assertApplicationTransition(application.status, target, actor.type);
      application.status = target;
    }
    application.aiPaused = false;
    application.hrReviewedAt = new Date();
    application.reviewedBy = actor.employeeId;

    const saved = await this.dataSource.transaction(async (em) => {
      const result = await em
        .getRepository(RecruitmentApplication)
        .save(application);
      await em.getRepository(RecruitmentHandoff).update(
        { applicationId: id, status: HandoffStatus.OPEN },
        {
          status: HandoffStatus.RETURNED_TO_AI,
          resolvedBy: actor.employeeId,
          resolvedAt: new Date(),
          resolutionNote: dto.note ?? 'Trả lại cho AI xử lý tiếp',
        },
      );
      return result;
    });

    await this.audit.record({
      actor,
      action: 'APPLICATION_RESUME_AI',
      entity: 'applications',
      entityId: id,
      before,
      after: saved,
      context: { note: dto.note ?? null },
    });
    return this.findOne(id);
  }

  // ---------------------------------------------------------------- AI ----

  /** Idempotent: hồ sơ còn hiệu lực của cặp (ứng viên, vị trí) luôn là một. */
  async aiFindOrCreate(dto: AiFindOrCreateApplicationDto) {
    const candidate = await this.getCandidateOrThrow(dto.candidateId);
    if (candidate.aiStoppedAt) {
      throw new ConflictException({
        code: 'AI_STOPPED_FOR_CANDIDATE',
        message:
          'Ứng viên đã yêu cầu xoá dữ liệu — AI dừng xử lý, HR sẽ liên hệ trực tiếp',
      });
    }
    const job = await this.getJobOrThrow(dto.jobId);

    const existing = await this.findActive(dto.candidateId, dto.jobId);
    if (existing)
      return { created: false, application: toAiApplicationView(existing) };

    if (job.status !== RecruitmentJobStatus.ACTIVE) {
      throw new ConflictException({
        code: 'JOB_NOT_ACTIVE',
        message: `Vị trí đang ở trạng thái ${job.status}, không nhận hồ sơ mới`,
      });
    }

    let saved: RecruitmentApplication;
    try {
      saved = await this.applicationRepo.save(
        this.applicationRepo.create({
          candidateId: dto.candidateId,
          jobId: dto.jobId,
          source: dto.source ?? candidate.source,
          status: ApplicationStatus.NEW,
        }),
      );
    } catch (error) {
      // OpenClaw retry song song: request kia đã tạo trước — trả lại hồ sơ đó.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.findActive(dto.candidateId, dto.jobId);
      if (!raced) throw this.duplicateApplication();
      return { created: false, application: toAiApplicationView(raced) };
    }

    await this.audit.record({
      actor: AI_ACTOR,
      action: 'APPLICATION_CREATE',
      entity: 'applications',
      entityId: saved.id,
      after: saved,
      context: { candidateId: saved.candidateId, jobId: saved.jobId },
    });
    return { created: true, application: toAiApplicationView(saved) };
  }

  async getAiContext(id: number) {
    const application = await this.getOrThrow(id);
    const [candidate, job] = await Promise.all([
      this.getCandidateOrThrow(application.candidateId),
      this.jobRepo.findOne({
        where: { id: application.jobId },
        relations: { department: true },
      }),
    ]);
    const conversation = await this.conversationRepo.findOne({
      where: [{ applicationId: id }, { candidateId: candidate.id }],
      order: {
        lastMessageAt: { direction: 'DESC', nulls: 'LAST' },
        id: 'DESC',
      },
    });
    return this.buildContext({ candidate, application, job, conversation });
  }

  /**
   * Context có cấu trúc cho OpenClaw: dữ liệu đã có, còn thiếu gì, đang chờ
   * HR gì, lịch phỏng vấn, tin nhắn gần nhất và **việc được phép làm tiếp**.
   */
  async buildContext(params: {
    candidate: RecruitmentCandidate;
    application: RecruitmentApplication | null;
    job: RecruitmentJob | null;
    conversation: RecruitmentConversation | null;
  }) {
    const { candidate, application, job, conversation } = params;

    const [openHandoffs, activeInterview, recentMessages] = await Promise.all([
      this.handoffRepo.find({
        where: application
          ? [
              { applicationId: application.id, status: HandoffStatus.OPEN },
              {
                candidateId: candidate.id,
                applicationId: IsNull(),
                status: HandoffStatus.OPEN,
              },
            ]
          : { candidateId: candidate.id, status: HandoffStatus.OPEN },
        order: { createdAt: 'DESC' },
      }),
      application
        ? this.interviewRepo.findOne({
            where: {
              applicationId: application.id,
              status: In(ACTIVE_INTERVIEW_STATUSES),
            },
          })
        : Promise.resolve(null),
      conversation
        ? this.messageRepo.find({
            where: { conversationId: conversation.id },
            order: { createdAt: 'DESC', id: 'DESC' },
            take: RECENT_MESSAGE_LIMIT,
          })
        : Promise.resolve([] as RecruitmentMessage[]),
    ]);

    const required = job
      ? requiredCandidateFields({
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          criteria: job.screeningCriteria,
        })
      : (['fullName', 'phone'] as const);
    const missingFields = required.filter((field) => isBlank(candidate[field]));

    const allowedActions = this.aiAllowedActions(
      candidate,
      application,
      activeInterview,
    );
    const aiStopped = !!candidate.aiStoppedAt;
    const aiPaused = !!application?.aiPaused;

    return {
      candidate: toAiCandidateView(candidate),
      job: job ? toAiJobView(job) : null,
      application: application ? toAiApplicationView(application) : null,
      conversationId: conversation?.id ?? null,
      missingFields,
      openHandoffs: openHandoffs.map((h) => ({
        id: h.id,
        reason: h.reason,
        priority: h.priority,
        createdAt: h.createdAt,
      })),
      activeInterview: activeInterview
        ? toAiInterviewView(activeInterview)
        : null,
      recentMessages: recentMessages.reverse().map((m) => ({
        id: m.id,
        senderType: m.senderType,
        direction: m.direction,
        content: m.content,
        contentType: m.contentType,
        createdAt: m.createdAt,
      })),
      aiStopped,
      aiPaused,
      allowedActions,
      guidance: aiStopped
        ? 'Ứng viên đã yêu cầu xoá dữ liệu. Chỉ xác nhận đã ghi nhận yêu cầu và HR sẽ liên hệ; không hỏi thêm thông tin.'
        : aiPaused
          ? 'Hồ sơ đang chờ HR xử lý. Chỉ trả lời rằng HR sẽ liên hệ; không đưa ra quyết định hay hứa hẹn kết quả.'
          : missingFields.length
            ? `Cần hỏi thêm: ${missingFields.join(', ')}.`
            : null,
    };
  }

  // ----------------------------------------------------------- helpers ----

  async getOrThrow(id: number): Promise<RecruitmentApplication> {
    const application = await this.applicationRepo.findOne({ where: { id } });
    if (!application) throw this.notFound(id);
    return application;
  }

  private aiAllowedActions(
    candidate: RecruitmentCandidate,
    application: RecruitmentApplication | null,
    activeInterview: RecruitmentInterview | null,
  ): AiAllowedAction[] {
    const actions: AiAllowedAction[] = ['SAVE_MESSAGE'];
    if (candidate.aiStoppedAt) return actions;

    actions.push('UPDATE_CANDIDATE', 'REQUEST_DATA_DELETION');
    if (!application) {
      actions.push('FIND_OR_CREATE_APPLICATION');
      return actions;
    }
    if (TERMINAL_APPLICATION_STATUSES.includes(application.status)) {
      actions.push('FIND_OR_CREATE_APPLICATION');
      return actions;
    }
    if (application.aiPaused) return actions;

    actions.push('HANDOFF_TO_HR');
    if (SCREENABLE_STATUSES.includes(application.status) && !activeInterview) {
      actions.push('SCREEN_CANDIDATE');
    }
    if (application.status === ApplicationStatus.QUALIFIED) {
      if (!activeInterview)
        actions.push('GET_INTERVIEW_SLOTS', 'PROPOSE_INTERVIEW');
      else if (activeInterview.status === InterviewStatus.PROPOSED)
        actions.push('CONFIRM_INTERVIEW');
    }
    return actions;
  }

  private listQuery() {
    return this.applicationRepo
      .createQueryBuilder('a')
      .leftJoin('a.candidate', 'c')
      .leftJoin('a.job', 'j')
      .addSelect([
        'c.id',
        'c.fullName',
        'c.phone',
        'c.email',
        'c.source',
        'c.location',
        'c.deletionRequestedAt',
        'j.id',
        'j.code',
        'j.title',
        'j.status',
      ]);
  }

  private applyFilters(
    qb: SelectQueryBuilder<RecruitmentApplication>,
    query: QueryApplicationDto,
    withStatus: boolean,
  ) {
    if (query.jobId) qb.andWhere('a.jobId = :jobId', { jobId: query.jobId });
    if (query.candidateId)
      qb.andWhere('a.candidateId = :candidateId', {
        candidateId: query.candidateId,
      });
    if (withStatus && query.status?.length)
      qb.andWhere('a.status IN (:...statuses)', { statuses: query.status });
    if (query.source)
      qb.andWhere('a.source = :source', { source: query.source });
    if (query.matchLevel)
      qb.andWhere('a.aiMatchLevel = :matchLevel', {
        matchLevel: query.matchLevel,
      });
    if (query.aiPaused !== undefined)
      qb.andWhere('a.aiPaused = :aiPaused', { aiPaused: query.aiPaused });
    if (query.fromDate)
      qb.andWhere('a.createdAt >= :from', { from: vnDayStart(query.fromDate) });
    if (query.toDate)
      qb.andWhere('a.createdAt <= :to', { to: vnDayEnd(query.toDate) });
    if (query.keyword) {
      const kw = likePattern(query.keyword);
      qb.andWhere(
        new Brackets((w) =>
          w
            .where('c.fullName ILIKE :kw', { kw })
            .orWhere('c.email ILIKE :kw', { kw })
            .orWhere('c.phone LIKE :kw', { kw }),
        ),
      );
    }
  }

  /** Huỷ lịch phỏng vấn đang treo và đóng các yêu cầu HR khi hồ sơ kết thúc. */
  private async closeOpenWork(
    em: EntityManager,
    applicationId: number,
    actor: RecruitmentActor,
    note: string,
    now: Date,
  ) {
    const interviewRepo = em.getRepository(RecruitmentInterview);
    const active = await interviewRepo.find({
      where: { applicationId, status: In(ACTIVE_INTERVIEW_STATUSES) },
    });
    for (const interview of active) {
      interview.status = InterviewStatus.CANCELLED;
      interview.cancelledAt = now;
      interview.cancellationReason = note;
      await interviewRepo.save(interview);
      if (interview.slotId) await this.slots.release(em, interview.slotId);
    }
    await em.getRepository(RecruitmentHandoff).update(
      { applicationId, status: HandoffStatus.OPEN },
      {
        status: HandoffStatus.RESOLVED,
        resolvedBy: actor.employeeId,
        resolvedAt: now,
        resolutionNote: note,
      },
    );
  }

  private findActive(candidateId: number, jobId: number) {
    return this.applicationRepo.findOne({
      where: {
        candidateId,
        jobId,
        status: Not(In([...INACTIVE_APPLICATION_STATUSES])),
      },
    });
  }

  private async getCandidateOrThrow(id: number) {
    const candidate = await this.candidateRepo.findOne({ where: { id } });
    if (!candidate) {
      throw new NotFoundException({
        code: 'CANDIDATE_NOT_FOUND',
        message: `Không tìm thấy ứng viên #${id}`,
      });
    }
    return candidate;
  }

  private async getJobOrThrow(id: number) {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) {
      throw new NotFoundException({
        code: 'JOB_NOT_FOUND',
        message: `Không tìm thấy vị trí tuyển dụng #${id}`,
      });
    }
    return job;
  }

  private duplicateApplication(applicationId?: number) {
    return new ConflictException({
      code: 'APPLICATION_EXISTS',
      message: 'Ứng viên đã có hồ sơ còn hiệu lực cho vị trí này',
      applicationId: applicationId ?? null,
    });
  }

  private notFound(id: number) {
    return new NotFoundException({
      code: 'APPLICATION_NOT_FOUND',
      message: `Không tìm thấy hồ sơ ứng tuyển #${id}`,
    });
  }
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
