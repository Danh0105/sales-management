import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { assertApplicationTransition } from '../application-status.state-machine';
import type { AiScreenApplicationDto } from '../dto/ai.dto';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  ApplicationStatus,
  HandoffReason,
  InterviewStatus,
  RecommendedAction,
} from '../recruitment.enums';
import { AI_ACTOR, SYSTEM_ACTOR } from '../recruitment.roles';
import { assertAiCanAct, isUniqueViolation } from '../recruitment.views';
import { evaluateScreening } from '../screening/screening-engine';
import type { ScreeningResult } from '../screening/screening.types';
import { todayInVietnam } from '../utils/text-normalize';
import { openHandoffInTx } from './handoff.helpers';

const SCREENABLE_STATUSES = [
  ApplicationStatus.NEW,
  ApplicationStatus.COLLECTING_INFO,
  ApplicationStatus.SCREENING,
  ApplicationStatus.QUALIFIED,
];

/** Kết quả sàng lọc → trạng thái hồ sơ. AI không bao giờ tự loại ứng viên. */
const STATUS_BY_ACTION: Record<RecommendedAction, ApplicationStatus> = {
  [RecommendedAction.PROPOSE_INTERVIEW]: ApplicationStatus.QUALIFIED,
  [RecommendedAction.COLLECT_MORE_INFO]: ApplicationStatus.COLLECTING_INFO,
  [RecommendedAction.HR_REVIEW]: ApplicationStatus.NEEDS_HR_REVIEW,
  [RecommendedAction.HANDOFF_TO_HR]: ApplicationStatus.NEEDS_HR_REVIEW,
};

/**
 * Sàng lọc hybrid:
 * - AI gửi dữ liệu đã thu thập (kỹ năng đã map, số tháng kinh nghiệm, lương
 *   mong muốn, ngày bắt đầu...) → ghi vào hồ sơ ứng viên;
 * - backend chấm điểm **tất định** bằng `evaluateScreening` trên dữ liệu đã lưu;
 * - `aiSummary` chỉ lưu để HR đọc, không ảnh hưởng điểm.
 *
 * MEDIUM/LOW/lương vượt khung → NEEDS_HR_REVIEW và tự mở yêu cầu HR (khoá
 * AI). Thiếu dữ liệu → COLLECTING_INFO để AI hỏi tiếp rồi chấm lại.
 */
@Injectable()
export class RecruitmentScreeningService {
  constructor(
    @InjectRepository(RecruitmentApplication)
    private readonly applicationRepo: Repository<RecruitmentApplication>,
    @InjectRepository(RecruitmentInterview)
    private readonly interviewRepo: Repository<RecruitmentInterview>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
  ) {}

