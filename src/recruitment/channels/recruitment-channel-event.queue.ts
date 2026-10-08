import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { ChannelEventAiDecision } from '../recruitment.enums';

import { EVENT_TEXT_RETENTION_DAYS } from './recruitment-channel-worker.config';

/** Event đã được claim — đủ để xử lý một lượt, không hơn. */
export interface ClaimedChannelEvent {
  id: number;
  channelAccountId: string;
  externalSenderId: string;
  providerMessageId: string | null;
  messageText: string | null;
  attemptCount: number;
}

interface ClaimRow {
  id: number | string;
  channel_account_id: string;
  external_sender_id: string;
  provider_message_id: string | null;
  normalized_message_text: string | null;
  attempt_count: number | string;
}

export interface OutboxDraft {
  externalRecipientId: string;
  messageText: string;
  recruitmentMessageId: number | null;
}

/** Hội thoại + version điều khiển lúc bắt đầu lượt AI (fencing với HR). */
export interface ControlFence {
  conversationId: number;
  expectedVersion: number;
}

/**
 * Hàng đợi trên PostgreSQL (`recruitment_channel_events`) — không cần Redis.
 *
 * **Tuần tự theo người gửi** (`zalo:<OA>:<sender>`): chỉ event "đầu hàng" — event
 * sớm nhất (theo timestamp Zalo) chưa xong của người gửi đó — mới được claim, và không bao giờ khi người
 * đó còn một event `PROCESSING` với lease còn hạn. Hai worker cùng nhắm một người
 * gửi bị xếp hàng bằng advisory lock theo người gửi (giữ tới hết transaction
 * claim); `UPDATE ... WHERE` kiểm lại mọi điều kiện trên dữ liệu đã commit, nên
 * không có khe SELECT-rồi-UPDATE.
 *
 * Event mới chỉ được claim sau `settleMs` kể từ lúc nhận: webhook của các tin gửi
 * liền nhau có thể tới lệch thứ tự — chờ một nhịp để tin đến muộn kịp vào hàng
 * và được xếp theo timestamp của Zalo.
 *
 * "Chưa xong" = `RECEIVED`, `PROCESSING`, hoặc `FAILED` còn lịch thử lại
 * (`next_attempt_at`). `FAILED` không còn lịch thử là dead-letter — không chặn
 * các tin sau của người đó.
 *
 * Mọi cập nhật kết quả đều **fencing** theo `lease_owner`: worker đã mất lease
 * (chết rồi sống lại, chạy quá lâu) không ghi đè được kết quả của worker khác.
 */
@Injectable()
export class RecruitmentChannelEventQueue {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async claimNext(
    oaId: string,
    owner: string,
    leaseMs: number,
    settleMs = 0,
  ): Promise<ClaimedChannelEvent | null> {
    const heads: Array<{ id: number; sender: string }> =
      await this.dataSource.query(
        `SELECT head.id, head.external_sender_id AS sender FROM (
           SELECT DISTINCT ON (e.external_sender_id)
             e.id, e.external_sender_id, e.status, e.lease_until, e.next_attempt_at,
             e.received_at, coalesce(e.provider_created_at, e.received_at) AS ord
           FROM "recruitment_channel_events" e
           WHERE e.channel = 'ZALO' AND e.channel_account_id = $1
             AND e.event_type = 'user_send_text' AND e.external_sender_id IS NOT NULL
             AND (e.status IN ('RECEIVED', 'PROCESSING')
                  OR (e.status = 'FAILED' AND e.next_attempt_at IS NOT NULL))
           ORDER BY e.external_sender_id, coalesce(e.provider_created_at, e.received_at), e.id
         ) head
         WHERE (head.status = 'RECEIVED'
                AND head.received_at <= now() - $2::int * interval '1 millisecond')
            OR (head.status = 'FAILED' AND head.next_attempt_at <= now())
            OR (head.status = 'PROCESSING' AND head.lease_until < now())
         ORDER BY head.ord, head.id
         LIMIT 20`,
        [oaId, settleMs],
      );

    for (const head of heads) {
      const claimed = await this.tryClaim(oaId, head, owner, leaseMs, settleMs);
      if (claimed) return claimed;
    }
    return null;
  }

