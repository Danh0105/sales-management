import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { pilotFingerprint } from './recruitment-ai-safety.config';
import { returnedRows } from './recruitment-channel-event.queue';
import { OUTBOX_TEXT_RETENTION_DAYS } from './zalo-outbound.config';

export interface ClaimedOutbox {
  id: number;
  channelAccountId: string;
  externalRecipientId: string;
  messageText: string | null;
  recruitmentMessageId: number | null;
  attemptCount: number;
  /** AI_REPLY (tin AI) hay HR_MESSAGE (tin HR viết tay). */
  sourceType: string;
  /** Version điều khiển hội thoại lúc tin AI được xếp hàng (`NULL` với tin HR). */
  controlVersion: number | null;
}

/** Kết quả cửa kiểm cuối trước khi mở kết nối. */
export type DispatchGate =
  | { outcome: 'DISPATCHED' }
  /** Tin AI bị chặn vì HR đã đổi điều khiển hội thoại — không mở kết nối. */
  | {
      outcome: 'SUPPRESSED';
      code: string;
      conversationId: number;
      mode: string;
      version: number;
    }
  /** Tin canonical / hội thoại không còn — không gửi. */
  | { outcome: 'INVALID'; code: string }
  /** Mất lease (sender khác đã lấy dòng) — không ghi gì. */
  | { outcome: 'LOST' }
  /** Outbound đang dừng khẩn (hoặc không đọc được trạng thái) — trả về chờ, không mở kết nối. */
  | { outcome: 'HELD' };

interface ClaimRow {
  id: number | string;
  channel_account_id: string;
  external_recipient_id: string;
  message_text: string | null;
  recruitment_message_id: number | string | null;
  attempt_count: number | string;
  source_type: string;
  control_version: number | string | null;
}

/** Dòng chưa xong (chặn các tin sau của cùng người nhận). SENT/DEAD_LETTER/SUPPRESSED là kết thúc. */
const UNFINISHED = `(o.status IN ('PENDING', 'SENDING', 'RETRY', 'UNKNOWN'))`;

/**
 * Hàng đợi gửi trên `recruitment_channel_outbox` (PostgreSQL, không Redis) — cùng
 * khuôn với inbox:
 *
 * - **Theo thứ tự người nhận** `zalo:<OA>:<người nhận>`: chỉ dòng "đầu hàng" (sớm
 *   nhất chưa xong theo `created_at, id`) được claim. Dòng `RETRY` đang chờ hay
 *   `UNKNOWN` chờ đối soát vẫn là đầu hàng → tin sau KHÔNG vượt lên.
 * - Advisory lock theo người nhận + `UPDATE ... WHERE` kiểm lại → hai sender không
 *   cùng gửi một dòng, không cùng gửi hai tin của một người nhận.
 * - Fencing theo `lease_owner` cho mọi cập nhật kết quả.
 * - `dispatched_at` ghi bền trước khi mở kết nối: lease hết hạn khi chưa dispatch →
 *   claim lại an toàn; đã dispatch → `UNKNOWN` (không gửi lại mù).
 */
@Injectable()
export class RecruitmentChannelOutboxQueue {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async claimNext(
    oaId: string,
    owner: string,
    leaseMs: number,
  ): Promise<ClaimedOutbox | null> {
    const heads: Array<{ id: number; recipient: string }> =
      await this.dataSource.query(
        `SELECT head.id, head.external_recipient_id AS recipient FROM (
           SELECT DISTINCT ON (o.external_recipient_id)
             o.id, o.external_recipient_id, o.status, o.lease_until, o.next_attempt_at,
             o.dispatched_at, o.created_at
           FROM "recruitment_channel_outbox" o
           WHERE o.channel = 'ZALO' AND o.channel_account_id = $1 AND ${UNFINISHED}
           ORDER BY o.external_recipient_id, o.created_at, o.id
         ) head
         WHERE head.status = 'PENDING'
            OR (head.status = 'RETRY' AND head.next_attempt_at <= now())
            OR (head.status = 'SENDING' AND head.lease_until < now() AND head.dispatched_at IS NULL)
         ORDER BY head.created_at, head.id
         LIMIT 20`,
        [oaId],
      );
    for (const head of heads) {
      const claimed = await this.tryClaim(oaId, head, owner, leaseMs);
      if (claimed) return claimed;
    }
    return null;
  }

