import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  ChannelOutboxStatus,
  HrAlertType,
  OutboxResolution,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { returnedRows } from './recruitment-channel-event.queue';
import { RecruitmentHrAlertService } from './recruitment-hr-alert.service';
import { readOutboundSafetyConfig } from './recruitment-outbound-safety.config';

interface OutboxRow {
  id: number;
  status: ChannelOutboxStatus;
  resolution: OutboxResolution | null;
  resolved_by: number | null;
  last_error_code: string | null;
}

const RESULT_STATUS: Record<OutboxResolution, ChannelOutboxStatus> = {
  [OutboxResolution.MARK_SENT]: ChannelOutboxStatus.SENT,
  [OutboxResolution.RETRY]: ChannelOutboxStatus.PENDING,
  [OutboxResolution.DEAD_LETTER]: ChannelOutboxStatus.DEAD_LETTER,
};

const AUDIT_ACTION = {
  [OutboxResolution.MARK_SENT]: 'OUTBOX_MARK_SENT',
  [OutboxResolution.RETRY]: 'OUTBOX_RETRY',
  [OutboxResolution.DEAD_LETTER]: 'OUTBOX_DEAD_LETTER',
} as const;

/**
 * Đối soát dòng outbox `UNKNOWN` (tin có thể đã tới Zalo nhưng không chắc) — chỉ
 * bằng thao tác TƯỜNG MINH của người vận hành, không bao giờ tự động:
 *
 * - `MARK_SENT`: người vận hành xác nhận Zalo đã nhận → SENT, xoá bản sao nội dung.
 *   Không mở kết nối nào.
 * - `RETRY`: gửi lại — có thể trùng tin nên bắt buộc `confirmDuplicateRisk`; nội
 *   dung lấy lại từ tin canonical, dòng giữ nguyên vị trí đầu hàng của người nhận.
 * - `DEAD_LETTER`: không gửi nữa; tin canonical giữ nguyên.
 *
 * SENT/DEAD_LETTER mở khoá hàng đợi của người nhận (dòng sau thành đầu hàng).
 * Chỉ chạy từ `UNKNOWN` (`UPDATE ... WHERE status = 'UNKNOWN'` — hai người bấm
 * cùng lúc chỉ một người thắng); bấm lại cùng thao tác → idempotent, không gửi thêm.
 */
