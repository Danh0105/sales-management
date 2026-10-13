import { Injectable } from '@nestjs/common';

import { ActivityLogService } from '../activity-log/activity-log.service';
import { capPayload } from '../activity-log/activity-log.util';
import { RecruitmentActorType } from './recruitment.enums';
import type { RecruitmentActor } from './recruitment.roles';

/**
 * `activity_log.actorId` là `int NOT NULL`, không FK. AI/hệ thống không phải
 * nhân viên nên dùng id âm: **không dùng 0** vì `ActivityLogService.find` lọc
 * bằng `if (dto.actorId)` — 0 là falsy, lọc theo AI sẽ ra cả bảng.
 */
export const RECRUITMENT_AI_ACTOR_ID = -1;
export const RECRUITMENT_SYSTEM_ACTOR_ID = -2;

export type RecruitmentAuditEntity =
  | 'jobs'
  | 'candidates'
  | 'applications'
  | 'interviews'
  | 'interview-slots'
  | 'handoffs'
  | 'conversations'
  | 'channel-events'
  | 'channel-outbox'
  | 'channel-quarantine'
  | 'hr-alerts';

export type RecruitmentAuditAction =
  | 'JOB_CREATE'
  | 'JOB_UPDATE'
  | 'JOB_PUBLISH'
  | 'JOB_PAUSE'
  | 'JOB_CLOSE'
  | 'CANDIDATE_CREATE'
  | 'CANDIDATE_UPDATE'
  | 'CANDIDATE_DELETION_REQUEST'
  | 'APPLICATION_CREATE'
  | 'APPLICATION_STATUS_CHANGE'
  | 'APPLICATION_SCREEN'
  | 'APPLICATION_RESUME_AI'
  | 'HANDOFF_CREATE'
  | 'HANDOFF_RESOLVE'
  | 'INTERVIEW_SLOT_CREATE'
  | 'INTERVIEW_SLOT_UPDATE'
  | 'INTERVIEW_CREATE'
  | 'INTERVIEW_PROPOSE'
  | 'INTERVIEW_CONFIRM'
  | 'INTERVIEW_UPDATE'
  /** Kênh tin cậy đòi truy cập dữ liệu không thuộc người gửi — bị chặn. */
  | 'AI_SUBJECT_DENIED'
  /** Tin ứng viên không xử lý được (lỗi cuối hoặc quá hạn giữ) — HR cần xem. */
  | 'CHANNEL_EVENT_DEAD_LETTER'
  /** P3-7.3 R1 — người vận hành loại event inbox khỏi xử lý (vd. tin thử); không ghi nội dung. */
  | 'CHANNEL_EVENT_EXCLUDE'
  /** Tin trả lời không gửi được ra Zalo — HR cần xem. */
  | 'CHANNEL_OUTBOX_DEAD_LETTER'
  /** Tin trả lời có thể đã tới Zalo nhưng không rõ — cần đối soát, không tự gửi lại. */
  | 'CHANNEL_OUTBOX_UNKNOWN'
  /** Tin AI bị chặn trước khi gửi vì HR đã đổi điều khiển hội thoại (P3-6.5). */
  | 'CHANNEL_OUTBOX_SUPPRESSED'
  /** P3-7.2A — xác minh hồi tố request webhook đã cách ly (chỉ số lượng). */
  | 'CHANNEL_QUARANTINE_VERIFY'
  /** P3-6 — HR điều khiển hội thoại kênh. */
  | 'CONVERSATION_TAKEOVER'
  | 'CONVERSATION_RESUME_AI'
  | 'CONVERSATION_CLOSE'
  | 'CONVERSATION_HR_MESSAGE'
  /** P3-6 — người vận hành đối soát outbox UNKNOWN. */
  | 'OUTBOX_MARK_SENT'
  | 'OUTBOX_RETRY'
  | 'OUTBOX_DEAD_LETTER'
  | 'HR_ALERT_ACKNOWLEDGE';

/**
 * Ghi nhật ký nghiệp vụ Tuyển dụng vào `activity_log` có sẵn — không dựng
 * bảng audit riêng.
 *
 * - `resource` = `recruitment-<entity>` và `path` = `/recruitment-<entity>/<id>`
 *   nên `GET /activity-logs/recruitment-applications/12` ra được lịch sử của
 *   đúng hồ sơ 12 bằng endpoint đang có.
 * - `method` mang tên action (`APPLICATION_SCREEN`...) — màn hình nhật ký hiện
 *   nguyên văn khi không phải GET/POST/PATCH/DELETE.
 *
 * Request của AI không có `req.user` nên interceptor toàn cục bỏ qua; các
 * dòng ở đây là vết duy nhất của AI. Request HR vẫn được interceptor ghi ở mức
 * request như mọi module khác — dòng ở đây bổ sung trước/sau ở mức nghiệp vụ.
 */
@Injectable()
export class RecruitmentAuditService {
  constructor(private readonly activityLog: ActivityLogService) {}

  async record(params: {
    actor: RecruitmentActor;
    action: RecruitmentAuditAction;
    entity: RecruitmentAuditEntity;
    entityId: number;
    before?: unknown;
    after?: unknown;
    context?: Record<string, unknown>;
    /** `false` cho thao tác bị từ chối (vd. `AI_SUBJECT_DENIED`). */
    success?: boolean;
  }): Promise<void> {
    const { actor, action, entity, entityId } = params;
    const resource = `recruitment-${entity}`;

    await this.activityLog.record({
      actorId: actorIdOf(actor),
      actorName: actor.name,
      actorRoles: actor.roles,
      method: action,
      path: `/${resource}/${entityId}`,
      resource,
      context: {
        action,
        actorType: actor.type,
        entity,
        entityId,
        ...(params.context ?? {}),
      },
      beforeData: capPayload(toPlain(params.before)) as unknown,
      afterData: capPayload(toPlain(params.after)) as unknown,
      changes: capPayload(diff(params.before, params.after)) as unknown,
      statusCode: null,
      success: params.success ?? true,
    });
  }
}

function actorIdOf(actor: RecruitmentActor): number {
  if (actor.type === RecruitmentActorType.HR && actor.employeeId) {
    return actor.employeeId;
  }
  return actor.type === RecruitmentActorType.SYSTEM
    ? RECRUITMENT_SYSTEM_ACTOR_ID
    : RECRUITMENT_AI_ACTOR_ID;
}

/** Bỏ quan hệ đã join để nhật ký chỉ chứa cột của chính bản ghi. */
function toPlain(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      v &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      !Array.isArray(v)
    ) {
      // jsonb (criteria, breakdown, metadata) vẫn giữ; entity quan hệ thì có `id`.
      if ('id' in v) continue;
    }
    out[k] = v;
  }
  return out;
}

const DIFF_IGNORED = new Set(['updatedAt', 'createdAt']);

function diff(
  before: unknown,
  after: unknown,
): Array<{ field: string; before: unknown; after: unknown }> | null {
  const b = toPlain(before);
  const a = toPlain(after);
  if (!b || !a) return null;
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (DIFF_IGNORED.has(key)) continue;
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      changes.push({
        field: key,
        before: b[key] ?? null,
        after: a[key] ?? null,
      });
    }
  }
  return changes.length ? changes : null;
}