  private async tryClaim(
    oaId: string,
    head: { id: number; sender: string },
    owner: string,
    leaseMs: number,
    settleMs: number,
  ): Promise<ClaimedChannelEvent | null> {
    return this.dataSource.transaction(async (em) => {
      const [lock]: Array<{ locked: boolean }> = await em.query(
        `SELECT pg_try_advisory_xact_lock(hashtext('recruitment_channel_events'), hashtext($1)) AS locked`,
        [`ZALO:${oaId}:${head.sender}`],
      );
      if (!lock?.locked) return null;

      const rows = returnedRows<ClaimRow>(
        await em.query(
          `UPDATE "recruitment_channel_events" e
         SET status = 'PROCESSING', attempt_count = e.attempt_count + 1,
             processing_started_at = now(), lease_until = now() + $4::int * interval '1 millisecond',
             lease_owner = $5, next_attempt_at = NULL, updated_at = now()
         WHERE e.id = $1 AND e.channel = 'ZALO' AND e.channel_account_id = $2
           AND e.external_sender_id = $3 AND e.event_type = 'user_send_text'
           AND (e.status = 'RECEIVED'
                OR (e.status = 'FAILED' AND e.next_attempt_at <= now())
                OR (e.status = 'PROCESSING' AND e.lease_until < now()))
           AND (e.status <> 'RECEIVED'
                OR e.received_at <= now() - $6::int * interval '1 millisecond')
           AND NOT EXISTS (
             SELECT 1 FROM "recruitment_channel_events" o
             WHERE o.channel = e.channel AND o.channel_account_id = e.channel_account_id
               AND o.external_sender_id = e.external_sender_id
               AND o.event_type = 'user_send_text' AND o.id <> e.id
               AND ((o.status = 'PROCESSING' AND o.lease_until >= now())
                    OR ((o.status IN ('RECEIVED', 'PROCESSING')
                         OR (o.status = 'FAILED' AND o.next_attempt_at IS NOT NULL))
                        AND (coalesce(o.provider_created_at, o.received_at), o.id)
                          < (coalesce(e.provider_created_at, e.received_at), e.id))))
         RETURNING e.id, e.channel_account_id, e.external_sender_id, e.provider_message_id,
                   e.normalized_message_text, e.attempt_count`,
          [head.id, oaId, head.sender, leaseMs, owner, settleMs],
        ),
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        channelAccountId: row.channel_account_id,
        externalSenderId: row.external_sender_id,
        providerMessageId: row.provider_message_id,
        messageText: row.normalized_message_text,
        attemptCount: Number(row.attempt_count),
      };
    });
  }

