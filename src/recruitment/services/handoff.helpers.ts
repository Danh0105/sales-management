import { EntityManager, IsNull } from 'typeorm';

import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import {
  HandoffPriority,
  HandoffReason,
  HandoffStatus,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';

/**
 * Mở yêu cầu HR trong transaction đang chạy. Đã có yêu cầu OPEN cùng lý do
 * cho cùng hồ sơ (hoặc cùng ứng viên khi không gắn hồ sơ) thì trả lại yêu cầu
 * đó — retry không đẻ thêm việc cho HR.
 *
 * Không bắt lỗi unique ở đây: trong Postgres, lỗi làm hỏng cả transaction.
 * Caller bắt `23505` **sau** transaction rồi đọc lại.
 */
export async function openHandoffInTx(
  em: EntityManager,
  params: {
    candidateId: number;
    applicationId: number | null;
    reason: HandoffReason;
    priority?: HandoffPriority;
    summary: string;
    actor: RecruitmentActor;
  },
): Promise<{ handoff: RecruitmentHandoff; created: boolean }> {
  const repo = em.getRepository(RecruitmentHandoff);
  const existing = await findOpenHandoff(repo.manager, params);
  if (existing) return { handoff: existing, created: false };

  const handoff = await repo.save(
    repo.create({
      candidateId: params.candidateId,
      applicationId: params.applicationId,
      reason: params.reason,
      priority: params.priority ?? HandoffPriority.NORMAL,
      summary: params.summary,
      status: HandoffStatus.OPEN,
      requestedByType: params.actor.type,
      requestedBy: params.actor.employeeId,
    }),
  );
  return { handoff, created: true };
}

export function findOpenHandoff(
  em: EntityManager,
  params: {
    candidateId: number;
    applicationId: number | null;
    reason: HandoffReason;
  },
): Promise<RecruitmentHandoff | null> {
  return em.getRepository(RecruitmentHandoff).findOne({
    where: params.applicationId
      ? {
          applicationId: params.applicationId,
          reason: params.reason,
          status: HandoffStatus.OPEN,
        }
      : {
          candidateId: params.candidateId,
          applicationId: IsNull(),
          reason: params.reason,
          status: HandoffStatus.OPEN,
        },
  });
}
