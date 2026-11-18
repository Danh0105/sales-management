import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Paginated } from '../dto/common.dto';
import type {
  ApprovalListQueryDto,
  ApprovalView,
  ConversationListQueryDto,
} from '../dto/hr-console.dto';
import { likePattern } from '../recruitment.views';

/**
 * Đọc dữ liệu cho giao diện Nhân sự (hội thoại Zalo, hàng đợi duyệt tin AI, tổng quan).
 * Chỉ đọc; mọi thao tác (duyệt / sửa-duyệt / từ chối / tiếp quản / dừng khẩn) dùng API sẵn có
 * của p32 + P3-6. Không trả id Zalo thô, token hay secret; nội dung tin chỉ trả cho role xem
 * tuyển dụng (guard ở controller).
 */

/** Điều kiện SQL cố định theo nhóm — không ghép chuỗi từ input. */
const APPROVAL_VIEW_SQL: Record<ApprovalView, string> = {
  pending: `o.status = 'AWAITING_APPROVAL'`,
  approved: `ap.state = 'APPROVED' AND o.status IN ('PENDING', 'SENDING', 'RETRY')`,
  sent: `o.status = 'SENT'`,
  rejected: `ap.state IN ('REJECTED', 'REVOKED', 'EXPIRED')`,
  failed: `o.status IN ('UNKNOWN', 'DEAD_LETTER')`,
  all: `TRUE`,
};

const APPROVAL_SELECT = `
  SELECT o.id AS "outboxId", o.status, o.created_at AS "createdAt", o.sent_at AS "sentAt",
         o.dispatched_at AS "dispatchedAt", o.last_error_code AS "lastErrorCode",
         o.attempt_count AS "attemptCount",
         ap.state AS "approvalState", ap.version AS "approvalVersion",
         ap.approved_at AS "approvedAt", ap.expires_at AS "expiresAt",
         ap.approved_by AS "approvedById", ea.name AS "approvedByName",
         ap.rejected_at AS "rejectedAt", ap.rejected_by AS "rejectedById",
         er.name AS "rejectedByName", ap.rejection_reason AS "rejectionReason",
         m.id AS "messageId", m.content AS "messageText", m.created_at AS "draftedAt",
         c.id AS "conversationId", c.control_mode AS "controlMode", c.status AS "conversationStatus",
         cand.id AS "candidateId", cand.full_name AS "candidateName",
         a.id AS "applicationId", a.status AS "applicationStatus", j.title AS "jobTitle"
  FROM "recruitment_channel_outbox" o
  JOIN "recruitment_messages" m ON m.id = o.recruitment_message_id
  JOIN "recruitment_conversations" c ON c.id = m.conversation_id
  JOIN "recruitment_candidates" cand ON cand.id = c.candidate_id
  LEFT JOIN "recruitment_applications" a ON a.id = c.application_id
  LEFT JOIN "recruitment_jobs" j ON j.id = a.job_id
  LEFT JOIN "recruitment_outbox_approvals" ap ON ap.outbox_id = o.id
  LEFT JOIN "employee" ea ON ea.id = ap.approved_by
  LEFT JOIN "employee" er ON er.id = ap.rejected_by`;

const MESSAGE_SELECT = `
  SELECT m.id, m.sender_type AS "senderType", m.direction, m.content,
         m.content_type AS "contentType", m.created_at AS "createdAt",
         m.author_employee_id AS "authorId", e.name AS "authorName",
         m.metadata->>'delivery' AS "delivery",
         o.id AS "outboxId", o.status AS "outboxStatus", o.last_error_code AS "outboxError",
         o.sent_at AS "sentAt", ap.state AS "approvalState"
  FROM "recruitment_messages" m
  LEFT JOIN "employee" e ON e.id = m.author_employee_id
  LEFT JOIN "recruitment_channel_outbox" o ON o.recruitment_message_id = m.id
  LEFT JOIN "recruitment_outbox_approvals" ap ON ap.outbox_id = o.id`;

type Row = Record<string, unknown>;