  private async tryClaim(
    oaId: string,
    head: { id: number; recipient: string },
    owner: string,
    leaseMs: number,
  ): Promise<ClaimedOutbox | null> {
    return this.dataSource.transaction(async (em) => {
      const [lock]: Array<{ locked: boolean }> = await em.query(
        `SELECT pg_try_advisory_xact_lock(hashtext('recruitment_channel_outbox'), hashtext($1)) AS locked`,
        [`ZALO:${oaId}:${head.recipient}`],
      );
      if (!lock?.locked) return null;

      const rows = returnedRows<ClaimRow>(
        await em.query(
          `UPDATE "recruitment_channel_outbox" t
           SET status = 'SENDING', attempt_count = t.attempt_count + 1,
               sending_started_at = now(), lease_until = now() + $4::int * interval '1 millisecond',
               lease_owner = $5, next_attempt_at = NULL, dispatched_at = NULL, updated_at = now()
           WHERE t.id = $1 AND t.channel = 'ZALO' AND t.channel_account_id = $2
             AND t.external_recipient_id = $3
             AND (t.status = 'PENDING'
                  OR (t.status = 'RETRY' AND t.next_attempt_at <= now())
                  OR (t.status = 'SENDING' AND t.lease_until < now() AND t.dispatched_at IS NULL))
             AND NOT EXISTS (
               SELECT 1 FROM "recruitment_channel_outbox" o
               WHERE o.channel = t.channel AND o.channel_account_id = t.channel_account_id
                 AND o.external_recipient_id = t.external_recipient_id AND o.id <> t.id
                 AND ((o.status = 'SENDING' AND o.lease_until >= now())
                      OR (${UNFINISHED} AND (o.created_at, o.id) < (t.created_at, t.id))))
           RETURNING t.id, t.channel_account_id, t.external_recipient_id, t.message_text,
                     t.recruitment_message_id, t.attempt_count, t.source_type, t.control_version`,
          [head.id, oaId, head.recipient, leaseMs, owner],
        ),
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        channelAccountId: row.channel_account_id,
        externalRecipientId: row.external_recipient_id,
        messageText: row.message_text,
        recruitmentMessageId:
          row.recruitment_message_id === null
            ? null
            : Number(row.recruitment_message_id),
        attemptCount: Number(row.attempt_count),
        sourceType: row.source_type,
        controlVersion:
          row.control_version === null ? null : Number(row.control_version),
      };
    });
  }

