import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentConversation } from '../entities/recruitment-conversation.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import {
  RecruitmentAuditService,
  type RecruitmentAuditEntity,
} from '../recruitment-audit.service';
import { AI_ACTOR } from '../recruitment.roles';
import {
  formatRecruitmentSubject,
  type RecruitmentAiSubject,
} from './recruitment-ai-subject';

interface Owner {
  oaId: string | null;
  userId: string | null;
}

/**
 * Ranh giới dữ liệu của kênh tin cậy: request mang subject chỉ được đụng tới hồ
 * sơ của **đúng** người gửi đó. Kiểm theo quan hệ trong DB (không tin id khác
 * mà model gửi kèm), và không phân biệt "không tồn tại" với "của người khác"
 * để không ai dò được id hợp lệ.
 */
@Injectable()
export class RecruitmentAiOwnershipService {
  private readonly logger = new Logger(RecruitmentAiOwnershipService.name);

  constructor(
    @InjectRepository(RecruitmentCandidate)
    private readonly candidateRepo: Repository<RecruitmentCandidate>,
    @InjectRepository(RecruitmentApplication)
    private readonly applicationRepo: Repository<RecruitmentApplication>,
    @InjectRepository(RecruitmentConversation)
    private readonly conversationRepo: Repository<RecruitmentConversation>,
    @InjectRepository(RecruitmentInterview)
    private readonly interviewRepo: Repository<RecruitmentInterview>,
    private readonly audit: RecruitmentAuditService,
  ) {}

  async assertCandidate(
    subject: RecruitmentAiSubject,
    candidateId: number,
    operation: string,
  ): Promise<void> {
    const owner = await this.candidateRepo
      .createQueryBuilder('c')
      .select('c.zalo_oa_id', 'oaId')
      .addSelect('c.zalo_user_id', 'userId')
      .where('c.id = :id', { id: candidateId })
      .getRawOne<Owner>();
    if (!isOwner(subject, owner)) {
      await this.deny(subject, operation, 'candidates', candidateId);
    }
  }

  async assertApplication(
    subject: RecruitmentAiSubject,
    applicationId: number,
    operation: string,
  ): Promise<void> {
    const owner = await this.applicationRepo
      .createQueryBuilder('a')
      .innerJoin(RecruitmentCandidate, 'c', 'c.id = a.candidateId')
      .select('c.zalo_oa_id', 'oaId')
      .addSelect('c.zalo_user_id', 'userId')
      .where('a.id = :id', { id: applicationId })
      .getRawOne<Owner>();
    if (!isOwner(subject, owner)) {
      await this.deny(subject, operation, 'applications', applicationId);
    }
  }

  /** Hội thoại: chủ của hội thoại và (nếu có) chủ hồ sơ ứng tuyển gắn kèm đều phải khớp. */
  async assertConversation(
    subject: RecruitmentAiSubject,
    conversationId: number,
    operation: string,
  ): Promise<void> {
    const row = await this.conversationRepo
      .createQueryBuilder('cv')
      .innerJoin(RecruitmentCandidate, 'c', 'c.id = cv.candidateId')
      .leftJoin(RecruitmentApplication, 'a', 'a.id = cv.applicationId')
      .leftJoin(RecruitmentCandidate, 'ac', 'ac.id = a.candidateId')
      .select('c.zalo_oa_id', 'oaId')
      .addSelect('c.zalo_user_id', 'userId')
      .addSelect('cv.application_id', 'applicationId')
      .addSelect('ac.zalo_oa_id', 'appOaId')
      .addSelect('ac.zalo_user_id', 'appUserId')
      .where('cv.id = :id', { id: conversationId })
      .getRawOne<
        Owner & {
          applicationId: number | null;
          appOaId: string | null;
          appUserId: string | null;
        }
      >();
    const ok =
      isOwner(subject, row) &&
      (row!.applicationId == null ||
        isOwner(subject, { oaId: row!.appOaId, userId: row!.appUserId }));
    if (!ok) {
      await this.deny(subject, operation, 'conversations', conversationId);
    }
  }

  /** Lịch phỏng vấn: kiểm qua hồ sơ ứng tuyển → ứng viên, và cả ứng viên ghi trên lịch. */
  async assertInterview(
    subject: RecruitmentAiSubject,
    interviewId: number,
    operation: string,
  ): Promise<void> {
    const row = await this.interviewRepo
      .createQueryBuilder('i')
      .innerJoin(RecruitmentApplication, 'a', 'a.id = i.applicationId')
      .innerJoin(RecruitmentCandidate, 'c', 'c.id = a.candidateId')
      .innerJoin(RecruitmentCandidate, 'ic', 'ic.id = i.candidateId')
      .select('c.zalo_oa_id', 'oaId')
      .addSelect('c.zalo_user_id', 'userId')
      .addSelect('ic.zalo_oa_id', 'ivOaId')
      .addSelect('ic.zalo_user_id', 'ivUserId')
      .where('i.id = :id', { id: interviewId })
      .getRawOne<Owner & { ivOaId: string | null; ivUserId: string | null }>();
    const ok =
      isOwner(subject, row) &&
      isOwner(subject, { oaId: row!.ivOaId, userId: row!.ivUserId });
    if (!ok) {
      await this.deny(subject, operation, 'interviews', interviewId);
    }
  }

  /** Model khai danh tính khác subject tin cậy (vd. `zaloUserId` trong body). */
  async denyIdentityClaim(
    subject: RecruitmentAiSubject,
    operation: string,
  ): Promise<never> {
    return this.deny(subject, operation, 'candidates', 0);
  }

  private async deny(
    subject: RecruitmentAiSubject,
    operation: string,
    resourceType: RecruitmentAuditEntity,
    resourceId: number,
  ): Promise<never> {
    const subjectText = formatRecruitmentSubject(subject);
    this.logger.warn(
      `SUBJECT_MISMATCH: ${subjectText} → ${operation} ${resourceType}#${resourceId}`,
    );
    try {
      // Không ghi payload/tin nhắn — chỉ đủ để điều tra ai đòi gì.
      await this.audit.record({
        actor: AI_ACTOR,
        action: 'AI_SUBJECT_DENIED',
        entity: resourceType,
        entityId: resourceId,
        success: false,
        context: {
          subject: subjectText,
          operation,
          resourceType,
          resourceId,
          result: 'DENIED',
        },
      });
    } catch (error) {
      this.logger.error(
        `Không ghi được audit AI_SUBJECT_DENIED: ${(error as Error).message}`,
      );
    }
    throw new ForbiddenException({
      code: 'SUBJECT_MISMATCH',
      message: 'Không có quyền truy cập dữ liệu này',
    });
  }
}

function isOwner(
  subject: RecruitmentAiSubject,
  owner: Owner | undefined | null,
): boolean {
  return (
    !!owner && owner.oaId === subject.oaId && owner.userId === subject.userId
  );
}
