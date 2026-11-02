import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';

import { RecruitmentChannelEvent } from '../entities/recruitment-channel-event.entity';
import { ChannelEventStatus } from '../recruitment.enums';
import {
  RecruitmentZaloQuarantineService,
  type ZaloQuarantineAck,
} from './recruitment-zalo-quarantine.service';
import { insertChannelEvent } from './zalo-channel-event.store';
import { rejection } from './zalo-webhook-rejection';
import {
  isRecruitmentZaloEnabled,
  isRecruitmentZaloQuarantine,
  parseZaloRecruitmentEvent,
  readRecruitmentZaloConfig,
  type NormalizedZaloEvent,
  type RecruitmentZaloConfig,
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
  private readonly quarantineMode: boolean;
  private readonly config: RecruitmentZaloConfig | null;

  constructor(
    @InjectRepository(RecruitmentChannelEvent)
    private readonly events: Repository<RecruitmentChannelEvent>,
    configService: ConfigService,
    private readonly quarantine: RecruitmentZaloQuarantineService,
  ) {
    const get = (key: string) => configService.get<string>(key);
    this.enabled = isRecruitmentZaloEnabled(get);
    this.quarantineMode = isRecruitmentZaloQuarantine(get);
    const read = readRecruitmentZaloConfig(get);
    this.config = 'config' in read ? read.config : null;
  }

  async receive(
    rawBody: Buffer | undefined,
    signature: unknown,
  ): Promise<ZaloWebhookAck | ZaloQuarantineAck> {
    // Cờ tắt: như thể route không tồn tại.
    if (!this.enabled) throw new NotFoundException();
    // Chưa có OA secret key (P3-7.2A): chỉ ghi cách ly, không xử lý.
    if (this.quarantineMode) return this.quarantine.receive(rawBody, signature);
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

  /** Đường ghi inbox dùng chung (chống trùng nguyên tử) — xem `insertChannelEvent`. */
  private store(event: NormalizedZaloEvent) {
    return insertChannelEvent(this.events, event);
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
