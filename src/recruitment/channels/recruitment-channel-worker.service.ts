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
  ConversationChannel,
  MessageContentType,
  MessageDirection,
  MessageSenderType,
} from '../recruitment.enums';
import { SYSTEM_ACTOR } from '../recruitment.roles';
import { RecruitmentCandidateService } from '../services/recruitment-candidate.service';
import { RecruitmentConversationService } from '../services/recruitment-conversation.service';
import {
  invokeOpenClaw,
  type AgentFailureKind,
} from './openclaw-responses.client';
import {
  RecruitmentChannelEventQueue,
  type ClaimedChannelEvent,
} from './recruitment-channel-event.queue';
import {
  isRecruitmentWorkerEnabled,
  MAX_AGENT_ATTEMPTS,
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

interface CanonicalInbound {
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
 * Ngữ nghĩa: **at-least-once** gọi OpenClaw (chết đúng sau khi OpenClaw trả lời
 * thì lượt sẽ chạy lại), nhưng tác dụng nghiệp vụ và tin đi chỉ một lần — nhờ
 * idempotency của backend, `externalMessageId` và unique outbox.
 *
 * Không gửi tin Zalo (bước sau đọc outbox `PENDING`).
 */
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
  ) {
    const get = (key: string) => configService.get<string>(key);
    this.enabled = isRecruitmentWorkerEnabled(get);
    const read = readRecruitmentWorkerConfig(get);
    this.config = 'config' in read ? read.config : null;
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
    // Lượt đang chạy bị huỷ → ghi lỗi tạm (thử lại ngay ở lần claim sau).
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
        const owner = `${this.workerId}:${randomUUID().slice(0, 8)}`;
        const event = await this.queue.claimNext(
          config.oaId,
          owner,
          config.leaseMs,
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

    const controller = new AbortController();
    this.inFlight.add(controller);
    let leaseLost = false;
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

    try {
      const outcome = await invokeOpenClaw(
        config.openclaw,
        {
          sessionKey: `agent:${config.openclaw.agentId}:zalo:${subject.oaId}:${subject.userId}`,
          input: `[channel=ZALO sender=${subject.userId} msg=${event.providerMessageId}]\n${event.messageText}`,
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

      const result = await this.queue.complete(event, owner, {
        externalRecipientId: subject.userId,
        messageText: reply.text,
        recruitmentMessageId: reply.messageId,
      });
      this.logger.log(
        `worker event=${event.id} attempt=${event.attemptCount} result=${result.completed ? 'PROCESSED' : 'LEASE_LOST'} ` +
          `outbox=${result.outboxId ?? '-'} inbound=${inbound.stored} replyBy=${reply.replyBy} ` +
          `replyMatches=${reply.replyMatches} sender=${maskSender(subject)} ms=${Date.now() - started}`,
      );
    } finally {
      clearInterval(heartbeat);
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
    return { candidateId, stored: saved.duplicate ? 'existing' : 'new' };
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
      kind === 'rejected' ||
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
