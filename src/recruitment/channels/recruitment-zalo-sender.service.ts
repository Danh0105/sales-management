import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { hostname } from 'os';
import { DataSource } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import { SYSTEM_ACTOR } from '../recruitment.roles';
import {
  RecruitmentChannelOutboxQueue,
  type ClaimedOutbox,
} from './recruitment-channel-outbox.queue';
import { retryDelayMs } from './recruitment-channel-worker.config';
import { RecruitmentHrAlertService } from './recruitment-hr-alert.service';
import {
  RecruitmentZaloCredentialStore,
  ZaloCredentialError,
  type ZaloAccessToken,
} from './recruitment-zalo-credential.store';
import {
  isZaloOutboundEnabled,
  readZaloOutboundConfig,
  type ZaloOutboundConfig,
} from './zalo-outbound.config';
import {
  classifySend,
  postRequest,
  type SendClassification,
} from './zalo-send.transport';

const RECIPIENT = /^[A-Za-z0-9_-]{1,100}$/;

type Outcome =
  | { status: 'SENT'; providerMessageId: string | null }
  | { status: 'RETRY'; code: string }
  | { status: 'UNKNOWN'; code: string }
  | { status: 'DEAD_LETTER'; code: string };

/**
 * Sender: `recruitment_channel_outbox` → Zalo Send API của OA **tuyển dụng**.
 *
 * Nguồn gửi DUY NHẤT ra Zalo cho luồng tuyển dụng. Chạy khi và chỉ khi
 * `RECRUITMENT_ZALO_OUTBOUND_ENABLED=true` (kill switch, mặc định tắt) — tắt thì
 * không vòng lặp nào chạy và `send()` từ chối trước khi mở kết nối.
 *
 * Mỗi dòng: kiểm (kênh, OA tuyển dụng, người nhận, tin canonical còn đúng hội
 * thoại/ứng viên, nội dung) → token (refresh sớm nếu sắp hết hạn) → ghi bền
 * `dispatched_at` → gửi → phân loại:
 * - SENT → lưu id tin Zalo, xoá bản sao nội dung;
 * - chắc chắn chưa đi (429, 5xx, lỗi trước kết nối) → RETRY + backoff;
 * - token hỏng → refresh (có khoá, một lần cho mọi sender) rồi gửi lại một lần;
 * - Zalo từ chối hẳn / dữ liệu sai → DEAD_LETTER;
 * - có thể đã tới Zalo (mất kết nối, hết giờ sau khi gửi) → UNKNOWN, không gửi lại.
 */
