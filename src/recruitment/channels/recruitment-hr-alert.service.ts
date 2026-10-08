import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  HrAlertSeverity,
  HrAlertStatus,
  HrAlertType,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { returnedRows } from './recruitment-channel-event.queue';

export interface HrAlertDraft {
  type: HrAlertType;
  severity: HrAlertSeverity;
  sourceKey: string;
  candidateId?: number | null;
  applicationId?: number | null;
  conversationId?: number | null;
  handoffId?: number | null;
  outboxId?: number | null;
  eventId?: number | null;
  /** Chỉ mã/lý do/trạng thái — không nội dung tin, không token. */
  details?: Record<string, string | number | boolean | null>;
}

/** Quét lại trong cửa sổ này (nguồn cũ hơn coi như đã được xử lý từ trước). */
const SWEEP_WINDOW = `interval '30 days'`;

/** Lần thử một tin đến (đang thử lại) đạt mức này → AI đang hỏng lặp lại. */
const REPEATED_FAILURE_ATTEMPTS = 3;

/**
 * Cảnh báo HR bền (`recruitment_hr_alerts`) — một dòng cho mỗi nguồn sự cố.
 *
 * Hai đường tạo, cả hai idempotent (`ON CONFLICT (type, source_key) DO NOTHING`):
 * - `raise()`: ghi trực tiếp, có thể trong transaction nghiệp vụ của nơi gọi (như
 *   một outbox — không gửi thông báo trong transaction);
 * - `sweep()`: quét dữ liệu bền (handoff mở, outbox UNKNOWN/DEAD_LETTER, event
 *   dead-letter, lỗi AI lặp lại) — bắt được mọi đường tạo handoff của Phase 1 mà
 *   không phải sửa chúng, và tự bù nếu process chết trước khi kịp `raise()`.
 */
