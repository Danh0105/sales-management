import {
  HttpException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { hostname } from 'os';
import { Repository } from 'typeorm';

import {
  channelConversationId,
  parseRecruitmentSubject,
  type RecruitmentAiSubject,
} from '../ai/recruitment-ai-subject';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentMessage } from '../entities/recruitment-message.entity';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  CandidateSource,
  ChannelEventAiDecision,
  ConversationChannel,
  ConversationControlMode,
  ConversationControlState,
  HrAlertSeverity,
  HrAlertType,
  MessageContentType,
  MessageDirection,
  MessageSenderType,
  RuntimeControlScope,
} from '../recruitment.enums';
import { SYSTEM_ACTOR } from '../recruitment.roles';
import { RecruitmentCandidateService } from '../services/recruitment-candidate.service';
import { RecruitmentConversationService } from '../services/recruitment-conversation.service';
import {
  invokeOpenClaw,
  type AgentFailureKind,
} from './openclaw-responses.client';
import { checkAiReply, type AiReplyViolation } from './ai-reply-policy';
import {
  type AiLimitVerdict,
  RecruitmentAiLimitsService,
} from './recruitment-ai-limits.service';
import {
  type AiSafetyConfig,
  readAiSafetyConfig,
} from './recruitment-ai-safety.config';
import { RecruitmentConversationControlService } from './recruitment-conversation-control.service';
import { RecruitmentRuntimeControlService } from './recruitment-runtime-control.service';
import { RecruitmentHrAlertService } from './recruitment-hr-alert.service';
import {
  RecruitmentChannelEventQueue,
  type ClaimedChannelEvent,
} from './recruitment-channel-event.queue';
import {
  isRecruitmentWorkerEnabled,
  MAX_AGENT_ATTEMPTS,
  MAX_INFRA_ATTEMPTS,
  readRecruitmentWorkerConfig,
  retryDelayMs,
  type RecruitmentWorkerConfig,
} from './recruitment-channel-worker.config';

/** Lỗi khi đưa kết quả lượt chạy vào hội thoại canonical. */
class CanonicalError extends Error {
  constructor(
    readonly code: string,
    readonly kind: AgentFailureKind,
  ) {
    super(code);
  }
}

/**
 * Tín hiệu một lượt sau khi HR trả hội thoại cho AI: không dựa vào trí nhớ hội
 * thoại cũ của phiên — trạng thái nghiệp vụ lấy lại từ backend.
 */
export const RESUME_AFTER_TAKEOVER_INSTRUCTIONS =
  'Human takeover has ended: HR handled this conversation and has handed it back to you. ' +
  'Before replying, call recruitment_get_application_context to refresh the backend state ' +
  '(recentMessages include what HR told the candidate). Do not rely on your earlier memory of this conversation.';

const SKIP_DECISION: Partial<
  Record<ConversationControlState, ChannelEventAiDecision>
> = {
  [ConversationControlState.AI_PAUSED]:
    ChannelEventAiDecision.SKIPPED_AI_PAUSED,
  [ConversationControlState.HUMAN_TAKEOVER]:
    ChannelEventAiDecision.SKIPPED_HUMAN_TAKEOVER,
  [ConversationControlState.CLOSED]: ChannelEventAiDecision.SKIPPED_CLOSED,
};

interface CanonicalInbound {
  conversationId: number;
  candidateId: number;
  /** `existing` = lần thử trước (hoặc model) đã lưu tin này. */
  stored: 'new' | 'existing';
}

interface CanonicalReply {
  text: string;
  messageId: number;
  replyBy: 'model' | 'worker';
  replyMatches: boolean;
}

/**
 * Lỗi 4xx của service (vd. `CONVERSATION_CANDIDATE_MISMATCH`) = dữ liệu không nhất
 * quán, thử lại vô ích; lỗi khác (DB) = tạm thời.
 */
function asCanonicalError(error: unknown): CanonicalError {
  if (error instanceof CanonicalError) return error;
  if (error instanceof HttpException && error.getStatus() < 500) {
    return new CanonicalError('CANONICAL_CONFLICT', 'rejected');
  }
  return new CanonicalError('CANONICAL_STORE_FAILED', 'infra');
}

