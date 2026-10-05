import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { canTransition } from '../application-status.state-machine';
import type { AiHandoffDto } from '../dto/ai.dto';
import type { Paginated } from '../dto/common.dto';
import type { QueryHandoffDto, ResolveHandoffDto } from '../dto/handoff.dto';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  ApplicationStatus,
  HandoffReason,
  HandoffStatus,
  TERMINAL_APPLICATION_STATUSES,
} from '../recruitment.enums';
import { AI_ACTOR, type RecruitmentActor } from '../recruitment.roles';
import { isUniqueViolation } from '../recruitment.views';
import { CandidatePrivacyService } from './candidate-privacy.service';
import { findOpenHandoff, openHandoffInTx } from './handoff.helpers';

@Injectable()
export class RecruitmentHandoffService {
  constructor(
    @InjectRepository(RecruitmentHandoff)
    private readonly handoffRepo: Repository<RecruitmentHandoff>,
    @InjectRepository(RecruitmentApplication)
    private readonly applicationRepo: Repository<RecruitmentApplication>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly privacy: CandidatePrivacyService,
    private readonly audit: RecruitmentAuditService,
  ) {}

  /**
   * AI dừng xử lý và chuyển cho người thật. Hồ sơ sang NEEDS_HR_REVIEW và bị
   * khoá AI (`aiPaused`) cho tới khi HR trả lại. Từ OFFER thì giữ nguyên
   * trạng thái (HR đang đàm phán) nhưng vẫn khoá AI.
   *
   * `DATA_DELETION_REQUEST` đi qua `CandidatePrivacyService` vì nó dừng AI
   * với **mọi** hồ sơ của ứng viên, không chỉ hồ sơ này.
   */
  async aiHandoff(applicationId: number, dto: AiHandoffDto) {
    const application = await this.applicationRepo.findOne({
      where: { id: applicationId },
    });
    if (!application) {
      throw new NotFoundException({
        code: 'APPLICATION_NOT_FOUND',
        message: `Không tìm thấy hồ sơ ứng tuyển #${applicationId}`,
      });
    }

    if (dto.reason === HandoffReason.DATA_DELETION_REQUEST) {
      const result = await this.privacy.requestDeletion(
        application.candidateId,
        AI_ACTOR,
        {
          note: dto.summary,
          applicationId,
        },
      );
      const after = await this.applicationRepo.findOneOrFail({
        where: { id: applicationId },
      });
      return {
        handoffId: result.handoffId,
        reason: dto.reason,
        alreadyOpen: result.alreadyRequested,
        application: {
          id: after.id,
          status: after.status,
          aiPaused: after.aiPaused,
        },
        candidateAiStopped: true,
      };
    }

    if (TERMINAL_APPLICATION_STATUSES.includes(application.status)) {
      throw new ConflictException({
        code: 'APPLICATION_CLOSED',
        message: `Hồ sơ đã kết thúc (${application.status})`,
      });
    }

    const existing = await findOpenHandoff(this.dataSource.manager, {
      candidateId: application.candidateId,
      applicationId,
      reason: dto.reason,
    });
    if (existing) return this.result(existing, application, true);

    const before = { ...application };
    let handoff: RecruitmentHandoff;
    try {
      handoff = await this.dataSource.transaction(async (em) => {
        application.aiPaused = true;
        if (
          application.status !== ApplicationStatus.NEEDS_HR_REVIEW &&
          canTransition(
            application.status,
            ApplicationStatus.NEEDS_HR_REVIEW,
            AI_ACTOR.type,
          )
        ) {
          application.status = ApplicationStatus.NEEDS_HR_REVIEW;
        }
        await em.getRepository(RecruitmentApplication).save(application);

        const opened = await openHandoffInTx(em, {
          candidateId: application.candidateId,
          applicationId,
          reason: dto.reason,
          priority: dto.priority,
          summary: dto.summary,
          actor: AI_ACTOR,
        });
        return opened.handoff;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await findOpenHandoff(this.dataSource.manager, {
        candidateId: application.candidateId,
        applicationId,
        reason: dto.reason,
      });
      if (!raced) throw error;
      const current = await this.applicationRepo.findOneOrFail({
        where: { id: applicationId },
      });
      return this.result(raced, current, true);
    }

    await this.audit.record({
      actor: AI_ACTOR,
      action: 'HANDOFF_CREATE',
      entity: 'applications',
      entityId: applicationId,
      before,
      after: application,
      context: {
        handoffId: handoff.id,
        reason: handoff.reason,
        priority: handoff.priority,
        summary: handoff.summary,
      },
    });
    return this.result(handoff, application, false);
  }

  async list(query: QueryHandoffDto): Promise<Paginated<RecruitmentHandoff>> {
    const { page, limit } = query;
    const qb = this.handoffRepo
      .createQueryBuilder('h')
      .leftJoin('h.candidate', 'c')
      .leftJoin('h.application', 'a')
      .leftJoin('a.job', 'j')
      .addSelect(['c.id', 'c.fullName', 'c.phone', 'c.email'])
      .addSelect(['a.id', 'a.status', 'a.aiPaused', 'a.aiMatchLevel'])
      .addSelect(['j.id', 'j.code', 'j.title']);

    if (query.status)
      qb.andWhere('h.status = :status', { status: query.status });
    if (query.reason)
      qb.andWhere('h.reason = :reason', { reason: query.reason });
    if (query.priority)
      qb.andWhere('h.priority = :priority', { priority: query.priority });
    if (query.applicationId)
      qb.andWhere('h.applicationId = :applicationId', {
        applicationId: query.applicationId,
      });
    if (query.candidateId)
      qb.andWhere('h.candidateId = :candidateId', {
        candidateId: query.candidateId,
      });

    const [data, total] = await qb
      .orderBy('h.createdAt', 'DESC')
      .addOrderBy('h.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, limit };
  }

  /**
   * HR đã xử lý xong. Không tự mở lại AI — muốn AI làm tiếp thì dùng
   * `POST /recruitment/applications/:id/resume-ai`.
   */
  async resolve(id: number, dto: ResolveHandoffDto, actor: RecruitmentActor) {
    const handoff = await this.handoffRepo.findOne({ where: { id } });
    if (!handoff) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: `Không tìm thấy yêu cầu #${id}`,
      });
    }
    if (handoff.status !== HandoffStatus.OPEN) {
      throw new ConflictException({
        code: 'HANDOFF_NOT_OPEN',
        message: `Yêu cầu đã ở trạng thái ${handoff.status}`,
      });
    }
    const before = { ...handoff };
    handoff.status = HandoffStatus.RESOLVED;
    handoff.resolvedBy = actor.employeeId;
    handoff.resolvedAt = new Date();
    handoff.resolutionNote = dto.note ?? null;

    const saved = await this.handoffRepo.save(handoff);
    await this.audit.record({
      actor,
      action: 'HANDOFF_RESOLVE',
      entity: 'handoffs',
      entityId: id,
      before,
      after: saved,
      context: {
        applicationId: saved.applicationId,
        candidateId: saved.candidateId,
      },
    });
    return saved;
  }

  private result(
    handoff: RecruitmentHandoff,
    application: RecruitmentApplication,
    alreadyOpen: boolean,
  ) {
    return {
      handoffId: handoff.id,
      reason: handoff.reason,
      priority: handoff.priority,
      status: handoff.status,
      alreadyOpen,
      application: {
        id: application.id,
        status: application.status,
        aiPaused: application.aiPaused,
      },
    };
  }
}
