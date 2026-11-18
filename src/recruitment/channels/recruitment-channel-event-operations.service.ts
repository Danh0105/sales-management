import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  ChannelEventExcludeReason,
  ChannelEventStatus,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';

/** Chỉ event chưa / không còn được worker xử lý mới loại được. */
const EXCLUDABLE: ReadonlySet<string> = new Set([
  ChannelEventStatus.RECEIVED,
  ChannelEventStatus.FAILED,
]);

interface EventRow {
  id: number;
  status: ChannelEventStatus;
  failure_code: string | null;
  has_text: boolean;
}

/**
 * Vận hành inbox kênh (P3-7.3 R1): loại một event khỏi xử lý nghiệp vụ bằng thao tác
 * TƯỜNG MINH của người vận hành — vd. tin thử nội bộ gửi lúc nghiệm thu webhook, trước khi
 * bật worker. Dòng event giữ nguyên (người gửi, msg id, payload hash, thời điểm, liên kết
 * cách ly) để audit; chỉ đổi sang `IGNORED` + `failure_code` = lý do và xoá nội dung tin
 * (CHECK: `IGNORED` không giữ nội dung). Worker chỉ claim RECEIVED / PROCESSING / FAILED còn
 * lịch thử → không bao giờ xử lý lại; Zalo gửi lại cùng tin → trùng `dedupe_key`, không tạo
 * event mới. Event đang PROCESSING / đã PROCESSED / đã IGNORED vì lý do khác → 409.
 */
@Injectable()
export class RecruitmentChannelEventOperationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
  ) {}

  async exclude(
    id: number,
    reason: ChannelEventExcludeReason,
    actor: RecruitmentActor,
  ) {
    const outcome = await this.dataSource.transaction(async (em) => {
      const [row]: EventRow[] = await em.query(
        `SELECT id, status, failure_code, normalized_message_text IS NOT NULL AS has_text
         FROM "recruitment_channel_events" WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) {
        throw new NotFoundException({
          code: 'CHANNEL_EVENT_NOT_FOUND',
          message: `Không có event #${id}`,
        });
      }
      if (
        row.status === ChannelEventStatus.IGNORED &&
        row.failure_code === reason
      ) {
        return { changed: false, from: row.status, hadText: false };
      }
      if (!EXCLUDABLE.has(row.status)) {
        throw new ConflictException({
          code:
            row.status === ChannelEventStatus.PROCESSING
              ? 'CHANNEL_EVENT_IN_PROGRESS'
              : 'CHANNEL_EVENT_NOT_EXCLUDABLE',
          message: `Event đang ${row.status}, chỉ loại được event RECEIVED / FAILED`,
          status: row.status,
        });
      }
      await em.query(
        `UPDATE "recruitment_channel_events"
         SET status = 'IGNORED', failure_code = $2, normalized_message_text = NULL,
             text_redacted_at = coalesce(text_redacted_at, now()), processed_at = now(),
             lease_until = NULL, lease_owner = NULL, next_attempt_at = NULL, updated_at = now()
         WHERE id = $1 AND status = $3::text::"recruitment_channel_events_status_enum"`,
        [id, reason, row.status],
      );
      await this.audit.recordMandatory(em, {
        actor,
        action: 'CHANNEL_EVENT_EXCLUDE',
        entity: 'channel-events',
        entityId: id,
        before: {
          status: row.status,
          failureCode: row.failure_code,
          hasText: row.has_text,
        },
        after: {
          status: ChannelEventStatus.IGNORED,
          failureCode: reason,
          hasText: false,
        },
        context: {
          eventId: id,
          reason,
          from: row.status,
          to: ChannelEventStatus.IGNORED,
          textRemoved: row.has_text,
        },
      });
      return { changed: true, from: row.status, hadText: row.has_text };
    });
    const [current]: Array<Record<string, unknown>> =
      await this.dataSource.query(
        `SELECT id, status, failure_code AS "failureCode", processed_at AS "processedAt",
              normalized_message_text IS NOT NULL AS "hasText"
       FROM "recruitment_channel_events" WHERE id = $1`,
        [id],
      );
    return { ...current, idempotent: !outcome.changed };
  }

  /** Số event theo trạng thái + lý do (không nội dung, không người gửi) và tin đang chờ. */
  async stats() {
    const rows: Array<{
      status: ChannelEventStatus;
      failureCode: string | null;
      count: number;
      oldest: Date | null;
    }> = await this.dataSource.query(
      `SELECT status, failure_code AS "failureCode", count(*)::int AS "count",
              min(received_at) AS "oldest"
       FROM "recruitment_channel_events" GROUP BY status, failure_code
       ORDER BY status, failure_code NULLS FIRST`,
    );
    const waiting = rows.filter(
      (r) => r.status === ChannelEventStatus.RECEIVED,
    );
    const oldest = waiting.reduce<Date | null>(
      (min, r) =>
        r.oldest && (!min || new Date(r.oldest) < new Date(min))
          ? r.oldest
          : min,
      null,
    );
    return {
      byStatus: rows,
      waiting: { count: waiting.reduce((sum, r) => sum + r.count, 0), oldest },
    };
  }
}