/**
 * Worker: inbox `recruitment_channel_events` → OpenClaw → hội thoại canonical →
 * outbox chờ gửi. Chạy trong process NestJS khi `RECRUITMENT_WORKER_ENABLED=true`
 * (mặc định tắt); nhiều process cùng chạy an toàn — claim nguyên tử, tuần tự theo
 * người gửi, fencing theo lease (`RecruitmentChannelEventQueue`).
 *
 * Mỗi lượt:
 * 1. Session key **do worker dựng từ DB**: `agent:<agent>:zalo:<OA>:<người gửi>`.
 * 2. `POST /v1/responses` — chỉ câu trả lời `completed` có text thật mới là xong.
 * 3. Hội thoại canonical (`recruitment_messages`): worker nhận diện ứng viên theo
 *    (OA, người gửi) và lưu tin đến nguyên văn (`msg`) TRƯỚC lượt model; tin đi
 *    (`msg-reply`) do model lưu theo skill, thiếu thì worker lưu — idempotent theo
 *    cùng khoá. Tin đi đã lưu là bản canonical, outbox gửi đúng bản đó.
 * 4. Một transaction: outbox (`ON CONFLICT (source_event_id) DO NOTHING`) +
 *    `PROCESSED` + xoá nội dung tin khỏi inbox.
 *
 * Ngữ nghĩa P1-FIX: một lần dispatch provider tối đa cho mỗi event. Sau dấu mốc
 * dispatch, crash/timeout không retry mù vì provider có thể đã nhận và tính phí;
 * nếu đã có tin canonical thì tái sử dụng, nếu chưa có thì dead-letter để HR đối soát.
 * Tác dụng nghiệp vụ và tin đi vẫn idempotent nhờ `externalMessageId` và unique outbox.
 *
 * Không gửi tin Zalo (bước sau đọc outbox `PENDING`).
 */
/** Nội dung thay thế tin AI bị chặn vì có dạng bí mật (P3-7.3 / G8). */
const REDACTED_SECRET_REPLY =
  '[Đã ẩn: câu trả lời AI có dạng bí mật — không gửi]';

