import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, type EntityManager } from 'typeorm';

import { pilotFingerprint } from './recruitment-ai-safety.config';
import { returnedRows } from './recruitment-channel-event.queue';
import { OUTBOX_TEXT_RETENTION_DAYS } from './zalo-outbound.config';
import type { RecruitmentOutboundSafetyConfig } from './recruitment-outbound-safety.config';

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

/** Bảng grant dispatch của SYSTEM OWNER (single dispatch guard, G8 C2). */
export const DISPATCH_GRANT_TABLE = 'recruitment_outbound_dispatch_grants';

/**
 * Uỷ quyền production của SYSTEM OWNER (GO PROD). Production mode chỉ claim + dispatch khi
 * OA có đúng một uỷ quyền `ACTIVE`; hạn mức hiệu lực = min(env, uỷ quyền). App chỉ đọc.
 */
export const PRODUCTION_AUTHORIZATION_TABLE =
  'recruitment_production_authorizations';

/** Uỷ quyền production đang hiệu lực (hạn mức trần do Owner duyệt). */
export interface ProductionAuthorization {
  id: number;
  maxRequestsPerRecipientDay: number;
  maxRequestsPerDay: number;
  dailyCostBudgetVnd: number;
  monthlyCostBudgetVnd: number;
  interactionWindowHours: number;
  freeWindowHours: number;
}

const AUTHORIZATION_COLUMNS = `id, max_requests_per_recipient_day, max_requests_per_day,
  daily_cost_budget_vnd, monthly_cost_budget_vnd, interaction_window_hours, free_window_hours`;

function authorizationOf(
  row: Record<string, unknown>,
): ProductionAuthorization {
  return {
    id: Number(row.id),
    maxRequestsPerRecipientDay: Number(row.max_requests_per_recipient_day),
    maxRequestsPerDay: Number(row.max_requests_per_day),
    dailyCostBudgetVnd: Number(row.daily_cost_budget_vnd),
    monthlyCostBudgetVnd: Number(row.monthly_cost_budget_vnd),
    interactionWindowHours: Number(row.interaction_window_hours),
    freeWindowHours: Number(row.free_window_hours),
  };
}

/**
 * Single dispatch guard (G8 C2): bật thì CHỈ tin AI có grant `ACTIVE` khớp (đúng outbox,
 * OA, người nhận pilot, hash nội dung đã duyệt, version điều khiển) mới được claim và
 * dispatch; grant tiêu đúng một lần trong CÙNG transaction ghi `dispatched_at`, trước
 * khi mở kết nối. Tin HR, tin khác, retry sau khi đã tiêu grant → giữ chờ, không gửi.
 */