  /**
   * Cửa kiểm cuối, NGAY TRƯỚC khi mở kết nối tới Zalo (P3-6.5). Một transaction:
   * khoá chia sẻ dòng hội thoại (`FOR SHARE` — thao tác HR giữ `FOR UPDATE` nên không
   * xen giữa được), rồi:
   * - tin AI mà hội thoại không còn `AI_ACTIVE`, hoặc `control_version` khác lúc xếp
   *   hàng → `SUPPRESSED`: xoá bản sao, tin canonical đánh dấu không gửi, không mở
   *   kết nối;
   * - còn lại (tin HR luôn được gửi) → ghi bền `dispatched_at`.
   *
   * Chỉ thao tác tường minh của HR (đổi `control_mode`/version) mới chặn. `AI_PAUSED`
   * suy ra (handoff, hồ sơ chờ HR) KHÔNG chặn: pause đó có thể do chính lượt AI gây ra
   * và câu trả lời của lượt ("mình đã chuyển nhân sự") vẫn phải tới ứng viên.
   *
   * HR tiếp quản SAU khi transaction này commit → tin đã đi, không thu hồi được (thao
   * tác tiếp quản ghi lại các tin đó). `redispatch`: gửi lại ngay sau khi Zalo từ chối
   * token (lần trước chắc chắn chưa tới) — vẫn kiểm lại, vẫn chặn được.
   */
  async dispatch(
    row: ClaimedOutbox,
    owner: string,
    redispatch = false,
    pilotSenders: string[] | null = null,
  ): Promise<DispatchGate> {
    return this.dataSource.transaction(async (em) => {
      // Dừng khẩn outbound (P3-7.3 / G8): khoá chia sẻ dòng điều khiển — thao tác dừng
      // commit xong thì không dòng nào được ghi `dispatched_at` nữa. Không đọc được → giữ.
      const [runtime]: Array<{
        outbound_halted: boolean;
        failsafe_halted: boolean;
      }> = await em.query(
        `SELECT outbound_halted, failsafe_halted FROM "recruitment_runtime_controls" WHERE id = 1 FOR SHARE`,
      );
      if (
        runtime?.outbound_halted !== false ||
        runtime?.failsafe_halted !== false
      ) {
        const held = returnedRows(
          await em.query(
            `UPDATE "recruitment_channel_outbox"
             SET status = 'PENDING', attempt_count = greatest(attempt_count - 1, 0),
                 dispatched_at = NULL, lease_until = NULL, lease_owner = NULL, updated_at = now()
             WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2
               AND (dispatched_at IS NULL OR $3::boolean)
             RETURNING id`,
            [row.id, owner, redispatch],
          ),
        );
        return held.length ? { outcome: 'HELD' } : { outcome: 'LOST' };
      }

      const [control]: Array<{
        id: number;
        control_mode: string;
        control_version: number;
      }> = row.recruitmentMessageId
        ? await em.query(
            `SELECT c.id, c.control_mode, c.control_version
             FROM "recruitment_conversations" c
             JOIN "recruitment_messages" m ON m.conversation_id = c.id
             WHERE m.id = $1
             FOR SHARE OF c`,
            [row.recruitmentMessageId],
          )
        : [];
      if (!control) return { outcome: 'INVALID', code: 'CANONICAL_MISSING' };

      // Pilot: tin AI chỉ tới người nhận trong allowlist (tin HR viết tay luôn được gửi).
      const pilotBlocked =
        pilotSenders !== null &&
        row.sourceType === 'AI_REPLY' &&
        !pilotSenders.includes(
          pilotFingerprint(row.channelAccountId, row.externalRecipientId),
        );
      const code = pilotBlocked
        ? 'PILOT_RECIPIENT_BLOCKED'
        : row.sourceType === 'AI_REPLY'
          ? suppressionCode(control, row.controlVersion)
          : null;
      if (!code) {
        const dispatched = returnedRows(
          await em.query(
            `UPDATE "recruitment_channel_outbox" SET dispatched_at = now(), updated_at = now()
             WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id`,
            [row.id, owner],
          ),
        );
        return dispatched.length
          ? { outcome: 'DISPATCHED' }
          : { outcome: 'LOST' };
      }

      const suppressed = returnedRows(
        await em.query(
          `UPDATE "recruitment_channel_outbox"
           SET status = 'SUPPRESSED', last_error_code = $3::varchar, message_text = NULL,
               text_redacted_at = now(), lease_until = NULL, next_attempt_at = NULL,
               updated_at = now()
           WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2
             AND source_type = 'AI_REPLY' AND (dispatched_at IS NULL OR $4::boolean)
           RETURNING id`,
          [row.id, owner, code, redispatch],
        ),
      );
      if (!suppressed.length) return { outcome: 'LOST' };
      await em.query(
        `UPDATE "recruitment_messages"
         SET metadata = metadata || jsonb_build_object('delivery', $2::text)
         WHERE id = $1`,
        [
          row.recruitmentMessageId,
          pilotBlocked ? 'SUPPRESSED_PILOT' : 'SUPPRESSED_CONTROL_CHANGED',
        ],
      );
      return {
        outcome: 'SUPPRESSED',
        code,
        conversationId: Number(control.id),
        mode: control.control_mode,
        version: Number(control.control_version),
      };
    });
  }

  async heartbeat(id: number, owner: string, leaseMs: number) {
    return this.fenced(
      `UPDATE "recruitment_channel_outbox"
       SET lease_until = now() + $3::int * interval '1 millisecond', updated_at = now()
       WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id`,
      [id, owner, leaseMs],
    );
  }

  /** Đã gửi: lưu id tin phía Zalo và XOÁ bản sao nội dung (canonical còn ở recruitment_messages). */
  async markSent(id: number, owner: string, providerMessageId: string | null) {
    return this.fenced(
      `UPDATE "recruitment_channel_outbox"
       SET status = 'SENT', sent_at = now(), provider_message_id = $3::varchar,
           message_text = NULL, text_redacted_at = now(), lease_until = NULL,
           next_attempt_at = NULL, last_error_code = NULL, updated_at = now()
       WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id`,
      [id, owner, providerMessageId],
    );
  }