@Injectable()
export class RecruitmentChannelWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('RecruitmentChannelWorker');
  private readonly enabled: boolean;
  private readonly config: RecruitmentWorkerConfig | null;
  /**
   * Định danh process worker. Container dùng chung network namespace có thể
   * trùng hostname và PID 1 → thêm phần ngẫu nhiên theo mỗi lần khởi động.
   */
  private readonly workerId = `${hostname().slice(0, 60)}:${process.pid}:${randomUUID().slice(0, 6)}`;
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly inFlight = new Set<AbortController>();
  private nextJanitorAt = 0;
  /** Pilot / trần / chính sách câu trả lời (P3-7.3 / G8); `null` khi cấu hình sai (đã chặn lúc boot). */
  private readonly safety: AiSafetyConfig | null;
  private lastHalted = false;
  private readonly stopListening: (() => void) | undefined;

  constructor(
    configService: ConfigService,
    private readonly queue: RecruitmentChannelEventQueue,
    private readonly conversations: RecruitmentConversationService,
    private readonly candidateService: RecruitmentCandidateService,
    @InjectRepository(RecruitmentCandidate)
    private readonly candidates: Repository<RecruitmentCandidate>,
    @InjectRepository(RecruitmentMessage)
    private readonly messages: Repository<RecruitmentMessage>,
    private readonly audit: RecruitmentAuditService,
    private readonly control: RecruitmentConversationControlService,
    private readonly alerts: RecruitmentHrAlertService,
    private readonly runtime?: RecruitmentRuntimeControlService,
    private readonly limits?: RecruitmentAiLimitsService,
  ) {
    const get = (key: string) => configService.get<string>(key);
    this.enabled = isRecruitmentWorkerEnabled(get);
    const read = readRecruitmentWorkerConfig(get);
    this.config = 'config' in read ? read.config : null;
    const safety = readAiSafetyConfig(get);
    this.safety = 'config' in safety ? safety.config : null;
    this.stopListening = this.runtime?.onStop?.((scopes) => {
      if (
        scopes.has(RuntimeControlScope.AI) ||
        scopes.has(RuntimeControlScope.WORKER)
      ) {
        for (const controller of this.inFlight) controller.abort();
      }
    });
  }

  onApplicationBootstrap(): void {
    // Cấu hình sai đã chặn ở RecruitmentModule.onModuleInit — ở đây chỉ phòng thủ.
    if (!this.enabled || !this.config) return;
    this.running = true;
    this.logger.log(
      `worker start id=${this.workerId} oa=${this.config.oaId} slots=${this.config.concurrency}`,
    );
    for (let slot = 0; slot < this.config.concurrency; slot++) {
      this.loops.push(this.loop(slot, this.config));
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.stopListening?.();
    // Lượt đang chạy bị huỷ; event đã dispatch không được tự gọi provider lần hai.
    for (const controller of this.inFlight) controller.abort();
    await Promise.allSettled(this.loops);
  }

  private async loop(slot: number, config: RecruitmentWorkerConfig) {
    while (this.running) {
      try {
        if (slot === 0 && Date.now() >= this.nextJanitorAt) {
          this.nextJanitorAt = Date.now() + config.janitorMs;
          await this.expireRetention();
        }
        if (await this.halted()) {
          await sleep(config.pollMs + Math.floor(Math.random() * 250));
          continue;
        }
        const owner = `${this.workerId}:${randomUUID().slice(0, 8)}`;
        const event = await this.queue.claimNext(
          config.oaId,
          owner,
          config.leaseMs,
          config.settleMs,
          this.safety?.pilotSenders ?? null,
        );
        if (!event) {
          await sleep(config.pollMs + Math.floor(Math.random() * 250));
          continue;
        }
        await this.process(event, owner, config);
      } catch (error) {
        this.logger.error(`worker loop error=${errorCode(error)}`);
        await sleep(config.pollMs);
      }
    }
  }

  /** Một lượt cho một event đã claim. Public để test. */
  async process(
    event: ClaimedChannelEvent,
    owner: string,
    config: RecruitmentWorkerConfig,
  ): Promise<void> {
    const started = Date.now();
    const subject = subjectOf(event);
    if (!event.messageText || !event.providerMessageId) {
      return this.finishFailure(event, owner, config, 'NO_CONTENT', 'rejected');
    }
    if (!subject) {
      // Session key OpenClaw bị viết thường — id có chữ hoa sẽ lệch subject.
      return this.finishFailure(
        event,
        owner,
        config,
        'SUBJECT_NOT_CANONICAL',
        'rejected',
      );
    }

    // Tin đến vào hội thoại canonical TRƯỚC lượt model: đúng nguyên văn ứng viên,
    // đúng thứ tự, và không phụ thuộc model có lưu hay không.
    let inbound: CanonicalInbound;
    try {
      inbound = await this.ensureInbound(event, subject);
    } catch (error) {
      const failure = asCanonicalError(error);
      return this.finishFailure(
        event,
        owner,
        config,
        failure.code,
        failure.kind,
      );
    }

    // Backend quyết định AI có được trả lời không (AGENTS.md §12) — không phó mặc
    // cho skill tự nhớ đã chuyển HR.
    let fence: { conversationId: number; expectedVersion: number };
    let instructions: string | undefined;
    let storedReply: { text: string; messageId: number } | null = null;
    try {
      const control = await this.control.control(inbound.conversationId);
      // Lượt AI của event đã BẮT ĐẦU ở lần thử trước (rồi worker chết / mất response):
      // chỉ thao tác của HR (đổi chế độ/version) mới chặn được nó — tạm dừng do chính
      // lượt đó gây ra (vd. AI vừa mở handoff) không được nuốt câu trả lời của lượt.
      const turnStarted = event.aiControlVersion !== null;
      const hrChanged =
        turnStarted &&
        (control.mode !== ConversationControlMode.AI_ACTIVE ||
          control.version !== event.aiControlVersion);
      const skip = turnStarted
        ? hrChanged
          ? (SKIP_DECISION[control.state] ??
            ChannelEventAiDecision.DISCARDED_CONTROL_CHANGED)
          : undefined
        : SKIP_DECISION[control.state];
      if (skip) {
        const prior = turnStarted
          ? await this.findStoredReply(event, inbound.conversationId)
          : null;
        const written = await this.queue.completeWithoutAi(
          event,
          owner,
          inbound.conversationId,
          skip,
          async (em) => {
            await this.alerts.raise(
              {
                type: HrAlertType.CANDIDATE_MESSAGE_WAITING,
                severity: HrAlertSeverity.MEDIUM,
                // Một cảnh báo cho mỗi giai đoạn điều khiển của hội thoại.
                sourceKey: `conversation:${inbound.conversationId}:v${control.version}`,
                candidateId: inbound.candidateId,
                conversationId: inbound.conversationId,
                eventId: event.id,
                details: { state: control.state },
              },
              em,
            );
            if (prior) {
              // Câu trả lời của lượt cũ không còn hợp lệ sau thao tác của HR.
              await em.query(
                `UPDATE "recruitment_messages"
                 SET metadata = metadata || '{"delivery": "DISCARDED_CONTROL_CHANGED"}'::jsonb
                 WHERE id = $1`,
                [prior.messageId],
              );
            }
          },
        );
        this.logger.log(
          `worker event=${event.id} attempt=${event.attemptCount} result=PROCESSED ai=${skip} ` +
            `conversation=${inbound.conversationId}${written ? '' : ' (lease lost)'}`,
        );
        return;
      }
      fence = {
        conversationId: inbound.conversationId,
        expectedVersion: turnStarted
          ? (event.aiControlVersion as number)
          : control.version,
      };
      instructions = control.resumeSignalPending
        ? RESUME_AFTER_TAKEOVER_INSTRUCTIONS
        : undefined;
      if (turnStarted) {
        storedReply = await this.findStoredReply(event, inbound.conversationId);
      } else if (this.limits && this.safety) {
        const reservation = await this.limits.reserve(
          event,
          owner,
          control.version,
          this.safety.limits,
        );
        if (reservation.kind === 'LIMIT') {
          return await this.limitReached(
            event,
            owner,
            inbound,
            reservation.verdict,
          );
        }
        if (reservation.kind === 'HALTED') {
          await this.queue.release(event, owner);
          return;
        }
        if (reservation.kind === 'LOST' || reservation.kind === 'UNCERTAIN') {
          return;
        }
        event.aiControlVersion = control.version;
        event.aiReservedTokens = this.safety.limits.tokenReservationPerTurn;
      } else {
        throw new Error('AI_QUOTA_RESERVATION_UNAVAILABLE');
      }
    } catch {
      return this.finishFailure(
        event,
        owner,
        config,
        'CONTROL_CHECK_FAILED',
        'infra',
      );
    }

    if (storedReply) {
      // Lượt trước đã xong (tin đi đã nằm trong hội thoại) nhưng chưa kịp ghi kết quả
      // → gửi đúng bản đó, KHÔNG gọi OpenClaw lần hai.
      const storedViolation = this.violation(storedReply.text, event);
      if (storedViolation) {
        return this.blockReply(
          event,
          owner,
          inbound,
          storedViolation,
          storedReply.messageId,
        );
      }
      const result = await this.queue.complete(
        event,
        owner,
        {
          externalRecipientId: subject.userId,
          messageText: storedReply.text,
          recruitmentMessageId: storedReply.messageId,
        },
        fence,
      );
      this.logger.log(
        `worker event=${event.id} attempt=${event.attemptCount} result=${result.completed ? 'PROCESSED' : 'LEASE_LOST'} ` +
          `ai=${result.discarded ? ChannelEventAiDecision.DISCARDED_CONTROL_CHANGED : ChannelEventAiDecision.AI_REPLIED} ` +
          `outbox=${result.outboxId ?? '-'} reusedReply=true sender=${maskSender(subject)} ms=${Date.now() - started}`,
      );
      return;
    }

    if (event.aiProviderDispatchedAt) {
      // Worker trước đã có thể gửi request tới provider. Không gọi lần hai khi
      // chưa biết outcome; HR đối soát tin canonical / chi phí.
      return this.finishFailure(
        event,
        owner,
        config,
        'PROVIDER_OUTCOME_UNKNOWN',
        'infra',
      );
    }

    if (event.aiReservedTokens == null) {
      // Lượt từ bản code cũ chưa có reservation; không được cấp phép provider
      // chỉ dựa trên ai_control_version. HR đối soát và tạo event mới nếu cần.
      return this.finishFailure(
        event,
        owner,
        config,
        'LEGACY_UNRESERVED_TURN',
        'rejected',
      );
    }

    let dispatch: 'DISPATCHED' | 'HALTED' | 'LOST' | 'UNCERTAIN';
    try {
      dispatch = await this.queue.markProviderDispatched(event, owner);
    } catch {
      return this.finishFailure(
        event,
        owner,
        config,
        'PROVIDER_DISPATCH_GATE_FAILED',
        'infra',
      );
    }
    if (dispatch === 'HALTED') {
      await this.queue.fail(
        event,
        owner,
        'RUNTIME_HALTED_PRE_DISPATCH',
        config.retryBaseMs,
      );
      return;
    }
    if (dispatch === 'LOST') return;
    if (dispatch === 'UNCERTAIN') {
      return this.finishFailure(
        event,
        owner,
        config,
        'PROVIDER_OUTCOME_UNKNOWN',
        'infra',
      );
    }
    event.aiProviderDispatchedAt = new Date();

    const controller = new AbortController();
    this.inFlight.add(controller);
    let leaseLost = false;
    let watchBusy = false;
    const heartbeat = setInterval(
      () => {
        this.queue
          .heartbeat(event.id, owner, config.leaseMs)
          .then((alive) => {
            if (!alive) {
              leaseLost = true;
              controller.abort();
            }
          })
          .catch(() => undefined);
      },
      Math.max(1000, Math.floor(config.leaseMs / 3)),
    );
    const stopWatch = setInterval(() => {
      if (watchBusy) return;
      watchBusy = true;
      this.runtime
        ?.state()
        .then((state) => {
          if (state.aiHalted || state.workerHalted) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => {
          watchBusy = false;
        });
    }, 500);

    try {
      const outcome = await invokeOpenClaw(
        config.openclaw,
        {
          sessionKey: `agent:${config.openclaw.agentId}:zalo:${subject.oaId}:${subject.userId}`,
          input: `[channel=ZALO sender=${subject.userId} msg=${event.providerMessageId}]\n${event.messageText}`,
          instructions,
        },
        { signal: controller.signal },
      );
      if (leaseLost) {
        this.logger.warn(
          `worker event=${event.id} lease lost — bỏ kết quả, worker khác xử lý`,
        );
        return;
      }
      if (!outcome.ok) {
        return this.finishFailure(
          event,
          owner,
          config,
          outcome.code,
          outcome.kind,
        );
      }
      if (outcome.usage) {
        try {
          await this.queue.recordUsage(event.id, outcome.usage);
        } catch {
          await this.haltForAccounting('TOKEN_USAGE_STORE_FAILED');
          throw new Error('TOKEN_USAGE_STORE_FAILED');
        }
        if (
          event.aiReservedTokens != null &&
          outcome.usage.total > event.aiReservedTokens
        ) {
          // Ngân sách tính theo greatest(đặt trước, thực tế) ⇒ phần vượt đã bị trừ đúng và
          // lượt kế tiếp bị chặn ở reserve() khi hết ngân sách. Không dừng cả hệ thống vì một
          // lượt dài (ngữ cảnh hội thoại thật tăng ~20k token/lượt); theo dõi qua ai-usage.
          this.logger.warn(
            `worker event=${event.id} token vượt đặt trước total=${outcome.usage.total} reserved=${event.aiReservedTokens}`,
          );
        }
      } else {
        await this.haltForAccounting('TOKEN_USAGE_MISSING');
        return this.finishFailure(
          event,
          owner,
          config,
          'TOKEN_USAGE_MISSING',
          'rejected',
        );
      }
      let reply: CanonicalReply;
      try {
        reply = await this.ensureReply(event, subject, inbound, outcome.text);
      } catch (error) {
        const failure = asCanonicalError(error);
        return this.finishFailure(
          event,
          owner,
          config,
          failure.code,
          failure.kind,
        );
      }
      // Kiểm đúng nội dung SẼ gửi (bản model đã lưu hoặc bản worker lưu).
      const violation = this.violation(reply.text, event);
      if (violation) {
        return this.blockReply(
          event,
          owner,
          inbound,
          violation,
          reply.messageId,
        );
      }

      const result = await this.queue.complete(
        event,
        owner,
        {
          externalRecipientId: subject.userId,
          messageText: reply.text,
          recruitmentMessageId: reply.messageId,
        },
        fence,
      );
      this.logger.log(
        `worker event=${event.id} attempt=${event.attemptCount} result=${result.completed ? 'PROCESSED' : 'LEASE_LOST'} ` +
          `ai=${result.discarded ? ChannelEventAiDecision.DISCARDED_CONTROL_CHANGED : ChannelEventAiDecision.AI_REPLIED} ` +
          `outbox=${result.outboxId ?? '-'} inbound=${inbound.stored} replyBy=${reply.replyBy} ` +
          `replyMatches=${reply.replyMatches} sender=${maskSender(subject)} ms=${Date.now() - started}`,
      );
    } finally {
      clearInterval(heartbeat);
      clearInterval(stopWatch);
      this.inFlight.delete(controller);
    }
  }

  /**
   * Danh tính do tầng kênh gắn (AGENTS.md §33): ứng viên của (OA, người gửi) —
   * chưa có thì tạo với đúng danh tính Zalo đó — rồi lưu tin đến nguyên văn với
   * `externalMessageId = msg` (cùng khoá skill dùng → model lưu lại chỉ là trùng).
   */
  private async ensureInbound(
    event: ClaimedChannelEvent,
    subject: RecruitmentAiSubject,
  ): Promise<CanonicalInbound> {
    let candidateId = (
      await this.candidates.findOne({
        where: { zaloOaId: subject.oaId, zaloUserId: subject.userId },
        select: { id: true },
      })
    )?.id;
    if (!candidateId) {
      const created = await this.candidateService.aiFindOrCreate(
        { source: CandidateSource.ZALO },
        { oaId: subject.oaId, userId: subject.userId },
      );
      candidateId = created.candidate?.id;
    }
    if (!candidateId) {
      throw new CanonicalError('CANDIDATE_NOT_RESOLVED', 'infra');
    }

    const saved = await this.conversations.saveMessage({
      candidateId,
      channel: ConversationChannel.ZALO,
      externalConversationId: channelConversationId(subject),
      contentType: MessageContentType.TEXT,
      externalMessageId: event.providerMessageId as string,
      senderType: MessageSenderType.CANDIDATE,
      direction: MessageDirection.INBOUND,
      content: event.messageText as string,
    });
    await this.expectStored(saved.messageId, MessageDirection.INBOUND);
    return {
      conversationId: saved.conversationId,
      candidateId,
      stored: saved.duplicate ? 'existing' : 'new',
    };
  }

  /**
   * Tin đi canonical của lượt: model lưu theo skill (`msg-reply`); chưa có thì
   * worker lưu câu trả lời vừa nhận với cùng khoá. Bản đã lưu là bản được gửi —
   * kể cả khi lượt chạy lại sau crash trả câu khác.
   */
  private async ensureReply(
    event: ClaimedChannelEvent,
    subject: RecruitmentAiSubject,
    inbound: CanonicalInbound,
    responseText: string,
  ): Promise<CanonicalReply> {
    const saved = await this.conversations.saveMessage({
      candidateId: inbound.candidateId,
      channel: ConversationChannel.ZALO,
      externalConversationId: channelConversationId(subject),
      contentType: MessageContentType.TEXT,
      externalMessageId: `${event.providerMessageId}-reply`,
      senderType: MessageSenderType.AI,
      direction: MessageDirection.OUTBOUND,
      content: responseText,
    });
    const stored = await this.expectStored(
      saved.messageId,
      MessageDirection.OUTBOUND,
    );
    return {
      text: stored.content,
      messageId: stored.id,
      replyBy: saved.duplicate ? 'model' : 'worker',
      replyMatches: stored.content.trim() === responseText.trim(),
    };
  }

  /** Tin đi (`msg-reply`) mà một lần thử trước của event đã lưu, nếu có. */
  /** Dừng khẩn WORKER hoặc AI (P3-7.3 / G8) — không bắt đầu lượt mới; log một lần khi đổi. */
  private async halted(): Promise<boolean> {
    if (!this.runtime) return false;
    const state = await this.runtime.state();
    const halted = state.workerHalted || state.aiHalted;
    if (halted !== this.lastHalted) {
      this.lastHalted = halted;
      this.logger.warn(
        halted
          ? `worker: DỪNG KHẨN (worker=${state.workerHalted} ai=${state.aiHalted}${state.failClosed ? ' fail-closed' : ''}) — không claim tin`
          : 'worker: mở lại — claim tin bình thường',
      );
    }
    return halted;
  }

  private violation(text: string, event: ClaimedChannelEvent) {
    return this.safety
      ? checkAiReply(text, event.messageText ?? '', this.safety.replyPolicy)
      : null;
  }

  private async haltForAccounting(reason: string): Promise<void> {
    if (!this.runtime) throw new Error('RUNTIME_CONTROL_UNAVAILABLE');
    await this.runtime.haltAiIfRunning(
      `AI_LIMIT ${reason}`,
      SYSTEM_ACTOR,
      (em, state) =>
        this.alerts.raise(
          {
            type: HrAlertType.AI_LIMIT_REACHED,
            severity: HrAlertSeverity.HIGH,
            sourceKey: `ai-limit:${reason}:${(state.updatedAt ?? new Date()).toISOString()}`,
            details: { limit: reason },
          },
          em,
        ),
    );
  }

  /**
   * Vượt trần (P3-7.3 / G8). Người gửi → không gọi AI, HR trả lời (cảnh báo theo hội thoại /
   * giờ). Toàn hệ thống → tự DỪNG AI (audit hệ thống) + cảnh báo HR, trả event về hàng chờ để
   * xử lý sau khi người vận hành mở lại.
   */
  private async limitReached(
    event: ClaimedChannelEvent,
    owner: string,
    inbound: CanonicalInbound,
    verdict: Exclude<AiLimitVerdict, { ok: true }>,
  ): Promise<void> {
    const details = {
      limit: verdict.limit,
      used: verdict.used,
      max: verdict.max,
    };
    if (verdict.scope === 'GLOBAL') {
      // Chỉ worker đổi được trạng thái mới cảnh báo — mỗi lần tự dừng đúng 1 cảnh báo (khoá theo
      // thời điểm chuyển trạng thái, không gộp theo giờ: HR mở lại rồi chạm trần lần nữa vẫn được báo).
      await this.runtime?.haltAiIfRunning(
        `AI_LIMIT ${verdict.limit} ${verdict.used}/${verdict.max}`,
        SYSTEM_ACTOR,
        (em, state) =>
          this.alerts.raise(
            {
              type: HrAlertType.AI_LIMIT_REACHED,
              severity: HrAlertSeverity.HIGH,
              sourceKey: `ai-limit:${verdict.limit}:${(state.updatedAt ?? new Date()).toISOString()}`,
              details,
            },
            em,
          ),
      );
      const released = await this.queue.release(event, owner);
      this.logger.error(
        `worker event=${event.id} result=RELEASED ai=HALTED limit=${verdict.limit} used=${verdict.used}/${verdict.max}` +
          `${released ? '' : ' (lease lost)'}`,
      );
      return;
    }
    const written = await this.queue.completeWithoutAi(
      event,
      owner,
      inbound.conversationId,
      ChannelEventAiDecision.SKIPPED_RATE_LIMITED,
      (em) =>
        this.alerts.raise(
          {
            type: HrAlertType.CANDIDATE_MESSAGE_WAITING,
            severity: HrAlertSeverity.MEDIUM,
            sourceKey: `conversation:${inbound.conversationId}:${verdict.limit}:${new Date().toISOString().slice(0, 13)}`,
            candidateId: inbound.candidateId,
            conversationId: inbound.conversationId,
            eventId: event.id,
            details,
          },
          em,
        ),
    );
    this.logger.warn(
      `worker event=${event.id} result=PROCESSED ai=${ChannelEventAiDecision.SKIPPED_RATE_LIMITED} ` +
        `limit=${verdict.limit} used=${verdict.used}/${verdict.max} conversation=${inbound.conversationId}` +
        `${written ? '' : ' (lease lost)'}`,
    );
  }

  /**
   * Câu trả lời vi phạm chính sách (P3-7.3 / G8): KHÔNG xếp hàng gửi; event PROCESSED với
   * `BLOCKED_BY_POLICY`, cảnh báo HR (chỉ mã quy tắc, không nội dung); tin AI đã lưu
   * đánh dấu không gửi để HR xem lại.
   */
  private async blockReply(
    event: ClaimedChannelEvent,
    owner: string,
    inbound: CanonicalInbound,
    violation: AiReplyViolation,
    replyMessageId: number,
  ): Promise<void> {
    const written = await this.queue.completeWithoutAi(
      event,
      owner,
      inbound.conversationId,
      ChannelEventAiDecision.BLOCKED_BY_POLICY,
      async (em) => {
        await this.alerts.raise(
          {
            type: HrAlertType.AI_POLICY_HANDOFF,
            severity: HrAlertSeverity.HIGH,
            sourceKey: `event:${event.id}:reply-policy`,
            candidateId: inbound.candidateId,
            conversationId: inbound.conversationId,
            eventId: event.id,
            details: { rule: violation },
          },
          em,
        );
        // Dạng bí mật: không giữ nguyên văn trong hội thoại (HR vẫn thấy có tin bị chặn).
        await em.query(
          `UPDATE "recruitment_messages"
           SET metadata = metadata || '{"delivery": "BLOCKED_BY_POLICY"}'::jsonb,
               content = CASE WHEN $2::boolean THEN '${REDACTED_SECRET_REPLY}' ELSE content END
           WHERE id = $1`,
          [replyMessageId, violation === 'SECRET_LIKE'],
        );
      },
    );
    this.logger.warn(
      `worker event=${event.id} result=PROCESSED ai=${ChannelEventAiDecision.BLOCKED_BY_POLICY} rule=${violation} ` +
        `conversation=${inbound.conversationId}${written ? '' : ' (lease lost)'}`,
    );
  }

  private async findStoredReply(
    event: ClaimedChannelEvent,
    conversationId: number,
  ): Promise<{ text: string; messageId: number } | null> {
    const message = await this.messages.findOne({
      where: {
        conversationId,
        externalMessageId: `${event.providerMessageId}-reply`,
      },
      select: { id: true, content: true, direction: true },
    });
    return message && message.direction === MessageDirection.OUTBOUND
      ? { text: message.content, messageId: message.id }
      : null;
  }

  private async expectStored(id: number, direction: MessageDirection) {
    const message = await this.messages.findOne({
      where: { id },
      select: { id: true, direction: true, content: true },
    });
    if (!message || message.direction !== direction) {
      throw new CanonicalError('CANONICAL_MESSAGE_INVALID', 'agent');
    }
    return message;
  }

  private async finishFailure(
    event: ClaimedChannelEvent,
    owner: string,
    config: RecruitmentWorkerConfig,
    code: string,
    kind: AgentFailureKind,
  ): Promise<void> {
    const terminal =
      event.aiProviderDispatchedAt != null ||
      kind === 'rejected' ||
      (kind === 'infra' && event.attemptCount >= MAX_INFRA_ATTEMPTS) ||
      (kind === 'agent' && event.attemptCount >= MAX_AGENT_ATTEMPTS);
    const retryInMs = terminal
      ? null
      : retryDelayMs(config, event.attemptCount);
    const written = await this.queue.fail(event, owner, code, retryInMs);
    this.logger.warn(
      `worker event=${event.id} attempt=${event.attemptCount} result=${terminal ? 'DEAD_LETTER' : 'RETRY'} ` +
        `code=${code} kind=${kind}${retryInMs === null ? '' : ` retryInMs=${retryInMs}`}${written ? '' : ' (lease lost)'}`,
    );
    if (terminal && written) {
      await this.deadLetter(event.id, event.channelAccountId, code, 'FAILED');
    }
  }

  private async expireRetention(): Promise<void> {
    try {
      await this.alerts.sweep();
    } catch (error) {
      this.logger.error(`worker hr-alert sweep error=${errorCode(error)}`);
    }
    const expired = await this.queue.expireRetention();
    for (const row of expired) {
      this.logger.warn(
        `worker event=${row.id} result=DEAD_LETTER code=${row.failureCode} stage=RETENTION_EXPIRED (đã xoá nội dung)`,
      );
      await this.deadLetter(
        row.id,
        row.channelAccountId,
        row.failureCode,
        'RETENTION_EXPIRED',
      );
    }
  }

  /** Dấu vết cho HR (activity_log) — chỉ metadata, không nội dung tin. */
  private async deadLetter(
    eventId: number,
    oaId: string,
    code: string,
    stage: 'FAILED' | 'RETENTION_EXPIRED',
  ) {
    try {
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'CHANNEL_EVENT_DEAD_LETTER',
        entity: 'channel-events',
        entityId: eventId,
        context: { oaId, code, stage },
        success: false,
      });
    } catch (error) {
      this.logger.error(
        `worker event=${eventId} dead-letter audit failed error=${errorCode(error)}`,
      );
    }
  }
}

/**
 * Subject của event — đúng như plugin sẽ thấy từ session key. OpenClaw viết
 * thường session key, nên id có chữ hoa (Zalo không dùng) bị coi là không hợp lệ.
 */
function subjectOf(event: ClaimedChannelEvent): RecruitmentAiSubject | null {
  const raw = `zalo:${event.channelAccountId}:${event.externalSenderId}`;
  return raw === raw.toLowerCase() ? parseRecruitmentSubject(raw) : null;
}

function maskSender(subject: RecruitmentAiSubject): string {
  return createHash('sha256')
    .update(`${subject.oaId}:${subject.userId}`)
    .digest('hex')
    .slice(0, 12);
}

function errorCode(error: unknown): string {
  const record = error as { code?: unknown; name?: unknown } | null;
  for (const value of [record?.code, record?.name]) {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }
  return 'unknown';
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
