import { createHash, timingSafeEqual } from 'crypto';

import { LEGACY_ZALO_OA_ID } from '../ai/recruitment-ai-subject';
import { ChannelEventChannel, ChannelEventStatus } from '../recruitment.enums';

/**
 * Webhook Zalo OA **tuyển dụng** (Phase 3). Hoàn toàn tách khỏi webhook OA giáo
 * viên (`src/zalo-oa`): cấu hình `RECRUITMENT_ZALO_*` riêng, không có cờ tắt
 * kiểm chữ ký.
 *
 * Phần này thuần (không I/O) để test được từng nhánh: raw body → kiểm chữ ký →
 * gắn OA theo cấu hình → chuẩn hoá → khoá chống trùng.
 */

export const ZALO_SIGNATURE_HEADER = 'x-zevent-signature';

export interface RecruitmentZaloConfig {
  appId: string;
  /** OA tuyển dụng — mọi event phải thuộc đúng OA này. */
  oaId: string;
  secretKey: string;
}

export const RECRUITMENT_ZALO_CONFIG_ERROR = 'RECRUITMENT_ZALO_CONFIG_INVALID';

const APP_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Cùng tập ký tự với subject kênh (`zalo:<oaId>:<userId>`) để worker dựng được subject. */
const OA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,100}$/;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TIMESTAMP = /^\d{1,16}$/;
const MIN_SECRET_LENGTH = 16;

/** Event được xử lý tiếp (worker sau này); event hợp lệ khác → `IGNORED`. */
export const SUPPORTED_ZALO_EVENTS: ReadonlySet<string> = new Set([
  'user_send_text',
]);

export function isRecruitmentZaloEnabled(
  get: (key: string) => string | undefined,
): boolean {
  return get('RECRUITMENT_ZALO_ENABLED') === 'true';
}

/**
 * Đọc cấu hình OA tuyển dụng. Trả lỗi chỉ gồm **tên** biến thiếu/sai — không
 * bao giờ kèm giá trị.
 */
export function readRecruitmentZaloConfig(
  get: (key: string) => string | undefined,
): { config: RecruitmentZaloConfig } | { invalid: string[] } {
  const appId = get('RECRUITMENT_ZALO_APP_ID')?.trim() ?? '';
  const oaId = get('RECRUITMENT_ZALO_OA_ID')?.trim() ?? '';
  const secretKey = get('RECRUITMENT_ZALO_OA_SECRET_KEY')?.trim() ?? '';
  const invalid: string[] = [];
  if (!APP_ID.test(appId)) invalid.push('RECRUITMENT_ZALO_APP_ID');
  if (!OA_ID.test(oaId) || oaId === LEGACY_ZALO_OA_ID) {
    invalid.push('RECRUITMENT_ZALO_OA_ID');
  }
  if (secretKey.length < MIN_SECRET_LENGTH) {
    invalid.push('RECRUITMENT_ZALO_OA_SECRET_KEY');
  }
  return invalid.length ? { invalid } : { config: { appId, oaId, secretKey } };
}

/** Fail-closed: bật webhook mà thiếu/sai cấu hình thì app không khởi động. */
export function assertRecruitmentZaloConfig(
  get: (key: string) => string | undefined,
): void {
  if (!isRecruitmentZaloEnabled(get)) return;
  const result = readRecruitmentZaloConfig(get);
  if ('invalid' in result) {
    throw new Error(
      `${RECRUITMENT_ZALO_CONFIG_ERROR}: RECRUITMENT_ZALO_ENABLED=true nhưng thiếu/sai ${result.invalid.join(', ')}`,
    );
  }
}

/**
 * Công thức ký của Zalo OA — giống hệt webhook giáo viên đang chạy
 * (`ZaloOaService.verifySignature`): `sha256(appId + rawBody + timestamp + OASecretKey)`,
 * header `X-ZEvent-Signature: mac=<hex>`. Khác ở chỗ: appId lấy từ **cấu hình**
 * (không tin `app_id` trong payload) và băm trên đúng các byte nhận được.
 */