@Injectable()
export class RecruitmentHrAlertService {
  private readonly logger = new Logger('RecruitmentHrAlert');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
  ) {}

  async raise(alert: HrAlertDraft, em?: EntityManager): Promise<boolean> {
    const rows: unknown[] = await (em ?? this.dataSource).query(
      `INSERT INTO "recruitment_hr_alerts"
         (type, severity, source_key, candidate_id, application_id, conversation_id,
          handoff_id, outbox_id, event_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT ON CONSTRAINT "UQ_recruitment_hr_alerts_source" DO NOTHING
       RETURNING id`,
      [
        alert.type,
        alert.severity,
        alert.sourceKey,
        alert.candidateId ?? null,
        alert.applicationId ?? null,
        alert.conversationId ?? null,
        alert.handoffId ?? null,
        alert.outboxId ?? null,
        alert.eventId ?? null,
        JSON.stringify(alert.details ?? {}),
      ],
    );
    return rows.length > 0;
  }

  /** Quét nguồn sự cố → cảnh báo còn thiếu. Trả số cảnh báo mới tạo. */
  async sweep(): Promise<number> {
    const statements = [
      // Handoff đang mở — ứng viên đòi gặp người thật hay AI/chính sách chuyển HR.
      `INSERT INTO "recruitment_hr_alerts"
         (type, severity, source_key, candidate_id, application_id, conversation_id, handoff_id, details)
       SELECT CASE WHEN h.reason = 'CANDIDATE_REQUESTED_HUMAN'
                   THEN 'CANDIDATE_REQUESTED_HUMAN' ELSE 'AI_POLICY_HANDOFF' END::"recruitment_hr_alerts_type_enum",
              CASE WHEN h.priority IN ('HIGH', 'URGENT') OR h.reason IN ('CANDIDATE_REQUESTED_HUMAN', 'COMPLAINT')
                   THEN 'HIGH' ELSE 'MEDIUM' END::"recruitment_hr_alerts_severity_enum",
              'handoff:' || h.id, h.candidate_id, h.application_id,
              (SELECT c.id FROM "recruitment_conversations" c WHERE c.candidate_id = h.candidate_id
               ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT 1),
              h.id,
              jsonb_build_object('reason', h.reason, 'priority', h.priority)
       FROM "recruitment_handoffs" h
       WHERE h.status = 'OPEN' AND h.created_at > now() - ${SWEEP_WINDOW}
       ON CONFLICT ON CONSTRAINT "UQ_recruitment_hr_alerts_source" DO NOTHING
       RETURNING id`,
      // Tin đi có thể đã tới Zalo nhưng không rõ — chờ đối soát.
      `INSERT INTO "recruitment_hr_alerts" (type, severity, source_key, outbox_id, details)
       SELECT 'OUTBOUND_UNKNOWN', 'HIGH', 'outbox:' || o.id, o.id,
              jsonb_build_object('code', o.last_error_code, 'sourceType', o.source_type)
       FROM "recruitment_channel_outbox" o
       WHERE o.status = 'UNKNOWN' AND o.created_at > now() - ${SWEEP_WINDOW}
       ON CONFLICT ON CONSTRAINT "UQ_recruitment_hr_alerts_source" DO NOTHING
       RETURNING id`,
      // Tin đi không gửi được (trừ dòng HR tự đánh dead-letter khi đối soát).
      `INSERT INTO "recruitment_hr_alerts" (type, severity, source_key, outbox_id, details)
       SELECT 'OUTBOUND_DEAD_LETTER', 'HIGH', 'outbox:' || o.id, o.id,
              jsonb_build_object('code', o.last_error_code, 'sourceType', o.source_type)
       FROM "recruitment_channel_outbox" o
       WHERE o.status = 'DEAD_LETTER' AND o.resolution IS NULL
         AND o.created_at > now() - ${SWEEP_WINDOW}
       ON CONFLICT ON CONSTRAINT "UQ_recruitment_hr_alerts_source" DO NOTHING
       RETURNING id`,
      // Tin ứng viên không xử lý được (lỗi cuối hoặc quá hạn giữ).
      `INSERT INTO "recruitment_hr_alerts" (type, severity, source_key, conversation_id, event_id, details)
       SELECT 'CHANNEL_EVENT_DEAD_LETTER', 'HIGH', 'event:' || e.id, e.conversation_id, e.id,
              jsonb_build_object('code', e.failure_code)
       FROM "recruitment_channel_events" e
       WHERE e.status = 'FAILED' AND e.next_attempt_at IS NULL AND e.failure_code IS NOT NULL
         AND e.received_at > now() - ${SWEEP_WINDOW}
       ON CONFLICT ON CONSTRAINT "UQ_recruitment_hr_alerts_source" DO NOTHING
       RETURNING id`,
      // AI/OpenClaw hỏng lặp lại (tin vẫn đang thử lại) — gộp một cảnh báo / OA / giờ.
      `INSERT INTO "recruitment_hr_alerts" (type, severity, source_key, details)
       SELECT 'REPEATED_AI_FAILURE', 'HIGH',
              'ai:' || e.channel_account_id || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24'),
              jsonb_build_object('oaId', e.channel_account_id, 'code', max(e.last_error_code), 'events', count(*))
       FROM "recruitment_channel_events" e
       WHERE e.status = 'FAILED' AND e.next_attempt_at IS NOT NULL
         AND e.attempt_count >= ${REPEATED_FAILURE_ATTEMPTS}
       GROUP BY e.channel_account_id
       ON CONFLICT ON CONSTRAINT "UQ_recruitment_hr_alerts_source" DO NOTHING
       RETURNING id`,
    ];
    let created = 0;
    for (const sql of statements) {
      const rows: unknown[] = await this.dataSource.query(sql);
      created += rows.length;
    }
    if (created) this.logger.warn(`hr-alert sweep: ${created} cảnh báo mới`);
    return created;
  }

  async list(query: {
    status?: HrAlertStatus;
    type?: HrAlertType;
    limit?: number;
  }) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.status) {
      params.push(query.status);
      where.push(`status = $${params.length}`);
    }
    if (query.type) {
      params.push(query.type);
      where.push(`type = $${params.length}`);
    }
    params.push(Math.min(Math.max(query.limit ?? 50, 1), 200));
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT id, type, severity, status, source_key AS "sourceKey", candidate_id AS "candidateId",
              application_id AS "applicationId", conversation_id AS "conversationId",
              handoff_id AS "handoffId", outbox_id AS "outboxId", event_id AS "eventId", details,
              created_at AS "createdAt", acknowledged_at AS "acknowledgedAt",
              acknowledged_by AS "acknowledgedBy", acknowledged_by_name AS "acknowledgedByName"
       FROM "recruitment_hr_alerts"
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  /**
   * Xác nhận đã xem. Idempotent: gọi lại trả nguyên người + thời điểm xác nhận
   * lần đầu, không ghi đè.
   */
  async acknowledge(id: number, actor: RecruitmentActor, em?: EntityManager) {
    const runner = em ?? this.dataSource;
    const updated = returnedRows<Record<string, unknown>>(
      await runner.query(
        `UPDATE "recruitment_hr_alerts"
         SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $2,
             acknowledged_by_name = $3, updated_at = now()
         WHERE id = $1 AND status = 'OPEN'
         RETURNING id, status, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy"`,
        [id, actor.employeeId, actor.name],
      ),
    );
    if (updated[0]) {
      await this.audit.record({
        actor,
        action: 'HR_ALERT_ACKNOWLEDGE',
        entity: 'hr-alerts',
        entityId: id,
        context: { alertId: id },
      });
      return { ...updated[0], idempotent: false };
    }
    const [current]: Array<Record<string, unknown>> = await runner.query(
      `SELECT id, status, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy"
       FROM "recruitment_hr_alerts" WHERE id = $1`,
      [id],
    );
    if (!current) {
      throw new NotFoundException({
        code: 'ALERT_NOT_FOUND',
        message: `Không có cảnh báo #${id}`,
      });
    }
    if (current.status !== HrAlertStatus.ACKNOWLEDGED) {
      throw new ConflictException({
        code: 'ALERT_NOT_OPEN',
        message: 'Cảnh báo không ở trạng thái mở',
      });
    }
    return { ...current, idempotent: true };
  }

  /** Đóng cảnh báo gắn với một nguồn khi nguồn đã được xử lý (vd. đối soát outbox). */
  async acknowledgeSource(
    type: HrAlertType,
    sourceKey: string,
    actor: RecruitmentActor,
    em: EntityManager,
  ) {
    await em.query(
      `UPDATE "recruitment_hr_alerts"
       SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $3,
           acknowledged_by_name = $4, updated_at = now()
       WHERE type = $1 AND source_key = $2 AND status = 'OPEN'`,
      [type, sourceKey, actor.employeeId, actor.name],
    );
  }
}
