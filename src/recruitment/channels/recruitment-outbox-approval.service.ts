import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import { RecruitmentActorType } from '../recruitment.enums';
import {
  RECRUITMENT_OPERATIONS_ROLES,
  type RecruitmentActor,
} from '../recruitment.roles';

import { returnedRows } from './recruitment-channel-event.queue';
import { normalizeMessageText } from './zalo-recruitment-event';

const APPROVAL_TTL_MINUTES = 30;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RecruitmentOutboxApprovalService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: RecruitmentAuditService,
  ) {}

  async approve(
    outboxId: number,
    requestId: string,
    actor: RecruitmentActor,
  ) {
    const allowedRoles: readonly string[] = RECRUITMENT_OPERATIONS_ROLES;

    if (
      actor.type !== RecruitmentActorType.HR ||
      !actor.employeeId ||
      !actor.roles?.some((role) => allowedRoles.includes(role))
    ) {
      throw new ForbiddenException('RECRUITMENT_APPROVAL_FORBIDDEN');
    }

    if (!Number.isSafeInteger(outboxId) || outboxId <= 0) {
      throw new BadRequestException('OUTBOX_ID_INVALID');
    }

    if (!UUID_PATTERN.test(requestId ?? '')) {
      throw new BadRequestException('APPROVAL_REQUEST_ID_INVALID');
    }

    return this.dataSource.transaction(async (em) => {
      // Locate conversation without locking outbox first.
      const [target] = await em.query(
        `SELECT m.conversation_id
         FROM "recruitment_channel_outbox" o
         JOIN "recruitment_messages" m
           ON m.id = o.recruitment_message_id
         WHERE o.id = $1
           AND o.source_type = 'AI_REPLY'`,
        [outboxId],
      );

      if (!target) {
        throw new NotFoundException('AI_OUTBOX_NOT_FOUND');
      }

      // Lock order: conversation -> outbox -> approval -> message.
      const [conversation] = await em.query(
        `SELECT id, status, control_mode, control_version
         FROM "recruitment_conversations"
         WHERE id = $1
         FOR UPDATE`,
        [target.conversation_id],
      );

      const [outbox] = await em.query(
        `SELECT id, status, source_type, channel,
                channel_account_id, external_recipient_id,
                recruitment_message_id, control_version,
                message_text, dispatched_at
         FROM "recruitment_channel_outbox"
         WHERE id = $1
         FOR UPDATE`,
        [outboxId],
      );

      const [approval] = await em.query(
        `SELECT outbox_id, state, version
         FROM "recruitment_outbox_approvals"
         WHERE outbox_id = $1
         FOR UPDATE`,
        [outboxId],
      );

      if (!outbox || !approval) {
        throw new ConflictException('APPROVAL_RECORD_MISSING');
      }

      const [message] = await em.query(
        `SELECT id, conversation_id, content,
                sender_type, direction
         FROM "recruitment_messages"
         WHERE id = $1
         FOR UPDATE`,
        [outbox.recruitment_message_id],
      );

      // Same requestId must never create a second decision.
      const [existing] = await em.query(
        `SELECT outbox_id, action, actor_employee_id
         FROM "recruitment_outbox_approval_events"
         WHERE request_id = $1::uuid`,
        [requestId],
      );

      if (existing) {
        if (
          Number(existing.outbox_id) !== outboxId ||
          existing.action !== 'APPROVED' ||
          Number(existing.actor_employee_id) !== actor.employeeId
        ) {
          throw new ConflictException('APPROVAL_REQUEST_ID_REUSED');
        }

        return {
          outboxId,
          approved: true,
          idempotent: true,
        };
      }

      const configuredOa = this.config.get<string>(
        'RECRUITMENT_ZALO_OA_ID',
      );

      if (
        !conversation ||
        conversation.status !== 'ACTIVE' ||
        conversation.control_mode !== 'AI_ACTIVE' ||
        Number(conversation.control_version) !==
          Number(outbox.control_version) ||
        outbox.status !== 'AWAITING_APPROVAL' ||
        outbox.source_type !== 'AI_REPLY' ||
        outbox.channel !== 'ZALO' ||
        !configuredOa ||
        outbox.channel_account_id !== configuredOa ||
        !outbox.external_recipient_id ||
        outbox.dispatched_at !== null ||
        approval.state !== 'AWAITING_APPROVAL' ||
        !message ||
        Number(message.conversation_id) !==
          Number(conversation.id) ||
        message.sender_type !== 'AI' ||
        message.direction !== 'OUTBOUND' ||
        typeof message.content !== 'string' ||
        !message.content.trim() ||
        message.content !== outbox.message_text
      ) {
        throw new ConflictException('APPROVAL_PRECONDITION_FAILED');
      }

      const hash = createHash('sha256')
        .update(message.content, 'utf8')
        .digest('hex');

      const nextVersion = Number(approval.version) + 1;

      const approvalUpdated = await em.query(
        `UPDATE "recruitment_outbox_approvals"
         SET state = 'APPROVED',
             version = $2,
             approved_by = $3,
             approved_at = now(),
             expires_at =
               now() + $4::int * interval '1 minute',
             approved_text_sha256 = $5,
             approved_oa_id = $6,
             approved_recipient_id = $7,
             approved_control_version = $8,
             approved_message_id = $9,
             updated_at = now()
         WHERE outbox_id = $1 AND state = 'AWAITING_APPROVAL'
         RETURNING outbox_id`,
        [
          outboxId,
          nextVersion,
          actor.employeeId,
          APPROVAL_TTL_MINUTES,
          hash,
          outbox.channel_account_id,
          outbox.external_recipient_id,
          outbox.control_version,
          outbox.recruitment_message_id,
        ],
      );

      const outboxUpdated = await em.query(
        `UPDATE "recruitment_channel_outbox"
         SET status = 'PENDING',
             updated_at = now()
         WHERE id = $1
           AND status = 'AWAITING_APPROVAL'
           AND dispatched_at IS NULL
         RETURNING id`,
        [outboxId],
      );

      if (
        returnedRows(approvalUpdated).length !== 1 ||
        returnedRows(outboxUpdated).length !== 1
      ) {
        throw new ConflictException('APPROVAL_UPDATE_FAILED');
      }

      await em.query(
        `INSERT INTO "recruitment_outbox_approval_events"
           (outbox_id, version, action,
            actor_employee_id, request_id, current_sha256)
         VALUES ($1, $2, 'APPROVED', $3, $4::uuid, $5)`,
        [
          outboxId,
          nextVersion,
          actor.employeeId,
          requestId,
          hash,
        ],
      );

      // No message content or candidate PII in activity_log.
      await this.audit.recordMandatory(em, {
        actor,
        action: 'OUTBOX_APPROVE',
        entity: 'channel-outbox',
        entityId: outboxId,
        before: {
          status: 'AWAITING_APPROVAL',
          version: approval.version,
        },
        after: {
          status: 'PENDING',
          version: nextVersion,
          approvedTextSha256: hash,
        },
        context: {
          requestId,
          approvalTtlMinutes: APPROVAL_TTL_MINUTES,
        },
      });

      return {
        outboxId,
        approved: true,
        idempotent: false,
        approvalVersion: nextVersion,
        status: 'PENDING',
      };
    });
  }

  async reject(
    outboxId: number,
    reason: string,
    requestId: string,
    actor: RecruitmentActor,
  ) {
    const allowedRoles: readonly string[] = RECRUITMENT_OPERATIONS_ROLES;

    if (
      actor.type !== RecruitmentActorType.HR ||
      !actor.employeeId ||
      !actor.roles?.some((role) => allowedRoles.includes(role))
    ) {
      throw new ForbiddenException('RECRUITMENT_APPROVAL_FORBIDDEN');
    }

    if (!Number.isSafeInteger(outboxId) || outboxId <= 0) {
      throw new BadRequestException('OUTBOX_ID_INVALID');
    }

    if (!UUID_PATTERN.test(requestId ?? '')) {
      throw new BadRequestException('APPROVAL_REQUEST_ID_INVALID');
    }

    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (!cleanReason || cleanReason.length > 500) {
      throw new BadRequestException('REJECTION_REASON_INVALID');
    }

    return this.dataSource.transaction(async (em) => {
      const [target] = await em.query(
        `SELECT m.conversation_id
         FROM "recruitment_channel_outbox" o
         JOIN "recruitment_messages" m
           ON m.id = o.recruitment_message_id
         WHERE o.id = $1 AND o.source_type = 'AI_REPLY'`,
        [outboxId],
      );

      if (!target) throw new NotFoundException('AI_OUTBOX_NOT_FOUND');

      // Consistent lock order: conversation -> outbox -> approval -> message.
      const [conversation] = await em.query(
        `SELECT id FROM "recruitment_conversations"
         WHERE id = $1 FOR UPDATE`,
        [target.conversation_id],
      );

      const [outbox] = await em.query(
        `SELECT id, status, source_type, recruitment_message_id,
                dispatched_at
         FROM "recruitment_channel_outbox"
         WHERE id = $1 FOR UPDATE`,
        [outboxId],
      );

      const [approval] = await em.query(
        `SELECT outbox_id, state, version
         FROM "recruitment_outbox_approvals"
         WHERE outbox_id = $1 FOR UPDATE`,
        [outboxId],
      );

      if (!conversation || !outbox || !approval) {
        throw new ConflictException('APPROVAL_RECORD_MISSING');
      }

      const [message] = await em.query(
        `SELECT id, conversation_id, sender_type, direction
         FROM "recruitment_messages"
         WHERE id = $1 FOR UPDATE`,
        [outbox.recruitment_message_id],
      );

      const [existing] = await em.query(
        `SELECT outbox_id, action, actor_employee_id, reason
         FROM "recruitment_outbox_approval_events"
         WHERE request_id = $1::uuid`,
        [requestId],
      );

      if (existing) {
        if (
          Number(existing.outbox_id) !== outboxId ||
          existing.action !== 'REJECTED' ||
          Number(existing.actor_employee_id) !== actor.employeeId ||
          existing.reason !== cleanReason
        ) {
          throw new ConflictException('APPROVAL_REQUEST_ID_REUSED');
        }

        return { outboxId, rejected: true, idempotent: true };
      }

      if (
        outbox.status !== 'AWAITING_APPROVAL' ||
        outbox.source_type !== 'AI_REPLY' ||
        outbox.dispatched_at !== null ||
        approval.state !== 'AWAITING_APPROVAL' ||
        !message ||
        Number(message.conversation_id) !== Number(conversation.id) ||
        message.sender_type !== 'AI' ||
        message.direction !== 'OUTBOUND'
      ) {
        throw new ConflictException('REJECTION_PRECONDITION_FAILED');
      }

      const nextVersion = Number(approval.version) + 1;

      const rejectOutboxUpdated = returnedRows(
        await em.query(
        `UPDATE "recruitment_channel_outbox"
         SET status = 'SUPPRESSED',
             message_text = NULL,
             text_redacted_at = now(),
             last_error_code = 'HR_REJECTED',
             lease_until = NULL,
             next_attempt_at = NULL,
             updated_at = now()
         WHERE id = $1
           AND status = 'AWAITING_APPROVAL'
           AND dispatched_at IS NULL
           AND source_type = 'AI_REPLY'
         RETURNING id`,
        [outboxId],
        ),
      );

      const rejectApprovalUpdated = returnedRows(
        await em.query(
        `UPDATE "recruitment_outbox_approvals"
         SET state = 'REJECTED',
             version = $2,
             rejected_by = $3,
             rejected_at = now(),
             rejection_reason = $4,
             updated_at = now()
         WHERE outbox_id = $1
           AND state = 'AWAITING_APPROVAL'
         RETURNING outbox_id`,
        [outboxId, nextVersion, actor.employeeId, cleanReason],
        ),
      );

      const rejectMessageUpdated = returnedRows(
        await em.query(
        `UPDATE "recruitment_messages"
         SET metadata = metadata ||
             jsonb_build_object('delivery', 'SUPPRESSED_HR_REJECTED')
         WHERE id = $1
         RETURNING id`,
        [outbox.recruitment_message_id],
        ),
      );

      if (
        rejectOutboxUpdated.length !== 1 ||
        rejectApprovalUpdated.length !== 1 ||
        rejectMessageUpdated.length !== 1
      ) {
        throw new ConflictException('REJECTION_UPDATE_FAILED');
      }

      await em.query(
        `INSERT INTO "recruitment_outbox_approval_events"
           (outbox_id, version, action, actor_employee_id,
            request_id, reason)
         VALUES ($1, $2, 'REJECTED', $3, $4::uuid, $5)`,
        [outboxId, nextVersion, actor.employeeId, requestId, cleanReason],
      );

      await this.audit.recordMandatory(em, {
        actor,
        action: 'OUTBOX_REJECT',
        entity: 'channel-outbox',
        entityId: outboxId,
        before: {
          status: 'AWAITING_APPROVAL',
          version: approval.version,
        },
        after: {
          status: 'SUPPRESSED',
          version: nextVersion,
        },
        context: { requestId },
      });

      return {
        outboxId,
        rejected: true,
        idempotent: false,
        status: 'SUPPRESSED',
        approvalVersion: nextVersion,
      };
    });
  }

  async editAndApprove(
    outboxId: number,
    text: string,
    requestId: string,
    actor: RecruitmentActor,
  ) {
    const allowedRoles: readonly string[] = RECRUITMENT_OPERATIONS_ROLES;

    if (
      actor.type !== RecruitmentActorType.HR ||
      !actor.employeeId ||
      !actor.roles?.some((role) => allowedRoles.includes(role))
    ) {
      throw new ForbiddenException('RECRUITMENT_APPROVAL_FORBIDDEN');
    }

    if (!Number.isSafeInteger(outboxId) || outboxId <= 0) {
      throw new BadRequestException('OUTBOX_ID_INVALID');
    }

    if (!UUID_PATTERN.test(requestId ?? '')) {
      throw new BadRequestException('APPROVAL_REQUEST_ID_INVALID');
    }

    if (typeof text !== 'string') {
      throw new BadRequestException('APPROVAL_TEXT_INVALID');
    }

    const normalized = normalizeMessageText(text);

    const configuredLimit = Number(
      this.config.get<string>('RECRUITMENT_ZALO_MAX_TEXT_LENGTH') ?? '2000',
    );

    if (
      !Number.isInteger(configuredLimit) ||
      configuredLimit < 1 ||
      configuredLimit > 10000
    ) {
      throw new ConflictException('ZALO_TEXT_LIMIT_INVALID');
    }

    // HR messages max 2000; Zalo configuration may be more restrictive.
    const maxLength = Math.min(2000, configuredLimit);
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException('APPROVAL_TEXT_LENGTH_INVALID');
    }

    const nextHash = createHash('sha256')
      .update(normalized, 'utf8')
      .digest('hex');

    return this.dataSource.transaction(async (em) => {
      const [target] = await em.query(
        `SELECT m.conversation_id
         FROM "recruitment_channel_outbox" o
         JOIN "recruitment_messages" m
           ON m.id = o.recruitment_message_id
         WHERE o.id = $1 AND o.source_type = 'AI_REPLY'`,
        [outboxId],
      );

      if (!target) {
        throw new NotFoundException('AI_OUTBOX_NOT_FOUND');
      }

      // Lock order: conversation -> outbox -> approval -> canonical.
      const [conversation] = await em.query(
        `SELECT id, status, control_mode, control_version
         FROM "recruitment_conversations"
         WHERE id = $1 FOR UPDATE`,
        [target.conversation_id],
      );

      const [outbox] = await em.query(
        `SELECT id, status, source_type, channel,
                channel_account_id, external_recipient_id,
                recruitment_message_id, control_version,
                message_text, dispatched_at
         FROM "recruitment_channel_outbox"
         WHERE id = $1 FOR UPDATE`,
        [outboxId],
      );

      const [approval] = await em.query(
        `SELECT outbox_id, state, version
         FROM "recruitment_outbox_approvals"
         WHERE outbox_id = $1 FOR UPDATE`,
        [outboxId],
      );

      if (!conversation || !outbox || !approval) {
        throw new ConflictException('APPROVAL_RECORD_MISSING');
      }

      const [message] = await em.query(
        `SELECT id, conversation_id, content, sender_type, direction
         FROM "recruitment_messages"
         WHERE id = $1 FOR UPDATE`,
        [outbox.recruitment_message_id],
      );

      const [existing] = await em.query(
        `SELECT outbox_id, action, actor_employee_id, current_sha256
         FROM "recruitment_outbox_approval_events"
         WHERE request_id = $1::uuid`,
        [requestId],
      );

      // Idempotent only for the same actor, operation, and edited payload.
      if (existing) {
        if (
          Number(existing.outbox_id) !== outboxId ||
          existing.action !== 'EDITED_AND_APPROVED' ||
          Number(existing.actor_employee_id) !== actor.employeeId ||
          existing.current_sha256 !== nextHash
        ) {
          throw new ConflictException('APPROVAL_REQUEST_ID_REUSED');
        }

        return { outboxId, approved: true, idempotent: true };
      }

      const configuredOa = this.config.get<string>(
        'RECRUITMENT_ZALO_OA_ID',
      );

      if (
        conversation.status !== 'ACTIVE' ||
        conversation.control_mode !== 'AI_ACTIVE' ||
        Number(conversation.control_version) !== Number(outbox.control_version) ||
        outbox.status !== 'AWAITING_APPROVAL' ||
        outbox.source_type !== 'AI_REPLY' ||
        outbox.channel !== 'ZALO' ||
        !configuredOa ||
        outbox.channel_account_id !== configuredOa ||
        !outbox.external_recipient_id ||
        outbox.dispatched_at !== null ||
        approval.state !== 'AWAITING_APPROVAL' ||
        !message ||
        Number(message.conversation_id) !== Number(conversation.id) ||
        message.sender_type !== 'AI' ||
        message.direction !== 'OUTBOUND' ||
        typeof message.content !== 'string' ||
        !message.content.trim() ||
        message.content !== outbox.message_text
      ) {
        throw new ConflictException('EDIT_APPROVAL_PRECONDITION_FAILED');
      }

      if (normalized === message.content) {
        throw new BadRequestException('EDITED_TEXT_UNCHANGED_USE_APPROVE');
      }

      const previousHash = createHash('sha256')
        .update(message.content, 'utf8')
        .digest('hex');

      const nextVersion = Number(approval.version) + 1;

      const changedMessage = returnedRows<{ id: number }>(
        await em.query(
          `UPDATE "recruitment_messages"
           SET content = $2
           WHERE id = $1
           RETURNING id`,
          [message.id, normalized],
        ),
      );

      const changedOutbox = returnedRows<{ id: number }>(
        await em.query(
          `UPDATE "recruitment_channel_outbox"
           SET message_text = $2, status = 'PENDING', updated_at = now()
           WHERE id = $1 AND status = 'AWAITING_APPROVAL'
             AND dispatched_at IS NULL
           RETURNING id`,
          [outboxId, normalized],
        ),
      );

      const changedApproval = returnedRows<{ outbox_id: number }>(
        await em.query(
          `UPDATE "recruitment_outbox_approvals"
           SET state = 'APPROVED', version = $2,
               approved_by = $3, approved_at = now(),
               expires_at = now() + $4::int * interval '1 minute',
               approved_text_sha256 = $5,
               approved_oa_id = $6,
               approved_recipient_id = $7,
               approved_control_version = $8,
               approved_message_id = $9,
               updated_at = now()
           WHERE outbox_id = $1 AND state = 'AWAITING_APPROVAL'
           RETURNING outbox_id`,
          [
            outboxId, nextVersion, actor.employeeId,
            APPROVAL_TTL_MINUTES, nextHash,
            outbox.channel_account_id,
            outbox.external_recipient_id,
            outbox.control_version,
            outbox.recruitment_message_id,
          ],
        ),
      );

      if (
        changedMessage.length !== 1 ||
        changedOutbox.length !== 1 ||
        changedApproval.length !== 1
      ) {
        throw new ConflictException('EDIT_APPROVAL_UPDATE_FAILED');
      }

      await em.query(
        `INSERT INTO "recruitment_outbox_approval_events"
           (outbox_id, version, action, actor_employee_id,
            request_id, previous_sha256, current_sha256)
         VALUES ($1, $2, 'EDITED_AND_APPROVED', $3, $4::uuid, $5, $6)`,
        [
          outboxId, nextVersion, actor.employeeId,
          requestId, previousHash, nextHash,
        ],
      );

      // Mandatory audit: hashes only, never original or edited text.
      await this.audit.recordMandatory(em, {
        actor,
        action: 'OUTBOX_EDIT_AND_APPROVE',
        entity: 'channel-outbox',
        entityId: outboxId,
        before: {
          status: 'AWAITING_APPROVAL',
          version: approval.version,
          textSha256: previousHash,
        },
        after: {
          status: 'PENDING',
          version: nextVersion,
          textSha256: nextHash,
        },
        context: { requestId },
      });

      return {
        outboxId,
        approved: true,
        edited: true,
        idempotent: false,
        approvalVersion: nextVersion,
        status: 'PENDING',
      };
    });
  }
}