@Injectable()
export class RecruitmentHrConsoleService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listConversations(
    query: ConversationListQueryDto,
  ): Promise<Paginated<Row>> {
    const { page, limit } = query;
    const keyword = query.keyword ? likePattern(query.keyword) : null;
    const params = [
      keyword,
      query.mode ?? null,
      query.pendingOnly === true,
      query.candidateId ?? null,
    ];
    const where = `
      WHERE ($1::text IS NULL OR cand.full_name ILIKE $1 OR cand.phone ILIKE $1)
        AND ($2::text IS NULL OR c.control_mode::text = $2)
        AND ($3::boolean IS NOT TRUE OR coalesce(pa.n, 0) > 0)
        AND ($4::int IS NULL OR c.candidate_id = $4)`;
    const from = `
      FROM "recruitment_conversations" c
      JOIN "recruitment_candidates" cand ON cand.id = c.candidate_id
      LEFT JOIN "recruitment_applications" a ON a.id = c.application_id
      LEFT JOIN "recruitment_jobs" j ON j.id = a.job_id
      LEFT JOIN LATERAL (
        SELECT m.sender_type, m.content, m.created_at
        FROM "recruitment_messages" m WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1) lm ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM "recruitment_channel_outbox" o
        JOIN "recruitment_messages" m2 ON m2.id = o.recruitment_message_id
        WHERE m2.conversation_id = c.id AND o.status = 'AWAITING_APPROVAL') pa ON TRUE`;
    const [rows, [count]] = await Promise.all([
      this.dataSource.query<Row[]>(
        `SELECT c.id, c.channel, c.status, c.control_mode AS "controlMode",
                c.last_message_at AS "lastMessageAt", c.created_at AS "createdAt",
                c.candidate_id AS "candidateId", cand.full_name AS "candidateName",
                cand.phone AS "candidatePhone", c.application_id AS "applicationId",
                a.status AS "applicationStatus", a.ai_paused AS "aiPaused", j.title AS "jobTitle",
                lm.sender_type AS "lastSenderType", left(lm.content, 160) AS "lastMessagePreview",
                coalesce(pa.n, 0)::int AS "pendingApprovals"
         ${from} ${where}
         ORDER BY coalesce(c.last_message_at, c.created_at) DESC, c.id DESC
         LIMIT $5 OFFSET $6`,
        [...params, limit, (page - 1) * limit],
      ),
      this.dataSource.query<Array<{ total: number }>>(
        `SELECT count(*)::int AS total ${from} ${where}`,
        params,
      ),
    ]);
    return { data: rows, total: Number(count?.total ?? 0), page, limit };
  }

  async conversationMessages(conversationId: number, limit = 200) {
    const [conversation] = await this.dataSource.query<Row[]>(
      `SELECT c.id, c.status, c.control_mode AS "controlMode", c.control_version AS "controlVersion",
              c.candidate_id AS "candidateId", cand.full_name AS "candidateName",
              cand.phone AS "candidatePhone", c.application_id AS "applicationId",
              a.status AS "applicationStatus", a.ai_paused AS "aiPaused", j.title AS "jobTitle",
              c.taken_over_by AS "takenOverById", e.name AS "takenOverByName"
       FROM "recruitment_conversations" c
       JOIN "recruitment_candidates" cand ON cand.id = c.candidate_id
       LEFT JOIN "recruitment_applications" a ON a.id = c.application_id
       LEFT JOIN "recruitment_jobs" j ON j.id = a.job_id
       LEFT JOIN "employee" e ON e.id = c.taken_over_by
       WHERE c.id = $1`,
      [conversationId],
    );
    if (!conversation) {
      throw new NotFoundException({
        code: 'CONVERSATION_NOT_FOUND',
        message: `Không tìm thấy hội thoại #${conversationId}`,
      });
    }
    const messages = await this.dataSource.query<Row[]>(
      `SELECT * FROM (${MESSAGE_SELECT}
         WHERE m.conversation_id = $1
         ORDER BY m.created_at DESC, m.id DESC LIMIT $2) t
       ORDER BY "createdAt", id`,
      [conversationId, Math.min(Math.max(limit, 1), 500)],
    );
    return { conversation, messages };
  }

  async listApprovals(query: ApprovalListQueryDto): Promise<Paginated<Row>> {
    const { page, limit } = query;
    const view: ApprovalView = query.view ?? 'pending';
    const where = `WHERE o.source_type = 'AI_REPLY' AND (${APPROVAL_VIEW_SQL[view]})`;
    // Chờ duyệt: cũ nhất trước (đúng thứ tự gửi theo người nhận); nhóm khác: mới nhất trước.
    const order =
      view === 'pending'
        ? 'o.created_at ASC, o.id ASC'
        : 'o.updated_at DESC, o.id DESC';
    const [rows, [count]] = await Promise.all([
      this.dataSource.query<Row[]>(
        `${APPROVAL_SELECT} ${where} ORDER BY ${order} LIMIT $1 OFFSET $2`,
        [limit, (page - 1) * limit],
      ),
      this.dataSource.query<Array<{ total: number }>>(
        `SELECT count(*)::int AS total
         FROM "recruitment_channel_outbox" o
         LEFT JOIN "recruitment_outbox_approvals" ap ON ap.outbox_id = o.id
         ${where}`,
      ),
    ]);
    return { data: rows, total: Number(count?.total ?? 0), page, limit };
  }

  async approvalDetail(outboxId: number) {
    const [item] = await this.dataSource.query<Row[]>(
      `${APPROVAL_SELECT} WHERE o.id = $1 AND o.source_type = 'AI_REPLY'`,
      [outboxId],
    );
    if (!item) {
      throw new NotFoundException({
        code: 'AI_OUTBOX_NOT_FOUND',
        message: `Không tìm thấy tin AI #${outboxId}`,
      });
    }
    const [events, context] = await Promise.all([
      this.dataSource.query<Row[]>(
        `SELECT ev.id, ev.version, ev.action, ev.actor_employee_id AS "actorId",
                e.name AS "actorName", ev.reason, ev.created_at AS "createdAt",
                (ev.previous_sha256 IS NOT NULL) AS "edited"
         FROM "recruitment_outbox_approval_events" ev
         LEFT JOIN "employee" e ON e.id = ev.actor_employee_id
         WHERE ev.outbox_id = $1 ORDER BY ev.id`,
        [outboxId],
      ),
      // Ngữ cảnh: tối đa 12 tin trước (và gồm) bản nháp này.
      this.dataSource.query<Row[]>(
        `SELECT * FROM (${MESSAGE_SELECT}
           WHERE m.conversation_id = $1 AND m.id <= $2
           ORDER BY m.created_at DESC, m.id DESC LIMIT 12) t
         ORDER BY "createdAt", id`,
        [item.conversationId, item.messageId],
      ),
    ]);
    return { ...item, events, context };
  }

  async overview() {
    const [counts] = await this.dataSource.query<Row[]>(
      `SELECT
         (SELECT count(*) FROM "recruitment_candidates" WHERE deletion_requested_at IS NULL)::int AS candidates,
         (SELECT count(*) FROM "recruitment_conversations" WHERE status = 'ACTIVE')::int AS "activeConversations",
         (SELECT count(*) FROM "recruitment_conversations"
            WHERE status = 'ACTIVE' AND control_mode = 'HUMAN_TAKEOVER')::int AS "humanConversations",
         (SELECT count(*) FROM "recruitment_channel_outbox"
            WHERE source_type = 'AI_REPLY' AND status = 'AWAITING_APPROVAL')::int AS "awaitingApproval",
         (SELECT count(*) FROM "recruitment_channel_outbox" o JOIN "recruitment_outbox_approvals" ap ON ap.outbox_id = o.id
            WHERE ap.state = 'APPROVED' AND o.status IN ('PENDING', 'SENDING', 'RETRY'))::int AS "approvedWaitingSend",
         (SELECT count(*) FROM "recruitment_outbox_approvals" WHERE state = 'APPROVED')::int AS approved,
         (SELECT count(*) FROM "recruitment_outbox_approvals" WHERE state = 'REJECTED')::int AS rejected,
         (SELECT count(*) FROM "recruitment_outbox_approvals" WHERE state IN ('REVOKED', 'EXPIRED'))::int AS "revokedOrExpired",
         (SELECT count(*) FROM "recruitment_channel_outbox" WHERE status = 'SENT')::int AS sent,
         (SELECT count(*) FROM "recruitment_channel_outbox" WHERE status = 'UNKNOWN')::int AS "sendUnknown",
         (SELECT count(*) FROM "recruitment_channel_outbox" WHERE status = 'DEAD_LETTER')::int AS "sendFailed",
         (SELECT count(*) FROM "recruitment_channel_outbox" WHERE status = 'RETRY')::int AS "sendRetrying",
         (SELECT count(*) FROM "recruitment_channel_events" WHERE status IN ('RECEIVED', 'PROCESSING'))::int AS "inboxPending",
         (SELECT count(*) FROM "recruitment_channel_events" WHERE status = 'FAILED')::int AS "inboxFailed",
         (SELECT count(*) FROM "recruitment_hr_alerts" WHERE status = 'OPEN')::int AS "openAlerts"`,
    );
    // Hoạt động gần đây: chỉ dòng audit nghiệp vụ tuyển dụng (hành động + đối tượng), không body.
    const recent = await this.dataSource.query<Row[]>(
      `SELECT id, "createdAt", "actorId", "actorName", method AS action, path
       FROM "activity_log"
       WHERE path LIKE '/recruitment-%' AND method !~ '^(GET|POST|PUT|PATCH|DELETE)$'
       ORDER BY id DESC LIMIT 15`,
    );
    return { counts, recent };
  }
}
