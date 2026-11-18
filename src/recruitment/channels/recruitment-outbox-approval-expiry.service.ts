import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  HrAlertSeverity,
  HrAlertType,
  RecruitmentActorType,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { returnedRows } from './recruitment-channel-event.queue';
import { isRecruitmentWorkerEnabled } from './recruitment-channel-worker.config';
import { RecruitmentHrAlertService } from './recruitment-hr-alert.service';
import { isZaloOutboundEnabled } from './zalo-outbound.config';

const SYSTEM_ACTOR: RecruitmentActor = {
  type: RecruitmentActorType.SYSTEM,
  employeeId: null,
  name: 'Recruitment Approval Expiry',
  roles: [],
};

export const APPROVAL_EXPIRY_EVERY_MS = 30_000;
export const DEFAULT_PENDING_APPROVAL_TTL_MINUTES = 60;

/** TTL bản nháp AI chờ duyệt (phút) — `RECRUITMENT_APPROVAL_PENDING_TTL_MINUTES`, 15–10080; sai ⇒ mặc định. */
export function readPendingApprovalTtl(
  get: (key: string) => string | undefined,
): number {
  const raw = get('RECRUITMENT_APPROVAL_PENDING_TTL_MINUTES')?.trim();
  const value = raw ? Number(raw) : DEFAULT_PENDING_APPROVAL_TTL_MINUTES;
  return Number.isSafeInteger(value) && value >= 15 && value <= 10080
    ? value
    : DEFAULT_PENDING_APPROVAL_TTL_MINUTES;
}

export const DEFAULT_HR_MESSAGE_TTL_MINUTES = 60;

/** TTL tin HR chờ gửi (phút) — `RECRUITMENT_HR_MESSAGE_TTL_MINUTES`, 5–1440; sai ⇒ mặc định. */
export function readHrMessageTtl(
  get: (key: string) => string | undefined,
): number {
  const raw = get('RECRUITMENT_HR_MESSAGE_TTL_MINUTES')?.trim();
  const value = raw ? Number(raw) : DEFAULT_HR_MESSAGE_TTL_MINUTES;
  return Number.isSafeInteger(value) && value >= 5 && value <= 1440
    ? value
    : DEFAULT_HR_MESSAGE_TTL_MINUTES;
}

/**
 * Dọn bản duyệt hết hạn: bản đã duyệt quá `expires_at` và bản nháp chờ quá TTL →
 * `SUPPRESSED` + approval `EXPIRED` + audit. Sender vốn đã từ chối gửi bản hết hạn;
 * việc dọn giải phóng đầu hàng của người nhận để tin sau không bị chặn. Chạy định kỳ
 * khi worker HOẶC outbound bật (C1 có worker mà chưa có sender).
 *
 * Tin HR (`HR_MESSAGE`) chờ gửi quá TTL (mặc định 60 phút) → `DEAD_LETTER`
 * (`HR_MESSAGE_EXPIRED`) + audit + cảnh báo HR trong cùng transaction: không bao giờ
 * gửi muộn (sau dừng khẩn, quota, lỗi gói OA…); HR thấy nguyên nhân và soạn tin mới.
 */