export function zaloEventMac(
  appId: string,
  rawBody: Buffer,
  timestamp: string,
  secretKey: string,
): string {
  return createHash('sha256')
    .update(appId)
    .update(rawBody)
    .update(timestamp)
    .update(secretKey)
    .digest('hex');
}

export function verifyZaloSignature(
  config: RecruitmentZaloConfig,
  rawBody: Buffer,
  timestamp: string,
  header: unknown,
): boolean {
  if (typeof header !== 'string') return false;
  const received = header.trim().replace(/^mac=/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = zaloEventMac(
    config.appId,
    rawBody,
    timestamp,
    config.secretKey,
  );
  return timingSafeEqual(
    Buffer.from(received, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

export type ZaloWebhookRejectCode =
  /** Không có body thô / không phải JSON object — chưa kiểm được chữ ký. */
  | 'MALFORMED_PAYLOAD'
  | 'INVALID_SIGNATURE'
  /** Chữ ký đúng nhưng `app_id` trong payload khác app đã cấu hình. */
  | 'APP_MISMATCH'
  /** Chữ ký đúng nhưng event không thuộc OA tuyển dụng đã cấu hình. */
  | 'OA_MISMATCH'
  /** Chữ ký đúng nhưng thiếu/sai trường bắt buộc. */
  | 'MALFORMED_EVENT';

export interface NormalizedZaloEvent {
  channel: ChannelEventChannel.ZALO;
  channelAccountId: string;
  providerEventId: null;
  dedupeKey: string;
  externalSenderId: string | null;
  eventType: string;
  providerMessageId: string | null;
  providerCreatedAt: Date | null;
  status: ChannelEventStatus.RECEIVED | ChannelEventStatus.IGNORED;
  payloadHash: string;
}

export type ZaloWebhookResult =
  | { ok: true; event: NormalizedZaloEvent }
  | { ok: false; code: ZaloWebhookRejectCode; eventType?: string };

type Json = Record<string, unknown>;

/**
 * Raw body → event đã chuẩn hoá, theo đúng thứ tự: đọc `timestamp` (cần cho công
 * thức ký) → kiểm chữ ký → `app_id` → OA → các trường. Không trường nào của
 * payload được dùng trước khi chữ ký khớp, ngoài `timestamp` để tính chữ ký.
 */
export function parseZaloRecruitmentEvent(
  config: RecruitmentZaloConfig,
  rawBody: Buffer | undefined,
  signatureHeader: unknown,
  now: Date = new Date(),
): ZaloWebhookResult {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return { ok: false, code: 'MALFORMED_PAYLOAD' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, code: 'MALFORMED_PAYLOAD' };
  }
  if (!isObject(payload)) return { ok: false, code: 'MALFORMED_PAYLOAD' };

  const rawTimestamp = scalar(payload.timestamp);
  if (
    !verifyZaloSignature(config, rawBody, rawTimestamp ?? '', signatureHeader)
  ) {
    return { ok: false, code: 'INVALID_SIGNATURE' };
  }
  if (scalar(payload.app_id) !== config.appId) {
    return { ok: false, code: 'APP_MISMATCH' };
  }

  const eventType = payload.event_name;
  if (typeof eventType !== 'string' || !EVENT_NAME.test(eventType)) {
    return { ok: false, code: 'MALFORMED_EVENT' };
  }

  const parties = partiesOf(eventType, payload);
  const declaredOa = payload.oa_id === undefined ? null : scalar(payload.oa_id);
  if (
    parties.oaId !== config.oaId ||
    (payload.oa_id !== undefined && declaredOa !== config.oaId)
  ) {
    return { ok: false, code: 'OA_MISMATCH', eventType };
  }

  if (!rawTimestamp || !TIMESTAMP.test(rawTimestamp)) {
    return { ok: false, code: 'MALFORMED_EVENT', eventType };
  }
  if (parties.userId !== null && !USER_ID.test(parties.userId)) {
    return { ok: false, code: 'MALFORMED_EVENT', eventType };
  }

  const message = isObject(payload.message) ? payload.message : null;
  const msgId = message ? scalar(message.msg_id) : null;
  if (msgId !== null && !MESSAGE_ID.test(msgId)) {
    return { ok: false, code: 'MALFORMED_EVENT', eventType };
  }

  const supported = SUPPORTED_ZALO_EVENTS.has(eventType);
  if (
    supported &&
    (!parties.senderIsUser ||
      !parties.userId ||
      !msgId ||
      typeof message?.text !== 'string')
  ) {
    return { ok: false, code: 'MALFORMED_EVENT', eventType };
  }

  return {
    ok: true,
    event: {
      channel: ChannelEventChannel.ZALO,
      channelAccountId: config.oaId,
      providerEventId: null,
      dedupeKey: dedupeKeyOf(eventType, msgId, {
        oaId: config.oaId,
        senderId: scalar(objectField(payload.sender, 'id')),
        recipientId: scalar(objectField(payload.recipient, 'id')),
        followerId: scalar(objectField(payload.follower, 'id')),
        timestamp: rawTimestamp,
      }),
      externalSenderId: parties.senderIsUser ? parties.userId : null,
      eventType,
      providerMessageId: msgId,
      providerCreatedAt: providerTime(rawTimestamp, now),
      status: supported
        ? ChannelEventStatus.RECEIVED
        : ChannelEventStatus.IGNORED,
      payloadHash: createHash('sha256').update(rawBody).digest('hex'),
    },
  };
}

/**
 * Vị trí OA và người dùng trong payload theo loại event của Zalo:
 * - `user_*`: người dùng gửi (`sender`), OA nhận (`recipient`);
 * - `oa_*`: OA gửi (`sender`), người dùng nhận (`recipient`);
 * - `follow` / `unfollow`: `oa_id` + `follower`;
 * - loại khác: chỉ tin `oa_id`, không xác định người dùng.
 * Không tìm thấy OA ở đúng vị trí → coi là sai OA (fail-closed).
 */
function partiesOf(
  eventType: string,
  payload: Json,
): { oaId: string | null; userId: string | null; senderIsUser: boolean } {
  const sender = scalar(objectField(payload.sender, 'id'));
  const recipient = scalar(objectField(payload.recipient, 'id'));
  if (eventType.startsWith('user_')) {
    return { oaId: recipient, userId: sender, senderIsUser: true };
  }
  if (eventType.startsWith('oa_')) {
    return { oaId: sender, userId: recipient, senderIsUser: false };
  }
  if (eventType === 'follow' || eventType === 'unfollow') {
    return {
      oaId: scalar(payload.oa_id),
      userId: scalar(objectField(payload.follower, 'id')),
      senderIsUser: true,
    };
  }
  return { oaId: scalar(payload.oa_id), userId: null, senderIsUser: false };
}

/**
 * Ưu tiên id tin ổn định của Zalo (`message.msg_id`); event không có id tin thì
 * băm tất định các trường bất biến đã chuẩn hoá — không băm raw JSON (đổi thứ
 * tự key/khoảng trắng không được đổi khoá), không bao giờ dùng UUID ngẫu nhiên.
 */
function dedupeKeyOf(
  eventType: string,
  msgId: string | null,
  fields: {
    oaId: string;
    senderId: string | null;
    recipientId: string | null;
    followerId: string | null;
    timestamp: string;
  },
): string {
  if (msgId) return `${eventType}:msg:${msgId}`;
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        eventType,
        fields.oaId,
        fields.senderId,
        fields.recipientId,
        fields.followerId,
        fields.timestamp,
      ]),
    )
    .digest('hex');
  return `${eventType}:h:${digest}`;
}

/** `timestamp` của Zalo tính bằng mili giây; giá trị vô lý → không ghi. */
function providerTime(timestamp: string, now: Date): Date | null {
  const ms = Number(timestamp);
  const earliest = Date.UTC(2015, 0, 1);
  const latest = now.getTime() + 24 * 60 * 60 * 1000;
  return ms >= earliest && ms <= latest ? new Date(ms) : null;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectField(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

/** Id/timestamp của Zalo là chuỗi; chấp nhận số nguyên (JSON số), bỏ mọi kiểu khác. */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}