  async screen(applicationId: number, dto: AiScreenApplicationDto) {
    const application = await this.applicationRepo.findOne({
      where: { id: applicationId },
      relations: { candidate: true, job: true },
    });
    if (!application || !application.candidate || !application.job) {
      throw new NotFoundException({
        code: 'APPLICATION_NOT_FOUND',
        message: `Không tìm thấy hồ sơ ứng tuyển #${applicationId}`,
      });
    }
    const { candidate, job } = application;
    assertAiCanAct(application, candidate);

    if (!SCREENABLE_STATUSES.includes(application.status)) {
      throw new ConflictException({
        code: 'SCREENING_NOT_ALLOWED',
        message: `Không sàng lọc lại hồ sơ đang ở trạng thái ${application.status}`,
      });
    }
    const activeInterview = await this.interviewRepo.findOne({
      where: {
        applicationId,
        status: In([InterviewStatus.PROPOSED, InterviewStatus.CONFIRMED]),
      },
    });
    if (activeInterview) {
      throw new ConflictException({
        code: 'INTERVIEW_IN_PROGRESS',
        message: 'Hồ sơ đã có lịch phỏng vấn — không chấm lại được',
        interviewId: activeInterview.id,
      });
    }

    const candidateBefore = { ...candidate };
    const applicationBefore = stripRelations(application);
    const candidateChanged = this.mergeCollectedData(candidate, dto);

    const result = evaluateScreening(
      {
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        criteria: job.screeningCriteria,
      },
      {
        totalExperienceMonths: candidate.totalExperienceMonths,
        skills: candidate.skills ?? [],
        location: candidate.location,
        expectedSalary: candidate.expectedSalary,
        availableFrom: candidate.availableFrom,
      },
      todayInVietnam(),
    );

    const target = STATUS_BY_ACTION[result.recommendedAction];
    if (application.status !== ApplicationStatus.SCREENING) {
      assertApplicationTransition(
        application.status,
        ApplicationStatus.SCREENING,
        AI_ACTOR.type,
      );
    }
    if (target !== ApplicationStatus.SCREENING) {
      assertApplicationTransition(
        ApplicationStatus.SCREENING,
        target,
        AI_ACTOR.type,
      );
    }

    const now = new Date();
    application.status = target;
    application.aiMatchScore = result.score;
    application.aiMatchLevel = result.matchLevel;
    application.aiStrengths = result.strengths;
    application.aiConcerns = result.concerns;
    application.aiMissingInformation = result.missingInformation;
    application.aiScoreBreakdown = result.breakdown;
    application.screeningCompletedAt = now;
    if (dto.aiSummary !== undefined)
      application.aiSummary = dto.aiSummary ?? null;
    const needsHr = target === ApplicationStatus.NEEDS_HR_REVIEW;
    if (needsHr) application.aiPaused = true;

    let handoff: { handoff: RecruitmentHandoff; created: boolean } | null =
      null;
    try {
      handoff = await this.dataSource.transaction(async (em) => {
        if (candidateChanged)
          await em.getRepository(RecruitmentCandidate).save(candidate);
        await em
          .getRepository(RecruitmentApplication)
          .save(stripRelations(application));
        if (!needsHr) return null;
        return openHandoffInTx(em, {
          candidateId: candidate.id,
          applicationId,
          reason: result.salaryOutOfRange
            ? HandoffReason.SALARY_OUT_OF_RANGE
            : HandoffReason.FINAL_DECISION_REQUIRED,
          summary: this.handoffSummary(result),
          actor: SYSTEM_ACTOR,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'CONCURRENT_UPDATE',
          message:
            'Hồ sơ vừa được cập nhật bởi một request khác — đọc lại context rồi thử lại',
        });
      }
      throw error;
    }

    if (candidateChanged) {
      await this.audit.record({
        actor: AI_ACTOR,
        action: 'CANDIDATE_UPDATE',
        entity: 'candidates',
        entityId: candidate.id,
        before: candidateBefore,
        after: candidate,
        context: { via: 'screening', applicationId },
      });
    }
    await this.audit.record({
      actor: AI_ACTOR,
      action: 'APPLICATION_SCREEN',
      entity: 'applications',
      entityId: applicationId,
      before: applicationBefore,
      after: stripRelations(application),
      context: {
        score: result.score,
        matchLevel: result.matchLevel,
        recommendedAction: result.recommendedAction,
        from: applicationBefore.status,
        to: target,
        handoffId: handoff?.handoff.id ?? null,
      },
    });

    return {
      applicationId,
      score: result.score,
      matchLevel: result.matchLevel,
      strengths: result.strengths,
      concerns: result.concerns,
      missingInformation: result.missingInformation,
      recommendedAction: result.recommendedAction,
      status: application.status,
      aiPaused: application.aiPaused,
      handoffId: handoff?.handoff.id ?? null,
      breakdown: result.breakdown,
    };
  }

  /** Ghi dữ liệu AI thu thập vào hồ sơ ứng viên. Trả `true` nếu có gì đổi. */
  private mergeCollectedData(
    candidate: RecruitmentCandidate,
    dto: AiScreenApplicationDto,
  ) {
    let changed = false;
    const set = <K extends keyof RecruitmentCandidate>(
      key: K,
      value: RecruitmentCandidate[K] | undefined,
    ) => {
      if (value === undefined) return;
      if (JSON.stringify(candidate[key]) === JSON.stringify(value)) return;
      candidate[key] = value;
      changed = true;
    };
    set('skills', dto.extractedSkills);
    set('experienceSummary', dto.experienceSummary);
    set('totalExperienceMonths', dto.totalExperienceMonths);
    set('availableFrom', dto.availableFrom);
    set('expectedSalary', dto.expectedSalary);
    set('location', dto.location);
    return changed;
  }

  private handoffSummary(result: ScreeningResult): string {
    const head = `Sàng lọc tự động: ${result.score}/100 (${result.matchLevel}).`;
    const why = result.salaryOutOfRange
      ? 'Lương mong muốn vượt khung — cần HR quyết định.'
      : 'Chưa đủ điều kiện tự đề xuất phỏng vấn — cần HR xem xét.';
    const concerns = result.concerns.length
      ? ` Lưu ý: ${result.concerns.join('; ')}.`
      : '';
    return `${head} ${why}${concerns}`;
  }
}

/** Bỏ quan hệ đã join để `save` không ghi đè FK theo object cũ. */
function stripRelations(
  application: RecruitmentApplication,
): RecruitmentApplication {
  const rest = { ...application };
  delete rest.candidate;
  delete rest.job;
  delete rest.reviewer;
  return rest;
}
