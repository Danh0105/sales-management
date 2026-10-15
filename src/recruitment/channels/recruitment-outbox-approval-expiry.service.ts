import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import { RecruitmentActorType } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { returnedRows } from './recruitment-channel-event.queue';

const SYSTEM_ACTOR: RecruitmentActor = {
  type: RecruitmentActorType.SYSTEM,
  employeeId: null,
  name: 'Recruitment Approval Expiry',
  roles: [],
};

@Injectable()
export class RecruitmentOutboxApprovalExpiryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: RecruitmentAuditService,
  ) {}

  // Chưa có Cron: chỉ gọi chủ động trong integration test.
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
