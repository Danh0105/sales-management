import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  ApplicationStatus,
  ConversationControlMode,
  ConversationControlState,
  TERMINAL_APPLICATION_STATUSES,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { RecruitmentApplicationService } from '../services/recruitment-application.service';
import { normalizeMessageText } from './zalo-recruitment-event';

/** Giới hạn ký tự tin HR gửi (bằng giới hạn tin văn bản của sender Zalo). */
export const HR_MESSAGE_MAX_LENGTH = 2000;
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ZALO_CONVERSATION = /^([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,100})$/;

export interface ConversationControl {
  conversationId: number;
  candidateId: number;
  state: ConversationControlState;
  mode: ConversationControlMode;
  version: number;
  /** Vì sao AI đang tạm dừng (khi `AI_PAUSED`). */
  pausedBy: Array<
    'HANDOFF_OPEN' | 'APPLICATION_PAUSED' | 'CANDIDATE_AI_STOPPED'
  >;
  resumeSignalPending: boolean;
  takenOverBy: number | null;
}

interface ControlRow {
  id: number;
  candidate_id: number;
  status: string;
  control_mode: ConversationControlMode;
  control_version: number;
  resume_signal_pending: boolean;
  taken_over_by: number | null;
  channel: string;
  external_conversation_id: string | null;
  ai_stopped: boolean;
  app_paused: boolean;
  handoff_open: boolean;
}

/**
 * Điều khiển hội thoại kênh (P3-6): AI_ACTIVE / AI_PAUSED / HUMAN_TAKEOVER / CLOSED.
 *
 * Nguồn sự thật:
 * - `control_mode` của hội thoại — chỉ HR đổi, bằng các thao tác ở đây;
 * - handoff đang mở, hồ sơ `aiPaused`/`NEEDS_HR_REVIEW`, ứng viên dừng AI — có từ
 *   Phase 1 → suy ra `AI_PAUSED`, không lưu trùng.
 *
 * Mọi thao tác khoá dòng hội thoại (`FOR UPDATE`) và tăng `control_version`; worker
 * so version trong transaction ghi kết quả nên câu trả lời AI của lượt đang chạy
 * khi HR tiếp quản bị bỏ, không bao giờ được gửi.
 */
