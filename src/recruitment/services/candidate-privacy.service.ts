import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';

import { canTransition } from '../application-status.state-machine';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  ApplicationStatus,
  HandoffPriority,
  HandoffReason,
  HandoffStatus,
  TERMINAL_APPLICATION_STATUSES,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { isUniqueViolation } from '../recruitment.views';
import { openHandoffInTx } from './handoff.helpers';

export interface DeletionRequestResult {
  candidateId: number;
  deletionRequestedAt: Date;
  aiStopped: true;
  alreadyRequested: boolean;
  handoffId: number | null;
  pausedApplicationIds: number[];
}

/**
 * Quyền yêu cầu xoá dữ liệu của ứng viên — mức tối thiểu Phase 1:
 * 1. đánh dấu yêu cầu xoá,
 * 2. dừng hẳn AI với ứng viên này (mọi hồ sơ),
 * 3. mở yêu cầu HR ưu tiên cao.
 *
 * **Không** hard delete: hồ sơ/nhật ký có thể phải giữ vì nghiệp vụ hoặc pháp
 * lý — HR quyết định xoá/ẩn danh phần nào (Phase 2).
 */
@Injectable()
export class CandidatePrivacyService {
  constructor(
    @InjectRepository(RecruitmentCandidate)
    private readonly candidateRepo: Repository<RecruitmentCandidate>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
  ) {}

  async requestDeletion(
    candidateId: number,
    actor: RecruitmentActor,
    options: { note?: string | null; applicationId?: number | null } = {},
    attempt = 0,
  ): Promise<DeletionRequestResult> {
    const candidate = await this.candidateRepo.findOne({
      where: { id: candidateId },
    });
    if (!candidate) {
      throw new NotFoundException({
        code: 'CANDIDATE_NOT_FOUND',
        message: `Không tìm thấy ứng viên #${candidateId}`,
      });
    }

    if (candidate.deletionRequestedAt) {
      const open = await this.dataSource
        .getRepository(RecruitmentHandoff)
        .findOne({
          where: {
            candidateId,
            reason: HandoffReason.DATA_DELETION_REQUEST,
            status: HandoffStatus.OPEN,
          },
        });
      return {
        candidateId,
        deletionRequestedAt: candidate.deletionRequestedAt,
        aiStopped: true,
        alreadyRequested: true,
        handoffId: open?.id ?? null,
        pausedApplicationIds: [],
      };
    }

    const before = { ...candidate };
    const now = new Date();
    const statusChanges: Array<{
      id: number;
      from: ApplicationStatus;
      to: ApplicationStatus;
    }> = [];

    let handoffId: number | null;
    try {
      handoffId = await this.dataSource.transaction(async (em) => {
        candidate.deletionRequestedAt = now;
        candidate.aiStoppedAt = now;
        await em.getRepository(RecruitmentCandidate).save(candidate);

        const appRepo = em.getRepository(RecruitmentApplication);
        const active = await appRepo.find({
          where: {
            candidateId,
            status: Not(In([...TERMINAL_APPLICATION_STATUSES])),
          },
          order: { updatedAt: 'DESC' },
        });
        for (const app of active) {
          const from = app.status;
          app.aiPaused = true;
          if (
            from !== ApplicationStatus.NEEDS_HR_REVIEW &&
            canTransition(from, ApplicationStatus.NEEDS_HR_REVIEW, actor.type)
          ) {
            app.status = ApplicationStatus.NEEDS_HR_REVIEW;
          }
          await appRepo.save(app);
          statusChanges.push({ id: app.id, from, to: app.status });
        }

        const linkedId =
          options.applicationId &&
          active.some((a) => a.id === options.applicationId)
            ? options.applicationId
            : (active[0]?.id ?? null);
        const { handoff } = await openHandoffInTx(em, {
          candidateId,
          applicationId: linkedId,
          reason: HandoffReason.DATA_DELETION_REQUEST,
          priority: HandoffPriority.HIGH,
          summary:
            options.note?.trim() || 'Ứng viên yêu cầu xoá dữ liệu cá nhân',
          actor,
        });
        return handoff.id;
      });
    } catch (error) {
      // Hai yêu cầu xoá song song: request kia đã ghi xong — trả kết quả của nó.
      if (!isUniqueViolation(error) || attempt > 0) throw error;
      return this.requestDeletion(candidateId, actor, options, attempt + 1);
    }

    await this.audit.record({
      actor,
      action: 'CANDIDATE_DELETION_REQUEST',
      entity: 'candidates',
      entityId: candidateId,
      before,
      after: candidate,
      context: { handoffId, applications: statusChanges },
    });

    return {
      candidateId,
      deletionRequestedAt: now,
      aiStopped: true,
      alreadyRequested: false,
      handoffId,
      pausedApplicationIds: statusChanges.map((c) => c.id),
    };
  }
}