  /** Chắc chắn chưa gửi → thử lại sau `delayMs` (giữ vị trí đầu hàng của người nhận). */
  async markRetry(id: number, owner: string, code: string, delayMs: number) {
    return this.fenced(
      `UPDATE "recruitment_channel_outbox"
       SET status = 'RETRY', last_error_code = $3::varchar, dispatched_at = NULL,
           next_attempt_at = now() + $4::int * interval '1 millisecond',
           lease_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id`,
      [id, owner, code, delayMs],
    );
  }

  /** Có thể đã gửi → chờ đối soát, không tự gửi lại. */
  async markUnknown(id: number, owner: string, code: string) {
    return this.fenced(
      `UPDATE "recruitment_channel_outbox"
       SET status = 'UNKNOWN', last_error_code = $3::varchar, lease_until = NULL,
           next_attempt_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id`,
      [id, owner, code],
    );
  }

  async markDeadLetter(id: number, owner: string, code: string) {
    return this.fenced(
      `UPDATE "recruitment_channel_outbox"
       SET status = 'DEAD_LETTER', last_error_code = $3::varchar, lease_until = NULL,
           next_attempt_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id`,
      [id, owner, code],
    );
  }

  /**
   * Sender chết SAU khi dispatch (lease hết hạn, `dispatched_at` có giá trị): request
   * có thể đã tới Zalo → `UNKNOWN`. Chết trước khi dispatch thì `claimNext` lấy lại.
   */
  async recoverDispatched(oaId: string): Promise<number[]> {
    const rows = returnedRows<{ id: number | string }>(
      await this.dataSource.query(
        `UPDATE "recruitment_channel_outbox"
         SET status = 'UNKNOWN', last_error_code = 'LEASE_EXPIRED_AFTER_DISPATCH',
             lease_until = NULL, updated_at = now()
         WHERE channel_account_id = $1 AND status = 'SENDING'
           AND lease_until < now() AND dispatched_at IS NOT NULL
         RETURNING id`,
        [oaId],
      ),
    );
    return rows.map((row) => Number(row.id));
  }

  /**
   * Hết hạn 7 ngày: tin chưa gửi được (PENDING/RETRY) → DEAD_LETTER; mọi bản sao nội
   * dung còn lại (UNKNOWN/DEAD_LETTER) bị xoá. Trả các dòng vừa thành dead-letter.
   */
  async expireRetention(oaId: string): Promise<number[]> {
    const expired = returnedRows<{ id: number | string }>(
      await this.dataSource.query(
        `UPDATE "recruitment_channel_outbox"
         SET status = 'DEAD_LETTER', last_error_code = coalesce(last_error_code, 'RETENTION_EXPIRED'),
             message_text = NULL, text_redacted_at = now(), next_attempt_at = NULL,
             lease_until = NULL, updated_at = now()
         WHERE channel_account_id = $1 AND status IN ('PENDING', 'RETRY')
           AND created_at < now() - interval '${OUTBOX_TEXT_RETENTION_DAYS} days'
         RETURNING id`,
        [oaId],
      ),
    );
    await this.dataSource.query(
      `UPDATE "recruitment_channel_outbox"
       SET message_text = NULL, text_redacted_at = now(), updated_at = now()
       WHERE channel_account_id = $1 AND status IN ('UNKNOWN', 'DEAD_LETTER')
         AND message_text IS NOT NULL
         AND created_at < now() - interval '${OUTBOX_TEXT_RETENTION_DAYS} days'`,
      [oaId],
    );
    return expired.map((row) => Number(row.id));
  }

  private async fenced(sql: string, params: unknown[]): Promise<boolean> {
    return returnedRows(await this.dataSource.query(sql, params)).length > 0;
  }
}

/** Vì sao tin AI không được gửi nữa; `null` = vẫn gửi được. */
function suppressionCode(
  control: { control_mode: string; control_version: number },
  enqueuedVersion: number | null,
): string | null {
  if (control.control_mode === 'HUMAN_TAKEOVER')
    return 'CONTROL_HUMAN_TAKEOVER';
  if (control.control_mode !== 'AI_ACTIVE') return 'CONTROL_CLOSED';
  if (enqueuedVersion === null) return 'CONTROL_VERSION_MISSING';
  if (Number(control.control_version) !== enqueuedVersion) {
    return 'CONTROL_VERSION_CHANGED';
  }
  return null;
}
