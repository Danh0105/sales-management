import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';

import { RecruitmentChannelEvent } from '../entities/recruitment-channel-event.entity';
import { ChannelEventStatus } from '../recruitment.enums';
import {
  isRecruitmentZaloEnabled,
  parseZaloRecruitmentEvent,
  readRecruitmentZaloConfig,
  type NormalizedZaloEvent,
  type RecruitmentZaloConfig,
  type ZaloWebhookRejectCode,
} from './zalo-recruitment-event';

export interface ZaloWebhookAck {
  ok: true;
  duplicate: boolean;
  status: ChannelEventStatus;
}

/**
 * Nhận webhook Zalo OA tuyển dụng: kiểm chữ ký → gắn OA theo cấu hình → chuẩn
 * hoá → ghi event (chống trùng nguyên tử) → ACK.
 *
 * Webhook chỉ **nhận và lưu** (giữ mỏng): không gọi OpenClaw, không gửi tin Zalo,
 * không tạo ứng viên/hội thoại. Event `RECEIVED` mang nội dung tin đã chuẩn hoá và
 * chờ `RecruitmentChannelWorker` xử lý.
 *
 * ACK chỉ trả sau khi dòng event đã nằm trong DB (hoặc DB xác nhận đã có) —
 * lỗi DB thì 503 để Zalo gửi lại, không bao giờ báo thành công giả.
 */
@Injectable()
export class RecruitmentZaloWebhookService {
  private readonly logger = new Logger('RecruitmentZaloWebhook');
  private readonly enabled: boolean;
  private readonly config: RecruitmentZaloConfig | null;

  constructor(
    @InjectRepository(RecruitmentChannelEvent)
    private readonly events: Repository<RecruitmentChannelEvent>,
    configService: ConfigService,
  ) {
    const get = (key: string) => configService.get<string>(key);
    this.enabled = isRecruitmentZaloEnabled(get);
    const read = readRecruitmentZaloConfig(get);
    this.config = 'config' in read ? read.config : null;
  }

  async receive(
    rawBody: Buffer | undefined,
    signature: unknown,
  ): Promise<ZaloWebhookAck> {
    // Cờ tắt: như thể route không tồn tại.
    if (!this.enabled) throw new NotFoundException();
    if (!this.config) {
      // Không tới được khi khởi động qua RecruitmentModule (fail-closed lúc init).
      throw new ServiceUnavailableException({
        code: 'RECRUITMENT_ZALO_MISCONFIGURED',
      });
    }

    const parsed = parseZaloRecruitmentEvent(this.config, rawBody, signature);
    if (!parsed.ok) {
      this.logger.warn(
        `zalo-recruitment rejected code=${parsed.code} type=${parsed.eventType ?? '-'}`,
      );
      throw rejection(parsed.code);
    }

    const event = parsed.event;
    let stored: { id: number | null; duplicate: boolean; samePayload: boolean };
    try {
      stored = await this.store(event);
    } catch (error) {
      // Chỉ tên/mã lỗi — message của driver có thể chứa giá trị tham số.
      this.logger.error(
        `zalo-recruitment store failed type=${event.eventType} oa=${event.channelAccountId} ` +
          `error=${(error as { code?: string }).code ?? (error as Error).name}`,
      );
      throw new ServiceUnavailableException({
        code: 'EVENT_STORE_UNAVAILABLE',
      });
    }

    this.logger.log(
      `zalo-recruitment event=${stored.id ?? '?'} type=${event.eventType} oa=${event.channelAccountId} ` +
        `status=${event.status} duplicate=${stored.duplicate}` +
        (stored.duplicate ? ` samePayload=${stored.samePayload}` : '') +
        ` sender=${maskSender(event)}`,
    );
    return { ok: true, duplicate: stored.duplicate, status: event.status };
  }

  /**
   * Một câu `INSERT ... ON CONFLICT DO NOTHING` — DB quyết định ai là bản ghi duy
   * nhất, không có khoảng hở SELECT-rồi-INSERT. Không có dòng trả về = trùng; khi
   * đó mới đọc dòng cũ, chỉ để ghi log.
   */
  private async store(event: NormalizedZaloEvent) {
    const inserted: Array<{ id: number }> = await this.events.query(
      `INSERT INTO "recruitment_channel_events"
        ("channel", "channel_account_id", "provider_event_id", "dedupe_key", "external_sender_id",
         "event_type", "provider_message_id", "provider_created_at", "status", "payload_hash",
         "normalized_message_text")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT ON CONSTRAINT "UQ_recruitment_channel_events_dedupe" DO NOTHING
       RETURNING "id"`,
      [
        event.channel,
        event.channelAccountId,
        event.providerEventId,
        event.dedupeKey,
        event.externalSenderId,
        event.eventType,
        event.providerMessageId,
        event.providerCreatedAt,
        event.status,
        event.payloadHash,
        event.messageText,
      ],
    );
    if (inserted.length) {
      return { id: inserted[0].id, duplicate: false, samePayload: true };
    }
    const existing = await this.events.findOne({
      where: {
        channel: event.channel,
        channelAccountId: event.channelAccountId,
        dedupeKey: event.dedupeKey,
      },
      select: { id: true, payloadHash: true },
    });
    return {
      id: existing?.id ?? null,
      duplicate: true,
      samePayload: existing?.payloadHash === event.payloadHash,
    };
  }
}

function rejection(code: ZaloWebhookRejectCode): HttpException {
  const body = { code };
  switch (code) {
    case 'INVALID_SIGNATURE':
      return new UnauthorizedException(body);
    case 'APP_MISMATCH':
    case 'OA_MISMATCH':
      return new ForbiddenException(body);
    case 'MALFORMED_PAYLOAD':
    case 'MALFORMED_EVENT':
      return new BadRequestException(body);
  }
}

/** Log không chứa id Zalo thật: 12 ký tự đầu SHA-256 của (OA, người dùng). */
function maskSender(event: NormalizedZaloEvent): string {
  if (!event.externalSenderId) return '-';
  return createHash('sha256')
    .update(`${event.channelAccountId}:${event.externalSenderId}`)
    .digest('hex')
    .slice(0, 12);
}