  /** Gia hạn lease khi lượt còn chạy. `false` = đã mất lease → phải dừng, không ghi kết quả. */
  async heartbeat(id: number, owner: string, leaseMs: number) {
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE "recruitment_channel_events"
       SET lease_until = now() + $3::int * interval '1 millisecond', updated_at = now()
       WHERE id = $1 AND status = 'PROCESSING' AND lease_owner = $2
       RETURNING id`,
        [id, owner, leaseMs],
      ),
    );
    return rows.length > 0;
  }

  /**
   * Xong một event trong **một transaction**: đánh dấu `PROCESSED` + xoá nội dung
   * tin (fencing theo lease), rồi đối chiếu điều khiển hội thoại:
   * - version vẫn như lúc bắt đầu lượt và còn `AI_ACTIVE` → ghi outbox
   *   (`ON CONFLICT DO NOTHING`), xoá cờ nhắc làm mới context;
   * - HR đã đổi chế độ trong lúc OpenClaw chạy → BỎ câu trả lời AI: không outbox,
   *   tin AI trong hội thoại được đánh dấu không gửi.
   * Khoá chia sẻ dòng hội thoại (`FOR SHARE`) nên không xen được với thao tác HR
   * (`FOR UPDATE`): hoặc ghi outbox trước khi HR tiếp quản, hoặc bị bỏ.
   * Mất lease → rollback, không ghi gì.
   */
  async complete(
    event: ClaimedChannelEvent,
    owner: string,
    outbox: OutboxDraft,
    fence: ControlFence,
  ): Promise<{
    completed: boolean;
    outboxId: number | null;
    discarded: boolean;
  }> {
    return this.dataSource.transaction(async (em) => {
      if (!(await this.markProcessed(em, event, owner, fence.conversationId))) {
        return { completed: false, outboxId: null, discarded: false };
      }
      const [control]: Array<{
        control_mode: string;
        control_version: number;
      }> = await em.query(
        `SELECT control_mode, control_version FROM "recruitment_conversations"
           WHERE id = $1 FOR SHARE`,
        [fence.conversationId],
      );
      if (
        !control ||
        control.control_mode !== 'AI_ACTIVE' ||
        Number(control.control_version) !== fence.expectedVersion
      ) {
        await this.setDecision(
          em,
          event.id,
          ChannelEventAiDecision.DISCARDED_CONTROL_CHANGED,
        );
        if (outbox.recruitmentMessageId) {
          await em.query(
            `UPDATE "recruitment_messages"
             SET metadata = metadata || '{"delivery": "DISCARDED_CONTROL_CHANGED"}'::jsonb
             WHERE id = $1`,
            [outbox.recruitmentMessageId],
          );
        }
        return { completed: true, outboxId: null, discarded: true };
      }

      const inserted: Array<{ id: number }> = await em.query(
        `INSERT INTO "recruitment_channel_outbox"
           ("source_event_id", "source_type", "channel", "channel_account_id",
            "external_recipient_id", "message_text", "recruitment_message_id", "control_version")
         VALUES ($1, 'AI_REPLY', 'ZALO', $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          event.id,
          event.channelAccountId,
          outbox.externalRecipientId,
          outbox.messageText,
          outbox.recruitmentMessageId,
          fence.expectedVersion,
        ],
      );
      await this.setDecision(em, event.id, ChannelEventAiDecision.AI_REPLIED);
      await em.query(
        `UPDATE "recruitment_conversations" SET resume_signal_pending = false
         WHERE id = $1 AND control_version = $2 AND resume_signal_pending`,
        [fence.conversationId, fence.expectedVersion],
      );
      return {
        completed: true,
        outboxId: inserted[0]?.id ?? null,
        discarded: false,
      };
    });
  }

  /**
   * Hội thoại không ở `AI_ACTIVE` (AI tạm dừng / HR tiếp quản / đóng): tin đến đã
   * vào hội thoại canonical, KHÔNG gọi OpenClaw — đánh dấu `PROCESSED` với lý do
   * và chạy `alsoInTx` (vd. cảnh báo HR) trong cùng transaction.
   */
  async completeWithoutAi(
    event: ClaimedChannelEvent,
    owner: string,
    conversationId: number,
    decision: ChannelEventAiDecision,
    alsoInTx?: (em: EntityManager) => Promise<unknown>,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (em) => {
      if (!(await this.markProcessed(em, event, owner, conversationId)))
        return false;
      await this.setDecision(em, event.id, decision);
      if (alsoInTx) await alsoInTx(em);
      return true;
    });
  }

  private async markProcessed(
    em: EntityManager,
    event: ClaimedChannelEvent,
    owner: string,
    conversationId: number,
  ): Promise<boolean> {
    const done = returnedRows(
      await em.query(
        `UPDATE "recruitment_channel_events"
         SET status = 'PROCESSED', processed_at = now(), normalized_message_text = NULL,
             text_redacted_at = now(), lease_until = NULL, next_attempt_at = NULL,
             last_error_code = NULL, failure_code = NULL, conversation_id = $3, updated_at = now()
         WHERE id = $1 AND status = 'PROCESSING' AND lease_owner = $2
         RETURNING id`,
        [event.id, owner, conversationId],
      ),
    );
    return done.length > 0;
  }

  private async setDecision(
    em: EntityManager,
    eventId: number,
    decision: ChannelEventAiDecision,
  ) {
    await em.query(
      `UPDATE "recruitment_channel_events" SET ai_decision = $2 WHERE id = $1`,
      [eventId, decision],
    );
  }

  /**
   * Ghi lỗi. `retryInMs` = thử lại sau ngần ấy (giữ nội dung tin); `null` = lỗi
   * cuối (dead-letter): vẫn giữ nội dung để HR/dev xem, tối đa 7 ngày.
   */
  async fail(
    event: ClaimedChannelEvent,
    owner: string,
    code: string,
    retryInMs: number | null,
  ): Promise<boolean> {
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE "recruitment_channel_events"
       SET status = 'FAILED', last_error_code = $3::varchar, lease_until = NULL,
           next_attempt_at = CASE WHEN $4::int IS NULL THEN NULL
                                  ELSE now() + $4::int * interval '1 millisecond' END,
           failure_code = CASE WHEN $4::int IS NULL THEN $3::varchar ELSE NULL END,
           updated_at = now()
       WHERE id = $1 AND status = 'PROCESSING' AND lease_owner = $2
       RETURNING id`,
        [event.id, owner, code, retryInMs],
      ),
    );
    return rows.length > 0;
  }

  /**
   * Hết hạn giữ nội dung (7 ngày từ lúc nhận): xoá text, chuyển dead-letter. Bỏ
   * qua event đang được xử lý (lease còn hạn). Trả các event vừa bị xoá nội dung.
   */
  async expireRetention(): Promise<
    Array<{ id: number; channelAccountId: string; failureCode: string }>
  > {
    const rows = returnedRows<{
      id: number | string;
      channel_account_id: string;
      failure_code: string;
    }>(
      await this.dataSource.query(
        `UPDATE "recruitment_channel_events"
       SET normalized_message_text = NULL, text_redacted_at = now(), status = 'FAILED',
           next_attempt_at = NULL, lease_until = NULL,
           failure_code = coalesce(failure_code, 'RETENTION_EXPIRED'),
           last_error_code = coalesce(last_error_code, 'RETENTION_EXPIRED'),
           updated_at = now()
       WHERE normalized_message_text IS NOT NULL
         AND received_at < now() - interval '${EVENT_TEXT_RETENTION_DAYS} days'
         AND NOT (status = 'PROCESSING' AND lease_until >= now())
       RETURNING id, channel_account_id, failure_code`,
      ),
    );
    return rows.map((row) => ({
      id: Number(row.id),
      channelAccountId: row.channel_account_id,
      failureCode: row.failure_code,
    }));
  }
}

/** TypeORM (postgres) trả `[rows, rowCount]` cho UPDATE/DELETE, `rows` cho câu khác. */
export function returnedRows<T = unknown>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return (result ?? []) as T[];
}