@Injectable()
export class RecruitmentZaloSender
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('RecruitmentZaloSender');
  private readonly enabled: boolean;
  private readonly config: ZaloOutboundConfig | null;
  private readonly senderId = `${hostname().slice(0, 60)}:${process.pid}:${randomUUID().slice(0, 6)}`;
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    configService: ConfigService,
    private readonly queue: RecruitmentChannelOutboxQueue,
    private readonly credentials: RecruitmentZaloCredentialStore,
    private readonly audit: RecruitmentAuditService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly alerts: RecruitmentHrAlertService,
  ) {
    const get = (key: string) => configService.get<string>(key);
    this.enabled = isZaloOutboundEnabled(get);
    const read = readZaloOutboundConfig(get);
    this.config = 'config' in read ? read.config : null;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || !this.config) return;
    this.running = true;
    this.logger.log(
      `sender start id=${this.senderId} oa=${this.config.oaId} slots=${this.config.concurrency}`,
    );
    for (let slot = 0; slot < this.config.concurrency; slot++) {
      this.loops.push(this.loop(slot, this.config));
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
  }

  private async loop(slot: number, config: ZaloOutboundConfig) {
    let nextMaintenance = 0;
    while (this.running) {
      try {
        if (slot === 0 && Date.now() >= nextMaintenance) {
          nextMaintenance = Date.now() + Math.max(config.pollMs * 5, 2_000);
          await this.maintenance(config);
        }
        const owner = `${this.senderId}:${randomUUID().slice(0, 8)}`;
        const row = await this.queue.claimNext(
          config.oaId,
          owner,
          config.leaseMs,
        );
        if (!row) {
          await sleep(config.pollMs + Math.floor(Math.random() * 200));
          continue;
        }
        await this.process(row, owner, config);
      } catch (error) {
        this.logger.error(`sender loop error=${errorCode(error)}`);
        await sleep(config.pollMs);
      }
    }
  }

  /** Một dòng outbox đã claim. Public để test. */
  async process(
    row: ClaimedOutbox,
    owner: string,
    config: ZaloOutboundConfig,
  ): Promise<void> {
    const started = Date.now();
    const invalid = await this.validate(row, config);
    if (invalid) {
      return this.finish(
        row,
        owner,
        config,
        { status: 'DEAD_LETTER', code: invalid },
        started,
      );
    }

    let token: ZaloAccessToken;
    try {
      token = await this.credentials.accessToken(config);
    } catch (error) {
      // Chưa mở kết nối gửi tin → thử lại an toàn.
      return this.finish(
        row,
        owner,
        config,
        { status: 'RETRY', code: credentialCode(error) },
        started,
      );
    }

    if (!(await this.queue.markDispatched(row.id, owner))) {
      this.logger.warn(`sender outbox=${row.id} lease lost trước khi gửi — bỏ`);
      return;
    }
    const heartbeat = setInterval(
      () =>
        void this.queue
          .heartbeat(row.id, owner, config.leaseMs)
          .catch(() => undefined),
      Math.max(1000, Math.floor(config.leaseMs / 3)),
    );
    try {
      let result = await this.send(row, token.accessToken, config);
      if (result.result === 'TOKEN_INVALID') {
        try {
          token = await this.credentials.refresh(config, token.version);
        } catch (error) {
          return this.finish(
            row,
            owner,
            config,
            { status: 'RETRY', code: credentialCode(error) },
            started,
          );
        }
        result = await this.send(row, token.accessToken, config);
        if (result.result === 'TOKEN_INVALID') {
          return this.finish(
            row,
            owner,
            config,
            { status: 'RETRY', code: 'CREDENTIAL_INVALID' },
            started,
          );
        }
      }
      return this.finish(
        row,
        owner,
        config,
        this.outcomeOf(result, row, config),
        started,
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Lần gọi mạng duy nhất ra Zalo của luồng tuyển dụng — kill switch kiểm ngay tại đây. */
  private async send(
    row: ClaimedOutbox,
    accessToken: string,
    config: ZaloOutboundConfig,
  ): Promise<SendClassification> {
    if (!this.enabled || row.channelAccountId !== config.oaId) {
      return { result: 'RETRY', code: 'OUTBOUND_DISABLED' };
    }
    const outcome = await postRequest(
      `${config.apiUrl.replace(/\/+$/, '')}/v3.0/oa/message/cs`,
      { 'Content-Type': 'application/json', access_token: accessToken },
      JSON.stringify({
        recipient: { user_id: row.externalRecipientId },
        message: { text: row.messageText },
      }),
      {
        connectTimeoutMs: config.connectTimeoutMs,
        responseTimeoutMs: config.responseTimeoutMs,
      },
    );
    return classifySend(outcome, config);
  }

  private outcomeOf(
    result: SendClassification,
    row: ClaimedOutbox,
    config: ZaloOutboundConfig,
  ): Outcome {
    switch (result.result) {
      case 'SENT':
        return { status: 'SENT', providerMessageId: result.providerMessageId };
      case 'RETRY':
        return { status: 'RETRY', code: result.code };
      case 'UNKNOWN':
        return { status: 'UNKNOWN', code: result.code };
      case 'TOKEN_INVALID':
        return { status: 'RETRY', code: 'CREDENTIAL_INVALID' };
      case 'REJECTED':
        return result.permanent || row.attemptCount >= config.maxRejectAttempts
          ? { status: 'DEAD_LETTER', code: result.code }
          : { status: 'RETRY', code: result.code };
    }
  }

  /**
   * Chỉ gửi khi mọi thứ khớp với dữ liệu tin cậy trong DB — người nhận KHÔNG lấy
   * từ nội dung/model: tin canonical phải là tin đi của AI trong hội thoại ZALO
   * `<OA>:<người nhận>` của đúng ứng viên (OA, người nhận), cùng nội dung.
   */
  private async validate(
    row: ClaimedOutbox,
    config: ZaloOutboundConfig,
  ): Promise<string | null> {
    if (row.channelAccountId !== config.oaId) return 'OA_MISMATCH';
    if (!RECIPIENT.test(row.externalRecipientId)) return 'RECIPIENT_INVALID';
    const text = row.messageText?.trim() ?? '';
    if (!text) return 'EMPTY_MESSAGE';
    if (text.length > config.maxTextLength) return 'MESSAGE_TOO_LONG';
    if (!row.recruitmentMessageId) return 'CANONICAL_MISSING';

    const [canonical]: Array<{
      content: string;
      direction: string;
      sender_type: string;
      channel: string;
      external_conversation_id: string | null;
      zalo_oa_id: string | null;
      zalo_user_id: string | null;
    }> = await this.dataSource.query(
      `SELECT m.content, m.direction, m.sender_type, c.channel, c.external_conversation_id,
              cand.zalo_oa_id, cand.zalo_user_id
       FROM "recruitment_messages" m
       JOIN "recruitment_conversations" c ON c.id = m.conversation_id
       JOIN "recruitment_candidates" cand ON cand.id = c.candidate_id
       WHERE m.id = $1`,
      [row.recruitmentMessageId],
    );
    if (!canonical) return 'CANONICAL_MISSING';
    // Tin AI phải là tin đi của AI; tin HR phải là tin đi do HR viết.
    const expectedSender = row.sourceType === 'HR_MESSAGE' ? 'HR' : 'AI';
    if (
      canonical.direction !== 'OUTBOUND' ||
      canonical.sender_type !== expectedSender
    ) {
      return 'CANONICAL_INVALID';
    }
    if (
      canonical.channel !== 'ZALO' ||
      canonical.external_conversation_id !==
        `${config.oaId}:${row.externalRecipientId}` ||
      canonical.zalo_oa_id !== config.oaId ||
      canonical.zalo_user_id !== row.externalRecipientId
    ) {
      return 'RECIPIENT_MISMATCH';
    }
    if (canonical.content.trim() !== text) return 'CANONICAL_MISMATCH';
    return null;
  }

  private async finish(
    row: ClaimedOutbox,
    owner: string,
    config: ZaloOutboundConfig,
    outcome: Outcome,
    started: number,
  ): Promise<void> {
    let written: boolean;
    switch (outcome.status) {
      case 'SENT':
        written = await this.queue.markSent(
          row.id,
          owner,
          outcome.providerMessageId,
        );
        break;
      case 'RETRY':
        written = await this.queue.markRetry(
          row.id,
          owner,
          outcome.code,
          retryDelayMs(config, row.attemptCount),
        );
        break;
      case 'UNKNOWN':
        written = await this.queue.markUnknown(row.id, owner, outcome.code);
        break;
      case 'DEAD_LETTER':
        written = await this.queue.markDeadLetter(row.id, owner, outcome.code);
        break;
    }
    const code = 'code' in outcome ? outcome.code : '-';
    const line =
      `sender outbox=${row.id} attempt=${row.attemptCount} result=${outcome.status} code=${code} ` +
      `recipient=${maskRecipient(config.oaId, row.externalRecipientId)} ms=${Date.now() - started}` +
      (written ? '' : ' (lease lost)');
    if (outcome.status === 'SENT') this.logger.log(line);
    else this.logger.warn(line);

    if (
      written &&
      (outcome.status === 'UNKNOWN' || outcome.status === 'DEAD_LETTER')
    ) {
      await this.record(row.id, outcome.status, code);
    }
  }

  private async maintenance(config: ZaloOutboundConfig) {
    try {
      await this.alerts.sweep();
    } catch (error) {
      this.logger.error(`sender hr-alert sweep error=${errorCode(error)}`);
    }
    for (const id of await this.queue.recoverDispatched(config.oaId)) {
      this.logger.warn(
        `sender outbox=${id} result=UNKNOWN code=LEASE_EXPIRED_AFTER_DISPATCH (sender chết sau khi gửi)`,
      );
      await this.record(id, 'UNKNOWN', 'LEASE_EXPIRED_AFTER_DISPATCH');
    }
    for (const id of await this.queue.expireRetention(config.oaId)) {
      this.logger.warn(
        `sender outbox=${id} result=DEAD_LETTER code=RETENTION_EXPIRED`,
      );
      await this.record(id, 'DEAD_LETTER', 'RETENTION_EXPIRED');
    }
  }

  /** Dấu vết cho HR/vận hành — chỉ metadata, không nội dung, không người nhận. */
  private async record(
    outboxId: number,
    status: 'UNKNOWN' | 'DEAD_LETTER',
    code: string,
  ) {
    try {
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action:
          status === 'UNKNOWN'
            ? 'CHANNEL_OUTBOX_UNKNOWN'
            : 'CHANNEL_OUTBOX_DEAD_LETTER',
        entity: 'channel-outbox',
        entityId: outboxId,
        context: { code, status },
        success: false,
      });
    } catch (error) {
      this.logger.error(
        `sender outbox=${outboxId} audit failed error=${errorCode(error)}`,
      );
    }
  }
}

function credentialCode(error: unknown): string {
  return error instanceof ZaloCredentialError ? error.code : 'CREDENTIAL_ERROR';
}

function maskRecipient(oaId: string, recipient: string): string {
  return createHash('sha256')
    .update(`${oaId}:${recipient}`)
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