export interface DispatchGuard {
  /** OA tuyển dụng đang cấu hình — grant và tin phải cùng OA này. */
  oaId: string;
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
  /**
   * Trả về chờ, không mở kết nối: outbound đang dừng khẩn / không đọc được trạng thái
   * (`code` trống), hoặc single dispatch guard không cho (`code` = `DISPATCH_GRANT_*`).
   */
  | { outcome: 'HELD'; code?: string };

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
const UNFINISHED = `(o.status IN ('AWAITING_APPROVAL', 'PENDING', 'SENDING', 'RETRY', 'UNKNOWN'))`;

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
    guard: DispatchGuard | null = null,
    production = false,
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
      const claimed = await this.tryClaim(
        oaId,
        head,
        owner,
        leaseMs,
        guard,
        production,
      );
      if (claimed) return claimed;
    }
    return null;
  }

  private async tryClaim(
    oaId: string,
    head: { id: number; recipient: string },
    owner: string,
    leaseMs: number,
    guard: DispatchGuard | null,
    production: boolean,
  ): Promise<ClaimedOutbox | null> {
    // Production: không có uỷ quyền GO PROD ACTIVE cho OA → không claim (tin đứng PENDING,
    // không claim lặp); cửa kiểm cuối vẫn kiểm lại dưới khoá.
    const productionClause = production
      ? `AND EXISTS (SELECT 1 FROM "${PRODUCTION_AUTHORIZATION_TABLE}" p
               WHERE p.status = 'ACTIVE' AND p.channel_account_id = t.channel_account_id)`
      : '';
    // Guard bật: chỉ tin AI có grant ACTIVE còn hạn mới được claim (tin HR / tin không có
    // grant đứng nguyên PENDING, không bị claim lặp). Cửa kiểm cuối vẫn kiểm lại đầy đủ.
    const grantClause = guard
      ? `AND t.source_type = 'AI_REPLY' AND EXISTS (
               SELECT 1 FROM "${DISPATCH_GRANT_TABLE}" g
               WHERE g.outbox_id = t.id AND g.status = 'ACTIVE'
                 AND g.dispatches_used < g.max_dispatches AND g.expires_at > now())`
      : '';
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
             AND (
                t.source_type <> 'AI_REPLY'
                OR EXISTS (
                  SELECT 1
                  FROM "recruitment_outbox_approvals" a
                  WHERE a.outbox_id = t.id
                    AND a.state = 'APPROVED'
                    AND a.approved_by IS NOT NULL
                    AND a.approved_at IS NOT NULL
                    AND a.expires_at > now()
                    AND a.approved_text_sha256 IS NOT NULL
                    AND a.approved_oa_id = t.channel_account_id
                    AND a.approved_recipient_id = t.external_recipient_id
                    AND a.approved_control_version = t.control_version
                    AND a.approved_message_id = t.recruitment_message_id
                )
              )
              AND (t.status = 'PENDING'
                  OR (t.status = 'RETRY' AND t.next_attempt_at <= now())
                  OR (t.status = 'SENDING' AND t.lease_until < now() AND t.dispatched_at IS NULL))
             ${grantClause}
             ${productionClause}
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
   *
   * `guard` (single dispatch guard): grant được khoá `FOR UPDATE` dưới khoá advisory toàn
   * cục, kiểm khớp, rồi tiêu trong cùng transaction với `dispatched_at` — commit xong mới
   * mở kết nối; không tiêu được thì rollback cả hai. `redispatch` chỉ hợp lệ với grant
   * vừa tiêu bởi đúng lease này (lần gửi đầu bị Zalo từ chối token, chắc chắn chưa tới).
   */
  async dispatch(
    row: ClaimedOutbox,
    owner: string,
    redispatch = false,
    pilotSenders: string[] | null = null,
    guard: DispatchGuard | null = null,
    production: RecruitmentOutboundSafetyConfig | null = null,
    hrMessageTtlMinutes: number | null = null,
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
        return this.hold(em, row, owner, redispatch);
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

      // Tin HR quá TTL không bao giờ gửi muộn (kể cả khi lượt dọn định kỳ chưa kịp chạy).
      if (row.sourceType === 'HR_MESSAGE' && hrMessageTtlMinutes) {
        const [age]: Array<{ expired: boolean }> = await em.query(
          `SELECT created_at <= clock_timestamp() - $2::int * interval '1 minute' AS expired
           FROM "recruitment_channel_outbox" WHERE id = $1`,
          [row.id, hrMessageTtlMinutes],
        );
        if (age?.expired !== false) {
          return { outcome: 'INVALID', code: 'HR_MESSAGE_EXPIRED' };
        }
      }

      // P3.2: final approval check. Fail closed on missing or changed data.
      // Locks prevent approval/canonical/outbox edits until dispatch commits.
      const approvalValid =
        row.sourceType !== 'AI_REPLY' ||
        (
          await em.query<Array<{ outbox_id: number }>>(
            `SELECT a.outbox_id
             FROM "recruitment_channel_outbox" o
             JOIN "recruitment_outbox_approvals" a ON a.outbox_id = o.id
             JOIN "recruitment_messages" m ON m.id = o.recruitment_message_id
             WHERE o.id = $1
               AND o.status = 'SENDING'
               AND o.lease_owner = $2
               AND o.source_type = 'AI_REPLY'
               AND o.channel = 'ZALO'
               AND o.message_text = $3
               AND o.channel_account_id = $4
               AND o.external_recipient_id = $5
               AND o.recruitment_message_id = $6
               AND o.control_version = $7
               AND a.state = 'APPROVED'
               AND a.approved_by IS NOT NULL
               AND a.approved_at IS NOT NULL
               AND a.expires_at > clock_timestamp()
               AND a.approved_oa_id = o.channel_account_id
               AND a.approved_recipient_id = o.external_recipient_id
               AND a.approved_control_version = o.control_version
               AND a.approved_message_id = o.recruitment_message_id
               AND m.content = o.message_text
               AND a.approved_text_sha256 =
                   encode(sha256(convert_to(m.content, 'UTF8')), 'hex')
             FOR SHARE OF o, a, m`,
            [
              row.id,
              owner,
              row.messageText,
              row.channelAccountId,
              row.externalRecipientId,
              row.recruitmentMessageId,
              row.controlVersion,
            ],
          )
        ).length > 0;

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
          ? (suppressionCode(control, row.controlVersion) ??
            (approvalValid ? null : 'APPROVAL_INVALID'))
          : null;
      if (!code) {
        const grant = guard
          ? await this.checkGrant(
              em,
              row,
              owner,
              redispatch,
              pilotSenders,
              guard,
            )
          : null;
        if (grant && 'denied' in grant) {
          return this.hold(em, row, owner, redispatch, grant.denied);
        }

        let productionAdmission:
          | { interactionAt: Date; estimatedCostVnd: number }
          | { denied: string }
          | { held: string }
          | null = null;
        if (production) {
          productionAdmission = await this.checkProductionAdmission(
            em,
            row,
            production,
          );
          // Chặn ở cửa production (kể cả chạm quota/ngân sách) là KẾT THÚC: DEAD_LETTER
          // + cảnh báo HR, không giữ tin sang ngày/tháng sau rồi gửi muộn.
          if ('denied' in productionAdmission) {
            return { outcome: 'INVALID', code: productionAdmission.denied };
          }
          if ('held' in productionAdmission) {
            return this.hold(
              em,
              row,
              owner,
              redispatch,
              productionAdmission.held,
            );
          }
        }
        const dispatched = returnedRows(
          await em.query(
            `UPDATE "recruitment_channel_outbox" SET dispatched_at = now(), updated_at = now()
             WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id`,
            [row.id, owner],
          ),
        );
        if (!dispatched.length) return { outcome: 'LOST' };
        if (grant && 'consume' in grant) {
          const used = returnedRows(
            await em.query(
              `UPDATE "${DISPATCH_GRANT_TABLE}"
               SET dispatches_used = dispatches_used + 1,
                   status = CASE WHEN dispatches_used + 1 >= max_dispatches THEN 'CONSUMED' ELSE status END,
                   consumed_at = clock_timestamp(), consumed_lease_owner = $2
               WHERE id = $1 AND status = 'ACTIVE' AND dispatches_used < max_dispatches
                 AND expires_at > clock_timestamp()
               RETURNING id`,
              [grant.consume, owner],
            ),
          );
          // Đã khoá FOR UPDATE và kiểm ở trên — không tiêu được là bất thường: ném lỗi để
          // rollback cả `dispatched_at`, không mở kết nối.
          if (used.length !== 1)
            throw new Error('DISPATCH_GRANT_CONSUME_FAILED');
        }
        if (productionAdmission && 'interactionAt' in productionAdmission) {
          // Một dòng = một lần chuẩn bị mở request Send API. Không có nội dung, token
          // hay user id thô. Nếu process chết sau commit, maintenance chuyển UNKNOWN.
          await em.query(
            `INSERT INTO "recruitment_outbound_attempts"
               (outbox_id, request_no, lease_owner, source_type, channel_account_id,
                recipient_fingerprint, interaction_at, estimated_cost_vnd)
             SELECT $1,
                    coalesce(max(a.request_no), 0) + 1,
                    $2, $3, $4, $5, $6, $7
             FROM "recruitment_outbound_attempts" a
             WHERE a.outbox_id = $1`,
            [
              row.id,
              owner,
              row.sourceType,
              row.channelAccountId,
              pilotFingerprint(row.channelAccountId, row.externalRecipientId),
              productionAdmission.interactionAt,
              productionAdmission.estimatedCostVnd,
            ],
          );
        }
        return { outcome: 'DISPATCHED' };
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
          pilotBlocked
            ? 'SUPPRESSED_PILOT'
            : code === 'APPROVAL_INVALID'
              ? 'SUPPRESSED_APPROVAL_INVALID'
              : 'SUPPRESSED_CONTROL_CHANGED',
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

  /** Trả dòng về PENDING (không tính lần thử), không mở kết nối. */
  private async hold(
    em: EntityManager,
    row: ClaimedOutbox,
    owner: string,
    redispatch: boolean,
    code?: string,
  ): Promise<DispatchGate> {
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
    if (!held.length) return { outcome: 'LOST' };
    return code ? { outcome: 'HELD', code } : { outcome: 'HELD' };
  }

  /**
   * Production admission dưới transaction/khoá toàn cục: chỉ ứng viên vừa tương tác
   * thật với đúng OA; phản hồi AI của hồ sơ gắn vị trí chưa công bố (DRAFT / chưa từng
   * publish) bị chặn — tin HR không áp điều kiện vị trí; quota và ngân sách tính từ ledger
   * request bền, không từ log process.
   */
  private async checkProductionAdmission(
    em: EntityManager,
    row: ClaimedOutbox,
    limits: RecruitmentOutboundSafetyConfig,
  ): Promise<
    | { interactionAt: Date; estimatedCostVnd: number }
    | { denied: string }
    | { held: string }
  > {
    await em.query(
      `SELECT pg_advisory_xact_lock(hashtext('recruitment_outbound_quota'))`,
    );
    // GO PROD: đọc uỷ quyền FOR SHARE — Owner thu hồi (UPDATE) phải chờ dispatch đang chạy
    // commit; sau khi thu hồi commit, không request mới nào qua được cửa này.
    const [authRow]: Array<Record<string, unknown>> = await em.query(
      `SELECT ${AUTHORIZATION_COLUMNS} FROM "${PRODUCTION_AUTHORIZATION_TABLE}"
       WHERE status = 'ACTIVE' AND channel_account_id = $1
       FOR SHARE`,
      [row.channelAccountId],
    );
    if (!authRow) return { held: 'PRODUCTION_NOT_AUTHORIZED' };
    const auth = authorizationOf(authRow);
    // Env chỉ được hạ thấp hạn mức Owner đã duyệt, không nâng được.
    limits = {
      ...limits,
      maxRequestsPerRecipientDay: Math.min(
        limits.maxRequestsPerRecipientDay,
        auth.maxRequestsPerRecipientDay,
      ),
      maxRequestsPerDay: Math.min(
        limits.maxRequestsPerDay,
        auth.maxRequestsPerDay,
      ),
      dailyCostBudgetVnd: Math.min(
        limits.dailyCostBudgetVnd,
        auth.dailyCostBudgetVnd,
      ),
      monthlyCostBudgetVnd: Math.min(
        limits.monthlyCostBudgetVnd,
        auth.monthlyCostBudgetVnd,
      ),
      interactionWindowHours: Math.min(
        limits.interactionWindowHours,
        auth.interactionWindowHours,
      ),
      freeWindowHours: Math.min(limits.freeWindowHours, auth.freeWindowHours),
    };
    await em.query(
      `SELECT pg_advisory_xact_lock(hashtext('recruitment_outbound_attempts'), $1::int)`,
      [row.id],
    );

    const [eligibility]: Array<{
      has_application: boolean;
      job_status: string | null;
      job_published_at: Date | null;
      interaction_at: Date | null;
    }> = await em.query(
      `SELECT (c.application_id IS NOT NULL) AS has_application,
              j.status::text AS job_status,
              j.published_at AS job_published_at,
              (
                SELECT max(coalesce(e.provider_created_at, e.received_at))
                FROM "recruitment_channel_events" e
                WHERE e.channel = 'ZALO'
                  AND e.channel_account_id = o.channel_account_id
                  AND e.external_sender_id = o.external_recipient_id
                  AND e.event_type = 'user_send_text'
                  AND e.status = 'PROCESSED'
                  AND coalesce(e.provider_created_at, e.received_at)
                        <= clock_timestamp() + interval '5 minutes'
              ) AS interaction_at
       FROM "recruitment_channel_outbox" o
       JOIN "recruitment_messages" m ON m.id = o.recruitment_message_id
       JOIN "recruitment_conversations" c ON c.id = m.conversation_id
       LEFT JOIN "recruitment_applications" app ON app.id = c.application_id
       LEFT JOIN "recruitment_jobs" j ON j.id = app.job_id
       WHERE o.id = $1`,
      [row.id],
    );
    if (!eligibility) return { denied: 'PRODUCTION_CONTEXT_MISSING' };
    // Chỉ phản hồi AI mới có thể mang thông tin vị trí (backend AI vốn đã ẩn vị trí DRAFT).
    // Vị trí đã công bố rồi tạm dừng/đóng vẫn được AI báo trạng thái; HR viết tay tự chịu trách nhiệm.
    if (
      row.sourceType === 'AI_REPLY' &&
      eligibility.has_application &&
      (eligibility.job_status === 'DRAFT' || !eligibility.job_published_at)
    ) {
      return { denied: 'JOB_NOT_PUBLISHED' };
    }
    if (!eligibility.interaction_at) {
      return { denied: 'ZALO_INTERACTION_MISSING' };
    }

    const [clock]: Array<{
      at: Date;
      day_start: Date;
      next_day: Date;
      month_start: Date;
      next_month: Date;
      interaction_age_seconds: number | string;
    }> = await em.query(
      `WITH tick AS (SELECT clock_timestamp() AS at)
       SELECT at,
              date_trunc('day', at AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS day_start,
              (date_trunc('day', at AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '1 day') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS next_day,
              date_trunc('month', at AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS month_start,
              (date_trunc('month', at AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '1 month') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS next_month,
              extract(epoch FROM (at - $1::timestamptz)) AS interaction_age_seconds
       FROM tick`,
      [eligibility.interaction_at],
    );
    const ageSeconds = Number(clock.interaction_age_seconds);
    if (
      !Number.isFinite(ageSeconds) ||
      ageSeconds < -300 ||
      ageSeconds > limits.interactionWindowHours * 3600
    ) {
      return { denied: 'ZALO_INTERACTION_EXPIRED' };
    }
    const estimatedCostVnd =
      ageSeconds > limits.freeWindowHours * 3600
        ? limits.estimatedPaidMessageCostVnd
        : 0;
    const fingerprint = pilotFingerprint(
      row.channelAccountId,
      row.externalRecipientId,
    );
    const [usage]: Array<{
      recipient_day: number | string;
      total_day: number | string;
      cost_day: number | string;
      cost_month: number | string;
    }> = await em.query(
      `SELECT
         count(*) FILTER (
           WHERE channel_account_id = $1 AND recipient_fingerprint = $2
             AND started_at >= $3::timestamptz AND started_at < $4::timestamptz
         ) AS recipient_day,
         count(*) FILTER (
           WHERE started_at >= $3::timestamptz AND started_at < $4::timestamptz
         ) AS total_day,
         coalesce(sum(estimated_cost_vnd) FILTER (
           WHERE started_at >= $3::timestamptz AND started_at < $4::timestamptz
         ), 0) AS cost_day,
         coalesce(sum(estimated_cost_vnd) FILTER (
           WHERE started_at >= $5::timestamptz AND started_at < $6::timestamptz
         ), 0) AS cost_month
       FROM "recruitment_outbound_attempts"`,
      [
        row.channelAccountId,
        fingerprint,
        clock.day_start,
        clock.next_day,
        clock.month_start,
        clock.next_month,
      ],
    );
    if (Number(usage.recipient_day) >= limits.maxRequestsPerRecipientDay) {
      return { denied: 'OUTBOUND_RECIPIENT_DAILY_LIMIT' };
    }
    if (Number(usage.total_day) >= limits.maxRequestsPerDay) {
      return { denied: 'OUTBOUND_DAILY_LIMIT' };
    }
    if (
      Number(usage.cost_month) + estimatedCostVnd >
      limits.monthlyCostBudgetVnd
    ) {
      return { denied: 'OUTBOUND_MONTHLY_COST_LIMIT' };
    }
    if (Number(usage.cost_day) + estimatedCostVnd > limits.dailyCostBudgetVnd) {
      return { denied: 'OUTBOUND_DAILY_COST_LIMIT' };
    }
    return { interactionAt: eligibility.interaction_at, estimatedCostVnd };
  }

  /**
   * Grant của đúng outbox này (khoá advisory toàn cục + `FOR UPDATE` — hai sender không
   * cùng dùng một grant, không cùng dùng grant cuối). Trả `consume` (id grant sẽ tiêu),
   * `redispatch` (grant đã tiêu bởi đúng lease này) hoặc `denied` (mã lý do).
   */
  private async checkGrant(
    em: EntityManager,
    row: ClaimedOutbox,
    owner: string,
    redispatch: boolean,
    pilotSenders: string[] | null,
    guard: DispatchGuard,
  ): Promise<{ consume: number } | { redispatch: true } | { denied: string }> {
    await em.query(
      `SELECT pg_advisory_xact_lock(hashtext('${DISPATCH_GRANT_TABLE}'))`,
    );
    if (row.sourceType !== 'AI_REPLY')
      return { denied: 'DISPATCH_GRANT_SOURCE' };
    const [grant]: Array<{
      id: number | string;
      status: string;
      dispatches_used: number | string;
      max_dispatches: number | string;
      channel_account_id: string;
      recipient_fingerprint: string;
      approved_text_sha256: string;
      approved_control_version: number | string;
      consumed_lease_owner: string | null;
      live: boolean;
    }> = await em.query(
      `SELECT id, status, dispatches_used, max_dispatches, channel_account_id,
              recipient_fingerprint, approved_text_sha256, approved_control_version,
              consumed_lease_owner, expires_at > clock_timestamp() AS live
       FROM "${DISPATCH_GRANT_TABLE}" WHERE outbox_id = $1 FOR UPDATE`,
      [row.id],
    );
    if (!grant) return { denied: 'DISPATCH_GRANT_MISSING' };
    const fingerprint = pilotFingerprint(
      row.channelAccountId,
      row.externalRecipientId,
    );
    if (
      grant.channel_account_id !== row.channelAccountId ||
      row.channelAccountId !== guard.oaId
    ) {
      return { denied: 'DISPATCH_GRANT_OA_MISMATCH' };
    }
    if (
      grant.recipient_fingerprint !== fingerprint ||
      (pilotSenders !== null && !pilotSenders.includes(fingerprint))
    ) {
      return { denied: 'DISPATCH_GRANT_RECIPIENT_MISMATCH' };
    }
    const textSha = createHash('sha256')
      .update(row.messageText ?? '', 'utf8')
      .digest('hex');
    if (grant.approved_text_sha256 !== textSha) {
      return { denied: 'DISPATCH_GRANT_TEXT_MISMATCH' };
    }
    if (
      row.controlVersion === null ||
      Number(grant.approved_control_version) !== row.controlVersion
    ) {
      return { denied: 'DISPATCH_GRANT_CONTROL_MISMATCH' };
    }
    if (redispatch) {
      return grant.status === 'CONSUMED' && grant.consumed_lease_owner === owner
        ? { redispatch: true }
        : { denied: 'DISPATCH_GRANT_REDISPATCH_DENIED' };
    }
    if (grant.status !== 'ACTIVE')
      return { denied: 'DISPATCH_GRANT_NOT_ACTIVE' };
    if (grant.live !== true) return { denied: 'DISPATCH_GRANT_EXPIRED' };
    if (Number(grant.dispatches_used) >= Number(grant.max_dispatches)) {
      return { denied: 'DISPATCH_GRANT_EXHAUSTED' };
    }
    return { consume: Number(grant.id) };
  }

  /** Bảng grant đã có (guard bật mà thiếu bảng → sender không chạy, fail-closed). */
  async dispatchGuardReady(): Promise<boolean> {
    const [row]: Array<{ ready: boolean }> = await this.dataSource.query(
      `SELECT to_regclass('public.${DISPATCH_GRANT_TABLE}') IS NOT NULL AS ready`,
    );
    return row?.ready === true;
  }

  async productionSafetyReady(): Promise<boolean> {
    const [row]: Array<{ ready: boolean }> = await this.dataSource.query(
      `SELECT to_regclass('public.recruitment_outbound_attempts') IS NOT NULL
          AND to_regclass('public.${PRODUCTION_AUTHORIZATION_TABLE}') IS NOT NULL AS ready`,
    );
    return row?.ready === true;
  }

  /** Uỷ quyền GO PROD đang ACTIVE của OA (để log / màn hình vận hành), `null` nếu không có. */
  async activeProductionAuthorization(
    oaId: string,
  ): Promise<ProductionAuthorization | null> {
    const [row]: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${AUTHORIZATION_COLUMNS} FROM "${PRODUCTION_AUTHORIZATION_TABLE}"
       WHERE status = 'ACTIVE' AND channel_account_id = $1`,
      [oaId],
    );
    return row ? authorizationOf(row) : null;
  }

  /** Lần Send API đầu bị Zalo từ chối token; kết thúc ledger trước request thứ hai. */
  async markAttemptRejected(id: number, owner: string, code: string) {
    return (
      returnedRows(
        await this.dataSource.query(
          `UPDATE "recruitment_outbound_attempts"
         SET outcome = 'REJECTED', result_code = $3, completed_at = clock_timestamp()
         WHERE outbox_id = $1 AND lease_owner = $2 AND outcome = 'DISPATCHING'
         RETURNING id`,
          [id, owner, code],
        ),
      ).length > 0
    );
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
      `WITH changed AS (
         UPDATE "recruitment_channel_outbox"
         SET status = 'SENT', sent_at = now(), provider_message_id = $3::varchar,
             message_text = NULL, text_redacted_at = now(), lease_until = NULL,
             next_attempt_at = NULL, last_error_code = NULL, updated_at = now()
         WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id
       ), completed AS (
         UPDATE "recruitment_outbound_attempts"
         SET outcome = 'SENT', result_code = NULL, provider_message_id = $3::varchar,
             completed_at = clock_timestamp()
         WHERE outbox_id = $1 AND lease_owner = $2 AND outcome = 'DISPATCHING'
           AND EXISTS (SELECT 1 FROM changed)
       ) SELECT id FROM changed`,
      [id, owner, providerMessageId],
    );
  }

  /** Chắc chắn chưa gửi → thử lại sau `delayMs` (giữ vị trí đầu hàng của người nhận). */
  async markRetry(id: number, owner: string, code: string, delayMs: number) {
    return this.fenced(
      `WITH changed AS (
         UPDATE "recruitment_channel_outbox"
         SET status = 'RETRY', last_error_code = $3::varchar, dispatched_at = NULL,
             next_attempt_at = now() + $4::int * interval '1 millisecond',
             lease_until = NULL, updated_at = now()
         WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id
       ), completed AS (
         UPDATE "recruitment_outbound_attempts"
         SET outcome = 'RETRY', result_code = $3::varchar,
             completed_at = clock_timestamp()
         WHERE outbox_id = $1 AND lease_owner = $2 AND outcome = 'DISPATCHING'
           AND EXISTS (SELECT 1 FROM changed)
       ) SELECT id FROM changed`,
      [id, owner, code, delayMs],
    );
  }

  /** Có thể đã gửi → chờ đối soát, không tự gửi lại. */
  async markUnknown(id: number, owner: string, code: string) {
    return this.fenced(
      `WITH changed AS (
         UPDATE "recruitment_channel_outbox"
         SET status = 'UNKNOWN', last_error_code = $3::varchar, lease_until = NULL,
             next_attempt_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id
       ), completed AS (
         UPDATE "recruitment_outbound_attempts"
         SET outcome = 'UNKNOWN', result_code = $3::varchar,
             completed_at = clock_timestamp()
         WHERE outbox_id = $1 AND lease_owner = $2 AND outcome = 'DISPATCHING'
           AND EXISTS (SELECT 1 FROM changed)
       ) SELECT id FROM changed`,
      [id, owner, code],
    );
  }

  async markDeadLetter(id: number, owner: string, code: string) {
    return this.fenced(
      `WITH changed AS (
         UPDATE "recruitment_channel_outbox"
         SET status = 'DEAD_LETTER', last_error_code = $3::varchar, lease_until = NULL,
             next_attempt_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2 RETURNING id
       ), completed AS (
         UPDATE "recruitment_outbound_attempts"
         SET outcome = 'DEAD_LETTER', result_code = $3::varchar,
             completed_at = clock_timestamp()
         WHERE outbox_id = $1 AND lease_owner = $2 AND outcome = 'DISPATCHING'
           AND EXISTS (SELECT 1 FROM changed)
       ) SELECT id FROM changed`,
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
        `WITH changed AS (
           UPDATE "recruitment_channel_outbox"
           SET status = 'UNKNOWN', last_error_code = 'LEASE_EXPIRED_AFTER_DISPATCH',
               lease_until = NULL, updated_at = now()
           WHERE channel_account_id = $1 AND status = 'SENDING'
             AND lease_until < now() AND dispatched_at IS NOT NULL
           RETURNING id
         ), completed AS (
           UPDATE "recruitment_outbound_attempts" a
           SET outcome = 'UNKNOWN', result_code = 'LEASE_EXPIRED_AFTER_DISPATCH',
               completed_at = clock_timestamp()
           FROM changed c
           WHERE a.outbox_id = c.id AND a.outcome = 'DISPATCHING'
         ) SELECT id FROM changed`,
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