@Injectable()
export class RecruitmentConversationControlService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly applications: RecruitmentApplicationService,
    private readonly audit: RecruitmentAuditService,
    private readonly config: ConfigService,
  ) {}

  async control(
    conversationId: number,
    em?: EntityManager,
    lock = false,
  ): Promise<ConversationControl> {
    const row = await this.load(
      conversationId,
      em ?? this.dataSource.manager,
      lock,
    );
    return this.toControl(row);
  }

  async takeover(conversationId: number, actor: RecruitmentActor) {
    const result = await this.dataSource.transaction(async (em) => {
      const row = await this.load(conversationId, em, true);
      if (row.control_mode === ConversationControlMode.HUMAN_TAKEOVER) {
        return { control: this.toControl(row), changed: false };
      }
      await this.setMode(
        em,
        row,
        ConversationControlMode.HUMAN_TAKEOVER,
        actor,
      );
      return { control: await this.control(conversationId, em), changed: true };
    });
    if (result.changed) {
      await this.record(actor, 'CONVERSATION_TAKEOVER', conversationId, {
        version: result.control.version,
      });
    }
    return { ...result.control, changed: result.changed };
  }

  /**
   * HR trả hội thoại lại cho AI (hành động tường minh). Mở khoá AI của các hồ sơ
   * đang chờ HR bằng đúng nghiệp vụ Phase 1 (`resumeAi`: trả handoff về AI), rồi
   * bật AI_ACTIVE + cờ nhắc lượt AI kế tiếp làm mới context từ backend.
   */
  async resumeAi(
    conversationId: number,
    dto: { note?: string; applicationStatus?: ApplicationStatus },
    actor: RecruitmentActor,
  ) {
    const before = await this.control(conversationId);
    if (before.pausedBy.includes('CANDIDATE_AI_STOPPED')) {
      throw new ConflictException({
        code: 'AI_STOPPED_FOR_CANDIDATE',
        message: 'Ứng viên đã yêu cầu xoá dữ liệu — không thể trả lại cho AI',
      });
    }
    if (before.state === ConversationControlState.AI_ACTIVE) {
      return { ...before, changed: false };
    }

    const paused: Array<{ id: number }> = await this.dataSource.query(
      `SELECT a.id FROM "recruitment_applications" a
       WHERE a.candidate_id = $1 AND NOT (a.status::text = ANY($2::text[]))
         AND (a.ai_paused OR a.status = 'NEEDS_HR_REVIEW')
       ORDER BY a.id`,
      [before.candidateId, [...TERMINAL_APPLICATION_STATUSES]],
    );
    for (const app of paused) {
      await this.applications.resumeAi(
        app.id,
        { note: dto.note, status: dto.applicationStatus },
        actor,
      );
    }
    // Handoff còn mở của ứng viên (không gắn hồ sơ, hoặc hồ sơ không bị khoá AI) —
    // vẫn chặn AI nên trả về AI cùng lúc; HR đã chủ động trả hội thoại.
    await this.dataSource.query(
      `UPDATE "recruitment_handoffs"
       SET status = 'RETURNED_TO_AI', resolved_by = $2, resolved_at = now(),
           resolution_note = coalesce($3::text, 'Trả lại cho AI xử lý tiếp'), updated_at = now()
       WHERE candidate_id = $1 AND status = 'OPEN'`,
      [before.candidateId, actor.employeeId, dto.note ?? null],
    );

    const control = await this.dataSource.transaction(async (em) => {
      const row = await this.load(conversationId, em, true);
      await this.setMode(
        em,
        row,
        ConversationControlMode.AI_ACTIVE,
        actor,
        true,
      );
      return this.control(conversationId, em);
    });
    await this.record(actor, 'CONVERSATION_RESUME_AI', conversationId, {
      version: control.version,
      applicationsResumed: paused.length,
    });
    return { ...control, changed: true };
  }

  async close(conversationId: number, actor: RecruitmentActor) {
    const result = await this.dataSource.transaction(async (em) => {
      const row = await this.load(conversationId, em, true);
      if (row.control_mode === ConversationControlMode.CLOSED) {
        return { control: this.toControl(row), changed: false };
      }
      await this.setMode(em, row, ConversationControlMode.CLOSED, actor);
      return { control: await this.control(conversationId, em), changed: true };
    });
    if (result.changed) {
      await this.record(actor, 'CONVERSATION_CLOSE', conversationId, {
        version: result.control.version,
      });
    }
    return { ...result.control, changed: result.changed };
  }

  /**
   * HR gửi tin cho ứng viên: tin canonical (`senderType = HR`, tác giả = nhân viên)
   * + đúng một dòng outbox `HR_MESSAGE` → sender P3-5 gửi. KHÔNG gọi OpenClaw.
   * Đang AI_ACTIVE/AI_PAUSED thì tự chuyển HUMAN_TAKEOVER trước — không bao giờ có
   * hai nguồn trả lời cùng lúc. Idempotent theo `clientMessageId`.
   */
  async sendHumanMessage(
    conversationId: number,
    dto: { content: string; clientMessageId: string },
    actor: RecruitmentActor,
  ) {
    if (!CLIENT_MESSAGE_ID.test(dto.clientMessageId ?? '')) {
      throw new BadRequestException({
        code: 'CLIENT_MESSAGE_ID_INVALID',
        message: 'clientMessageId: 8–64 ký tự [A-Za-z0-9_-]',
      });
    }
    const content = normalizeMessageText(dto.content ?? '');
    if (!content || content.length > HR_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException({
        code: 'CONTENT_INVALID',
        message: `Nội dung 1–${HR_MESSAGE_MAX_LENGTH} ký tự`,
      });
    }
    const externalMessageId = `hr:${dto.clientMessageId}`;

    const result = await this.dataSource.transaction(async (em) => {
      const row = await this.load(conversationId, em, true);
      const target = ZALO_CONVERSATION.exec(row.external_conversation_id ?? '');
      if (row.channel !== 'ZALO' || !target) {
        throw new ConflictException({
          code: 'CHANNEL_NOT_SUPPORTED',
          message: 'Chỉ gửi được tin cho hội thoại Zalo OA',
        });
      }
      const recruitmentOa = this.config.get<string>('RECRUITMENT_ZALO_OA_ID');
      if (!recruitmentOa || target[1] !== recruitmentOa) {
        throw new ConflictException({
          code: 'OA_MISMATCH',
          message: 'Hội thoại không thuộc OA tuyển dụng',
        });
      }

      const existing: Array<{
        id: number;
        content: string;
        author_employee_id: number | null;
      }> = await em.query(
        `SELECT id, content, author_employee_id FROM "recruitment_messages"
           WHERE conversation_id = $1 AND external_message_id = $2`,
        [conversationId, externalMessageId],
      );
      if (existing[0]) {
        if (existing[0].content !== content) {
          throw new ConflictException({
            code: 'CLIENT_MESSAGE_ID_REUSED',
            message: 'clientMessageId đã dùng cho tin khác',
          });
        }
        const [outbox]: Array<{ id: number; status: string }> = await em.query(
          `SELECT id, status FROM "recruitment_channel_outbox" WHERE recruitment_message_id = $1`,
          [existing[0].id],
        );
        return {
          messageId: existing[0].id,
          outboxId: outbox?.id ?? null,
          outboxStatus: outbox?.status ?? null,
          idempotent: true,
          tookOver: false,
          version: row.control_version,
        };
      }
      if (row.control_mode === ConversationControlMode.CLOSED) {
        throw new ConflictException({
          code: 'CONVERSATION_CLOSED',
          message: 'Hội thoại đã đóng — tiếp quản trước khi gửi tin',
        });
      }

      let tookOver = false;
      if (row.control_mode !== ConversationControlMode.HUMAN_TAKEOVER) {
        await this.setMode(
          em,
          row,
          ConversationControlMode.HUMAN_TAKEOVER,
          actor,
        );
        tookOver = true;
      }
      const [message]: Array<{ id: number }> = await em.query(
        `INSERT INTO "recruitment_messages"
           (conversation_id, external_message_id, sender_type, direction, content, content_type,
            metadata, author_employee_id)
         VALUES ($1, $2, 'HR', 'OUTBOUND', $3, 'TEXT', '{}', $4)
         RETURNING id`,
        [conversationId, externalMessageId, content, actor.employeeId],
      );
      const [outbox]: Array<{ id: number }> = await em.query(
        `INSERT INTO "recruitment_channel_outbox"
           (source_type, channel, channel_account_id, external_recipient_id, message_text,
            recruitment_message_id)
         VALUES ('HR_MESSAGE', 'ZALO', $1, $2, $3, $4)
         RETURNING id`,
        [target[1], target[2], content, message.id],
      );
      await em.query(
        `UPDATE "recruitment_conversations" SET last_message_at = now(), updated_at = now() WHERE id = $1`,
        [conversationId],
      );
      const [after]: Array<{ control_version: number }> = await em.query(
        `SELECT control_version FROM "recruitment_conversations" WHERE id = $1`,
        [conversationId],
      );
      return {
        messageId: message.id,
        outboxId: outbox.id,
        outboxStatus: 'PENDING',
        idempotent: false,
        tookOver,
        version: after.control_version,
      };
    });

    if (!result.idempotent) {
      if (result.tookOver) {
        await this.record(actor, 'CONVERSATION_TAKEOVER', conversationId, {
          version: result.version,
          trigger: 'HR_MESSAGE',
        });
      }
      // Không ghi nội dung — chỉ id + độ dài.
      await this.record(actor, 'CONVERSATION_HR_MESSAGE', conversationId, {
        messageId: result.messageId,
        outboxId: result.outboxId,
        length: content.length,
      });
    }
    return result;
  }

  /** Handoff đang mở + chế độ điều khiển hội thoại của ứng viên (cho vận hành). */
  async listOpenHandoffs(limit = 50): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT h.id, h.reason, h.priority, h.candidate_id AS "candidateId",
              h.application_id AS "applicationId", h.created_at AS "createdAt",
              c.id AS "conversationId", c.control_mode AS "controlMode",
              c.control_version AS "controlVersion", c.taken_over_by AS "takenOverBy"
       FROM "recruitment_handoffs" h
       LEFT JOIN LATERAL (
         SELECT id, control_mode, control_version, taken_over_by FROM "recruitment_conversations"
         WHERE candidate_id = h.candidate_id
         ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT 1
       ) c ON true
       WHERE h.status = 'OPEN'
       ORDER BY h.created_at, h.id
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return rows;
  }

  private async setMode(
    em: EntityManager,
    row: ControlRow,
    mode: ConversationControlMode,
    actor: RecruitmentActor,
    resumeSignal = false,
  ) {
    await em.query(
      `UPDATE "recruitment_conversations"
       SET control_mode = $2::text::"recruitment_conversations_control_mode_enum",
           control_version = control_version + 1,
           control_changed_at = now(), control_changed_by = $3::int,
           taken_over_by = CASE WHEN $2::text = 'HUMAN_TAKEOVER' THEN $3::int ELSE NULL END,
           resume_signal_pending = $4::boolean,
           status = CASE WHEN $2::text = 'CLOSED' THEN 'CLOSED' ELSE 'ACTIVE' END::"recruitment_conversations_status_enum",
           updated_at = now()
       WHERE id = $1`,
      [row.id, mode, actor.employeeId, resumeSignal],
    );
  }

  private async load(
    conversationId: number,
    em: EntityManager,
    lock: boolean,
  ): Promise<ControlRow> {
    // Khoá riêng dòng hội thoại (FOR UPDATE OF c) — handoff/hồ sơ chỉ đọc.
    const [row]: ControlRow[] = await em.query(
      `SELECT c.id, c.candidate_id, c.status, c.control_mode, c.control_version,
              c.resume_signal_pending, c.taken_over_by, c.channel, c.external_conversation_id,
              cand.ai_stopped_at IS NOT NULL AS ai_stopped,
              EXISTS (SELECT 1 FROM "recruitment_applications" a
                      WHERE a.candidate_id = c.candidate_id
                        AND NOT (a.status::text = ANY($2::text[]))
                        AND (a.ai_paused OR a.status = 'NEEDS_HR_REVIEW')) AS app_paused,
              EXISTS (SELECT 1 FROM "recruitment_handoffs" h
                      WHERE h.candidate_id = c.candidate_id AND h.status = 'OPEN') AS handoff_open
       FROM "recruitment_conversations" c
       JOIN "recruitment_candidates" cand ON cand.id = c.candidate_id
       WHERE c.id = $1
       ${lock ? 'FOR UPDATE OF c' : ''}`,
      [conversationId, [...TERMINAL_APPLICATION_STATUSES]],
    );
    if (!row) {
      throw new NotFoundException({
        code: 'CONVERSATION_NOT_FOUND',
        message: `Không có hội thoại #${conversationId}`,
      });
    }
    return row;
  }

  private toControl(row: ControlRow): ConversationControl {
    const pausedBy: ConversationControl['pausedBy'] = [];
    if (row.handoff_open) pausedBy.push('HANDOFF_OPEN');
    if (row.app_paused) pausedBy.push('APPLICATION_PAUSED');
    if (row.ai_stopped) pausedBy.push('CANDIDATE_AI_STOPPED');
    const state =
      row.control_mode === ConversationControlMode.CLOSED ||
      row.status === 'CLOSED'
        ? ConversationControlState.CLOSED
        : row.control_mode === ConversationControlMode.HUMAN_TAKEOVER
          ? ConversationControlState.HUMAN_TAKEOVER
          : pausedBy.length
            ? ConversationControlState.AI_PAUSED
            : ConversationControlState.AI_ACTIVE;
    return {
      conversationId: Number(row.id),
      candidateId: Number(row.candidate_id),
      state,
      mode: row.control_mode,
      version: Number(row.control_version),
      pausedBy,
      resumeSignalPending: row.resume_signal_pending,
      takenOverBy:
        row.taken_over_by === null ? null : Number(row.taken_over_by),
    };
  }

  private async record(
    actor: RecruitmentActor,
    action:
      | 'CONVERSATION_TAKEOVER'
      | 'CONVERSATION_RESUME_AI'
      | 'CONVERSATION_CLOSE'
      | 'CONVERSATION_HR_MESSAGE',
    conversationId: number,
    context: Record<string, unknown>,
  ) {
    await this.audit.record({
      actor,
      action,
      entity: 'conversations',
      entityId: conversationId,
      context,
    });
  }
}