@Injectable()
export class RecruitmentOutboxOperationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
    private readonly alerts: RecruitmentHrAlertService,
    private readonly config?: ConfigService,
  ) {}

  /** Request/cost ledger production, không trả user id, nội dung hay token. */
  async usage() {
    const read = this.config
      ? readOutboundSafetyConfig((key) => this.config!.get<string>(key))
      : null;
    const limits = read && 'config' in read ? read.config : null;
    const [row]: Array<{
      day_requests: number | string;
      month_requests: number | string;
      day_estimated_cost: number | string;
      month_estimated_cost: number | string;
      dispatching: number | string;
      sent: number | string;
      retry: number | string;
      unknown: number | string;
      rejected: number | string;
      dead_letter: number | string;
    }> = await this.dataSource.query(
      `WITH bounds AS (
         SELECT
           date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS day_start,
           date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS month_start
       ) SELECT
         count(*) FILTER (WHERE a.started_at >= b.day_start) AS day_requests,
         count(*) FILTER (WHERE a.started_at >= b.month_start) AS month_requests,
         coalesce(sum(a.estimated_cost_vnd) FILTER (WHERE a.started_at >= b.day_start), 0) AS day_estimated_cost,
         coalesce(sum(a.estimated_cost_vnd) FILTER (WHERE a.started_at >= b.month_start), 0) AS month_estimated_cost,
         count(*) FILTER (WHERE a.outcome = 'DISPATCHING') AS dispatching,
         count(*) FILTER (WHERE a.outcome = 'SENT') AS sent,
         count(*) FILTER (WHERE a.outcome = 'RETRY') AS retry,
         count(*) FILTER (WHERE a.outcome = 'UNKNOWN') AS unknown,
         count(*) FILTER (WHERE a.outcome = 'REJECTED') AS rejected,
         count(*) FILTER (WHERE a.outcome = 'DEAD_LETTER') AS dead_letter
       FROM "recruitment_outbound_attempts" a CROSS JOIN bounds b
       WHERE a.started_at >= b.month_start OR a.outcome = 'DISPATCHING'`,
    );
    return {
      productionMode: limits?.productionMode ?? false,
      today: {
        requests: Number(row?.day_requests ?? 0),
        estimatedCostVnd: Number(row?.day_estimated_cost ?? 0),
      },
      month: {
        requests: Number(row?.month_requests ?? 0),
        estimatedCostVnd: Number(row?.month_estimated_cost ?? 0),
      },
      outcomes: {
        dispatching: Number(row?.dispatching ?? 0),
        sent: Number(row?.sent ?? 0),
        retry: Number(row?.retry ?? 0),
        unknown: Number(row?.unknown ?? 0),
        rejected: Number(row?.rejected ?? 0),
        deadLetter: Number(row?.dead_letter ?? 0),
      },
      limits: limits
        ? {
            maxRequestsPerRecipientDay: limits.maxRequestsPerRecipientDay,
            maxRequestsPerDay: limits.maxRequestsPerDay,
            dailyCostBudgetVnd: limits.dailyCostBudgetVnd,
            monthlyCostBudgetVnd: limits.monthlyCostBudgetVnd,
            interactionWindowHours: limits.interactionWindowHours,
            freeWindowHours: limits.freeWindowHours,
          }
        : null,
    };
  }

  async list(query: { status?: ChannelOutboxStatus; limit?: number }) {
    const status = query.status ?? ChannelOutboxStatus.UNKNOWN;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT o.id, o.status, o.source_type AS "sourceType", o.channel_account_id AS "oaId",
              o.external_recipient_id AS "recipientId", o.recruitment_message_id AS "messageId",
              m.conversation_id AS "conversationId", left(m.content, 200) AS "messagePreview",
              o.attempt_count AS "attemptCount", o.last_error_code AS "lastErrorCode",
              o.dispatched_at AS "dispatchedAt", o.created_at AS "createdAt",
              o.resolution, o.resolved_by AS "resolvedBy", o.resolved_at AS "resolvedAt",
              coalesce(attempts.n, 0)::int AS "requestCount",
              attempts.last_outcome AS "lastRequestOutcome",
              coalesce(attempts.cost, 0)::int AS "estimatedCostVnd"
       FROM "recruitment_channel_outbox" o
       LEFT JOIN "recruitment_messages" m ON m.id = o.recruitment_message_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n,
                (array_agg(a.outcome ORDER BY a.id DESC))[1] AS last_outcome,
                sum(a.estimated_cost_vnd) AS cost
         FROM "recruitment_outbound_attempts" a WHERE a.outbox_id = o.id
       ) attempts ON true
       WHERE o.status = $1
       ORDER BY o.created_at, o.id
       LIMIT $2`,
      [status, limit],
    );
    return rows;
  }

  async markSent(
    id: number,
    dto: { providerMessageId?: string },
    actor: RecruitmentActor,
  ) {
    return this.resolve(id, OutboxResolution.MARK_SENT, actor, {
      sql: `UPDATE "recruitment_channel_outbox"
            SET status = 'SENT', sent_at = now(), provider_message_id = coalesce($3::varchar, provider_message_id),
                message_text = NULL, text_redacted_at = now(), lease_until = NULL,
                next_attempt_at = NULL, resolution = 'MARK_SENT', resolved_by = $2,
                resolved_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'UNKNOWN'
            RETURNING id, last_error_code`,
      params: [dto.providerMessageId ?? null],
    });
  }

  async retry(
    id: number,
    dto: { confirmDuplicateRisk?: boolean },
    actor: RecruitmentActor,
  ) {
    if (dto.confirmDuplicateRisk !== true) {
      throw new BadRequestException({
        code: 'CONFIRMATION_REQUIRED',
        message:
          'Tin có thể đã tới Zalo — gửi lại có thể trùng. Gửi kèm confirmDuplicateRisk: true để xác nhận.',
      });
    }
    // Nội dung lấy lại từ tin canonical (bản sao trong outbox có thể đã bị xoá do quá hạn).
    return this.resolve(id, OutboxResolution.RETRY, actor, {
      sql: `UPDATE "recruitment_channel_outbox" o
            SET status = 'PENDING', message_text = m.content, text_redacted_at = NULL,
                dispatched_at = NULL, lease_until = NULL, next_attempt_at = NULL,
                resolution = 'RETRY', resolved_by = $2, resolved_at = now(), updated_at = now()
            FROM "recruitment_messages" m
            WHERE o.id = $1 AND o.status = 'UNKNOWN' AND m.id = o.recruitment_message_id
            RETURNING o.id, o.last_error_code`,
      params: [],
    });
  }

  async deadLetter(id: number, actor: RecruitmentActor) {
    return this.resolve(id, OutboxResolution.DEAD_LETTER, actor, {
      sql: `UPDATE "recruitment_channel_outbox"
            SET status = 'DEAD_LETTER', lease_until = NULL, next_attempt_at = NULL,
                resolution = 'DEAD_LETTER', resolved_by = $2, resolved_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'UNKNOWN'
            RETURNING id, last_error_code`,
      params: [],
    });
  }

  private async resolve(
    id: number,
    resolution: OutboxResolution,
    actor: RecruitmentActor,
    update: { sql: string; params: unknown[] },
  ) {
    const outcome = await this.dataSource.transaction(async (em) => {
      const rows = returnedRows<{ id: number; last_error_code: string | null }>(
        await em.query(update.sql, [id, actor.employeeId, ...update.params]),
      );
      if (rows[0]) {
        // Nguồn cảnh báo đã được xử lý → đóng cảnh báo bởi chính người này.
        await this.alerts.acknowledgeSource(
          HrAlertType.OUTBOUND_UNKNOWN,
          `outbox:${id}`,
          actor,
          em,
        );
        return { changed: true, previousCode: rows[0].last_error_code };
      }
      const [current]: OutboxRow[] = await em.query(
        `SELECT id, status, resolution, resolved_by, last_error_code
         FROM "recruitment_channel_outbox" WHERE id = $1`,
        [id],
      );
      if (!current) {
        throw new NotFoundException({
          code: 'OUTBOX_NOT_FOUND',
          message: `Không có dòng outbox #${id}`,
        });
      }
      if (current.resolution === resolution) {
        return { changed: false, previousCode: current.last_error_code };
      }
      if (current.status === ChannelOutboxStatus.UNKNOWN) {
        // UNKNOWN nhưng UPDATE không áp được (RETRY khi tin canonical đã mất).
        throw new ConflictException({
          code: 'CANONICAL_MESSAGE_MISSING',
          message:
            'Tin canonical không còn — không gửi lại được, hãy dead-letter',
        });
      }
      throw new ConflictException({
        code: 'OUTBOX_NOT_UNKNOWN',
        message: `Dòng outbox đang ${current.status}, chỉ đối soát được dòng UNKNOWN`,
        status: current.status,
      });
    });

    if (outcome.changed) {
      await this.audit.record({
        actor,
        action: AUDIT_ACTION[resolution],
        entity: 'channel-outbox',
        entityId: id,
        context: {
          outboxId: id,
          resolution,
          from: ChannelOutboxStatus.UNKNOWN,
          to: RESULT_STATUS[resolution],
          previousCode: outcome.previousCode,
        },
      });
    }
    const [row]: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT id, status, resolution, resolved_by AS "resolvedBy", resolved_at AS "resolvedAt"
       FROM "recruitment_channel_outbox" WHERE id = $1`,
      [id],
    );
    return { ...row, idempotent: !outcome.changed };
  }
}