@Injectable()
export class RecruitmentOutboxApprovalExpiryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('RecruitmentApprovalExpiry');
  private readonly scheduled: boolean;
  private readonly pendingTtlMinutes: number;
  private readonly hrMessageTtlMinutes: number;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
    configService?: ConfigService,
    private readonly alerts?: RecruitmentHrAlertService,
  ) {
    const get = (key: string) => configService?.get<string>(key);
    this.scheduled =
      isRecruitmentWorkerEnabled(get) || isZaloOutboundEnabled(get);
    this.pendingTtlMinutes = readPendingApprovalTtl(get);
    this.hrMessageTtlMinutes = readHrMessageTtl(get);
  }

  onApplicationBootstrap(): void {
    if (!this.scheduled) return;
    this.logger.log(
      `approval expiry start every=${APPROVAL_EXPIRY_EVERY_MS}ms pendingTtl=${this.pendingTtlMinutes}m hrMessageTtl=${this.hrMessageTtlMinutes}m`,
    );
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), APPROVAL_EXPIRY_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Một lượt dọn; không chạy chồng, không ném lỗi ra ngoài (chỉ log mã lỗi). */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // Hai phần độc lập: lỗi bản duyệt AI không được chặn việc hết hạn tin HR.
      try {
        const result = await this.expireBatch(this.pendingTtlMinutes);
        if (result.expired > 0) {
          this.logger.log(
            `approval expiry expired=${result.expired} examined=${result.examined}`,
          );
        }
      } catch (error) {
        this.logger.error(`approval expiry error=${errorText(error)}`);
      }
      try {
        const hr = await this.expireHrMessages(this.hrMessageTtlMinutes);
        if (hr.expired > 0) {
          this.logger.warn(
            `hr message expiry expired=${hr.expired} examined=${hr.examined} ttl=${this.hrMessageTtlMinutes}m`,
          );
        }
      } catch (error) {
        this.logger.error(`hr message expiry error=${errorText(error)}`);
      }
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Tin HR chờ gửi (`PENDING` / `RETRY` — chắc chắn chưa tới Zalo) quá TTL → `DEAD_LETTER`
   * `HR_MESSAGE_EXPIRED`. Không đụng `SENDING` (đang ở tay sender) hay `UNKNOWN` (chờ đối soát).
   */
  async expireHrMessages(ttlMinutes: number, limit = 20) {
    if (
      !Number.isSafeInteger(ttlMinutes) ||
      ttlMinutes < 5 ||
      ttlMinutes > 1440 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    ) {
      throw new Error('HR_MESSAGE_EXPIRY_CONFIG_INVALID');
    }
    const candidates: Array<{ id: number }> = await this.dataSource.query(
      `SELECT id FROM "recruitment_channel_outbox"
       WHERE source_type = 'HR_MESSAGE' AND status IN ('PENDING', 'RETRY')
         AND created_at <= clock_timestamp() - $1::int * interval '1 minute'
       ORDER BY created_at, id
       LIMIT $2`,
      [ttlMinutes, limit],
    );
    let expired = 0;
    for (const row of candidates) {
      if (await this.expireHrOne(Number(row.id), ttlMinutes)) expired++;
    }
    return { examined: candidates.length, expired };
  }

  private async expireHrOne(outboxId: number, ttlMinutes: number) {
    return this.dataSource.transaction(async (em) => {
      const [outbox]: Array<{
        status: string;
        last_error_code: string | null;
        attempt_count: number | string;
        recruitment_message_id: number | null;
        due: boolean;
      }> = await em.query(
        `SELECT status, last_error_code, attempt_count, recruitment_message_id,
                created_at <= clock_timestamp() - $2::int * interval '1 minute' AS due
         FROM "recruitment_channel_outbox"
         WHERE id = $1 AND source_type = 'HR_MESSAGE'
         FOR UPDATE`,
        [outboxId, ttlMinutes],
      );
      if (
        !outbox ||
        outbox.due !== true ||
        !['PENDING', 'RETRY'].includes(outbox.status)
      ) {
        return false;
      }
      const changed = returnedRows(
        await em.query(
          `UPDATE "recruitment_channel_outbox"
           SET status = 'DEAD_LETTER', last_error_code = 'HR_MESSAGE_EXPIRED',
               next_attempt_at = NULL, lease_until = NULL, updated_at = now()
           WHERE id = $1 AND source_type = 'HR_MESSAGE' AND status IN ('PENDING', 'RETRY')
           RETURNING id`,
          [outboxId],
        ),
      );
      if (changed.length !== 1)
        throw new Error('HR_MESSAGE_EXPIRY_UPDATE_FAILED');
      if (outbox.recruitment_message_id) {
        // Hội thoại HR thấy tin này KHÔNG được gửi và vì sao.
        await em.query(
          `UPDATE "recruitment_messages"
           SET metadata = coalesce(metadata, '{}'::jsonb) ||
             jsonb_build_object('delivery', 'DEAD_LETTER_HR_MESSAGE_EXPIRED')
           WHERE id = $1`,
          [outbox.recruitment_message_id],
        );
      }
      await this.audit.recordMandatory(em, {
        actor: SYSTEM_ACTOR,
        action: 'CHANNEL_OUTBOX_HR_MESSAGE_EXPIRED',
        entity: 'channel-outbox',
        entityId: outboxId,
        before: {
          status: outbox.status,
          lastErrorCode: outbox.last_error_code,
        },
        after: { status: 'DEAD_LETTER', lastErrorCode: 'HR_MESSAGE_EXPIRED' },
        context: {
          outboxId,
          ttlMinutes,
          attemptCount: Number(outbox.attempt_count),
          network: false,
        },
      });
      await this.alerts?.raise(
        {
          type: HrAlertType.OUTBOUND_DEAD_LETTER,
          severity: HrAlertSeverity.HIGH,
          sourceKey: `outbox:${outboxId}`,
          outboxId,
          details: { code: 'HR_MESSAGE_EXPIRED', sourceType: 'HR_MESSAGE' },
        },
        em,
      );
      return true;
    });
  }

  async expireBatch(pendingTtlMinutes: number, limit = 20) {
    if (
      !Number.isSafeInteger(pendingTtlMinutes) ||
      pendingTtlMinutes < 15 ||
      pendingTtlMinutes > 10080 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    ) {
      throw new Error('P32_EXPIRY_CONFIG_INVALID');
    }

    const [schema]: Array<{ ready: boolean }> = await this.dataSource.query(
      `SELECT
         to_regclass('public.recruitment_outbox_approvals') IS NOT NULL
         AND to_regclass('public.recruitment_outbox_approval_events') IS NOT NULL
         AS ready`,
    );

    if (schema?.ready !== true) {
      throw new Error('P32_APPROVAL_SCHEMA_NOT_READY');
    }

    const candidates: Array<{ outbox_id: number }> =
      await this.dataSource.query(
        `SELECT a.outbox_id
         FROM "recruitment_outbox_approvals" a
         JOIN "recruitment_channel_outbox" o
           ON o.id = a.outbox_id
         WHERE o.source_type = 'AI_REPLY'
           AND o.dispatched_at IS NULL
           AND o.status IN (
             'AWAITING_APPROVAL', 'PENDING', 'RETRY', 'SENDING'
           )
           AND (
             (a.state = 'AWAITING_APPROVAL'
              AND a.created_at <=
                  clock_timestamp() - $1::int * interval '1 minute')
             OR
             (a.state = 'APPROVED'
              AND a.expires_at <= clock_timestamp())
           )
         ORDER BY a.created_at, a.outbox_id
         LIMIT $2`,
        [pendingTtlMinutes, limit],
      );

    let expired = 0;

    for (const row of candidates) {
      if (await this.expireOne(Number(row.outbox_id), pendingTtlMinutes)) {
        expired++;
      }
    }

    return { examined: candidates.length, expired };
  }

  private async expireOne(outboxId: number, pendingTtlMinutes: number) {
    return this.dataSource.transaction(async (em) => {
      const [target]: Array<{ conversation_id: number | string }> =
        await em.query(
          `SELECT m.conversation_id
         FROM "recruitment_channel_outbox" o
         JOIN "recruitment_messages" m
           ON m.id = o.recruitment_message_id
         WHERE o.id = $1 AND o.source_type = 'AI_REPLY'`,
          [outboxId],
        );

      if (!target) return false;

      const [conversation]: Array<{ id: number | string }> = await em.query(
        `SELECT id FROM "recruitment_conversations"
         WHERE id = $1 FOR UPDATE`,
        [target.conversation_id],
      );

      if (!conversation) return false;

      const [outbox]: Array<{
        id: number;
        status: string;
        source_type: string;
        recruitment_message_id: number;
        dispatched_at: Date | null;
      }> = await em.query(
        `SELECT id, status, source_type, recruitment_message_id,
                dispatched_at
         FROM "recruitment_channel_outbox"
         WHERE id = $1 FOR UPDATE`,
        [outboxId],
      );

      const [approval]: Array<{
        state: string;
        version: number;
        due: boolean;
      }> = await em.query(
        `SELECT state, version,
                (
                  (state = 'AWAITING_APPROVAL'
                   AND created_at <=
                       clock_timestamp() - $2::int * interval '1 minute')
                  OR
                  (state = 'APPROVED'
                   AND expires_at <= clock_timestamp())
                ) AS due
         FROM "recruitment_outbox_approvals"
         WHERE outbox_id = $1 FOR UPDATE`,
        [outboxId, pendingTtlMinutes],
      );

      if (!outbox || !approval || approval.due !== true) return false;

      const waiting =
        approval.state === 'AWAITING_APPROVAL' &&
        outbox.status === 'AWAITING_APPROVAL';

      const approved =
        approval.state === 'APPROVED' &&
        ['PENDING', 'RETRY', 'SENDING'].includes(outbox.status);

      if (
        (!waiting && !approved) ||
        outbox.source_type !== 'AI_REPLY' ||
        outbox.dispatched_at !== null
      ) {
        return false;
      }

      const [message]: Array<{
        id: number;
        conversation_id: number | string;
        sender_type: string;
        direction: string;
      }> = await em.query(
        `SELECT id, conversation_id, sender_type, direction
         FROM "recruitment_messages"
         WHERE id = $1 FOR UPDATE`,
        [outbox.recruitment_message_id],
      );

      if (
        !message ||
        Number(message.conversation_id) !== Number(conversation.id) ||
        message.sender_type !== 'AI' ||
        message.direction !== 'OUTBOUND'
      ) {
        throw new Error('P32_EXPIRY_CANONICAL_MISMATCH');
      }

      const reason = waiting
        ? 'PENDING_APPROVAL_EXPIRED'
        : 'APPROVED_REPLY_EXPIRED';

      const changedOutbox = returnedRows(
        await em.query(
          `UPDATE "recruitment_channel_outbox"
           SET status = 'SUPPRESSED',
               message_text = NULL,
               text_redacted_at = now(),
               last_error_code = $2,
               lease_until = NULL,
               next_attempt_at = NULL,
               updated_at = now()
           WHERE id = $1 AND dispatched_at IS NULL
             AND source_type = 'AI_REPLY'
             AND status IN (
               'AWAITING_APPROVAL', 'PENDING', 'RETRY', 'SENDING'
             )
           RETURNING id`,
          [outboxId, reason],
        ),
      );

      const changedApproval = returnedRows<{ version: number }>(
        await em.query(
          `UPDATE "recruitment_outbox_approvals"
           SET state = 'EXPIRED',
               version = version + 1,
               updated_at = now()
           WHERE outbox_id = $1
             AND version = $2
             AND state = $3
           RETURNING version`,
          [outboxId, approval.version, approval.state],
        ),
      );

      const changedMessage = returnedRows(
        await em.query(
          `UPDATE "recruitment_messages"
           SET metadata = coalesce(metadata, '{}'::jsonb) ||
             jsonb_build_object('delivery', 'SUPPRESSED_APPROVAL_EXPIRED')
           WHERE id = $1 RETURNING id`,
          [outbox.recruitment_message_id],
        ),
      );

      if (
        changedOutbox.length !== 1 ||
        changedApproval.length !== 1 ||
        changedMessage.length !== 1
      ) {
        throw new Error('P32_EXPIRY_UPDATE_FAILED');
      }

      await em.query(
        `INSERT INTO "recruitment_outbox_approval_events"
           (outbox_id, version, action, reason)
         VALUES ($1, $2, 'EXPIRED', $3)`,
        [outboxId, changedApproval[0].version, reason],
      );

      await this.audit.recordMandatory(em, {
        actor: SYSTEM_ACTOR,
        action: 'OUTBOX_APPROVAL_EXPIRE',
        entity: 'channel-outbox',
        entityId: outboxId,
        before: {
          status: outbox.status,
          approvalState: approval.state,
          approvalVersion: approval.version,
        },
        after: {
          status: 'SUPPRESSED',
          approvalState: 'EXPIRED',
          approvalVersion: changedApproval[0].version,
        },
        context: { reason },
      });

      return true;
    });
  }
}

function errorText(error: unknown): string {
  const code =
    error instanceof Error ? error.message.split('\n')[0] : 'UNKNOWN';
  return code.slice(0, 120);
}
