import { createHash, timingSafeEqual } from 'crypto';

import { LEGACY_ZALO_OA_ID } from '../ai/recruitment-ai-subject';
import { ChannelEventChannel, ChannelEventStatus } from '../recruitment.enums';
import { decodeKey } from './zalo-outbound.config';

/**
 * Webhook Zalo OA **tuyển dụng** (Phase 3). Hoàn toàn tách khỏi webhook OA giáo
 * viên (`src/zalo-oa`): cấu hình `RECRUITMENT_ZALO_*` riêng, không có cờ tắt
 * kiểm chữ ký.
 *
 * Phần này thuần (không I/O) để test được từng nhánh: raw body → kiểm chữ ký →
 * gắn OA theo cấu hình → chuẩn hoá → khoá chống trùng.
 */

export const ZALO_SIGNATURE_HEADER = 'x-zevent-signature';

/** App + OA tuyển dụng trong cấu hình server — dùng được cả khi chưa có OA secret key. */
export interface ZaloBinding {
  appId: string;
  /** OA tuyển dụng — mọi event phải thuộc đúng OA này. */
  oaId: string;
}

export interface RecruitmentZaloConfig extends ZaloBinding {
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
/** Bằng giới hạn `content` của tin nhắn tuyển dụng (`AiSaveMessageDto`). */
export const MAX_MESSAGE_TEXT_LENGTH = 10000;

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
 * P3-7.2A — chế độ cách ly (bootstrap khi Zalo chỉ cấp OA secret key sau khi URL
 * webhook trả 200). Chỉ hợp lệ khi CHƯA có OA secret key; xem
 * `RecruitmentZaloQuarantineService`.
 */
export function isRecruitmentZaloQuarantine(
  get: (key: string) => string | undefined,
): boolean {
  return get('RECRUITMENT_ZALO_WEBHOOK_QUARANTINE') === 'true';
}

/** App + OA (không cần secret). Lỗi chỉ gồm **tên** biến — không bao giờ kèm giá trị. */
export function readRecruitmentZaloBinding(
  get: (key: string) => string | undefined,
): { binding: ZaloBinding } | { invalid: string[] } {
  const appId = get('RECRUITMENT_ZALO_APP_ID')?.trim() ?? '';
  const oaId = get('RECRUITMENT_ZALO_OA_ID')?.trim() ?? '';
  const invalid: string[] = [];
  if (!APP_ID.test(appId)) invalid.push('RECRUITMENT_ZALO_APP_ID');
  if (!OA_ID.test(oaId) || oaId === LEGACY_ZALO_OA_ID) {
    invalid.push('RECRUITMENT_ZALO_OA_ID');
  }
  return invalid.length ? { invalid } : { binding: { appId, oaId } };
}

/**
 * Đọc cấu hình OA tuyển dụng. Trả lỗi chỉ gồm **tên** biến thiếu/sai — không
 * bao giờ kèm giá trị.
 */
export function readRecruitmentZaloConfig(
  get: (key: string) => string | undefined,
): { config: RecruitmentZaloConfig } | { invalid: string[] } {
  const bound = readRecruitmentZaloBinding(get);
  const secretKey = get('RECRUITMENT_ZALO_OA_SECRET_KEY')?.trim() ?? '';
  const invalid = 'invalid' in bound ? [...bound.invalid] : [];
  if (secretKey.length < MIN_SECRET_LENGTH) {
    invalid.push('RECRUITMENT_ZALO_OA_SECRET_KEY');
  }
  return invalid.length || !('binding' in bound)
    ? { invalid }
    : { config: { ...bound.binding, secretKey } };
}

/**
 * Cấu hình chế độ cách ly: app + OA + khoá mã hoá (`RECRUITMENT_ZALO_TOKEN_KEY`), và
 * OA secret key PHẢI trống — đã có key thì dùng receiver kiểm chữ ký bình thường.
 */
export function readRecruitmentZaloQuarantineConfig(
  get: (key: string) => string | undefined,
): { binding: ZaloBinding; key: Buffer } | { invalid: string[] } {
  const bound = readRecruitmentZaloBinding(get);
  const invalid = 'invalid' in bound ? [...bound.invalid] : [];
  if ((get('RECRUITMENT_ZALO_OA_SECRET_KEY')?.trim() ?? '') !== '') {
    invalid.push(
      'RECRUITMENT_ZALO_OA_SECRET_KEY (phải trống khi bật quarantine)',
    );
  }
  const key = decodeKey(get('RECRUITMENT_ZALO_TOKEN_KEY')?.trim() ?? '');
  if (!key) invalid.push('RECRUITMENT_ZALO_TOKEN_KEY');
  return invalid.length || !key || !('binding' in bound)
    ? { invalid }
    : { binding: bound.binding, key };
}

/** Fail-closed: bật webhook mà thiếu/sai cấu hình thì app không khởi động. */
export function assertRecruitmentZaloConfig(
  get: (key: string) => string | undefined,
): void {
  if (!isRecruitmentZaloEnabled(get)) return;
  const quarantine = isRecruitmentZaloQuarantine(get);
  const result = quarantine
    ? readRecruitmentZaloQuarantineConfig(get)
    : readRecruitmentZaloConfig(get);
  if ('invalid' in result) {
    throw new Error(
      `${RECRUITMENT_ZALO_CONFIG_ERROR}: RECRUITMENT_ZALO_ENABLED=true${quarantine ? ' + RECRUITMENT_ZALO_WEBHOOK_QUARANTINE=true' : ''} nhưng thiếu/sai ${result.invalid.join(', ')}`,
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
  /** Chỉ event `RECEIVED` mới mang nội dung (để worker xử lý); event khác luôn `null`. */
  messageText: string | null;
  payloadHash: string;
}

export type ZaloWebhookResult =
  | { ok: true; event: NormalizedZaloEvent }
  | { ok: false; code: ZaloWebhookRejectCode; eventType?: string };

type Json = Record<string, unknown>;

/** Body thô → JSON object; chưa đọc trường nào. */
export function parseZaloPayload(
  rawBody: Buffer | undefined,
): { ok: true; payload: Json } | { ok: false; code: 'MALFORMED_PAYLOAD' } {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return { ok: false, code: 'MALFORMED_PAYLOAD' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, code: 'MALFORMED_PAYLOAD' };
  }
  return isObject(payload)
    ? { ok: true, payload }
    : { ok: false, code: 'MALFORMED_PAYLOAD' };
}

/**
 * `app_id` → `event_name` → OA ở đúng vị trí theo loại event. Dùng sau khi chữ ký
 * khớp (receiver thường) hoặc — ở chế độ cách ly — để chỉ nhận vào cách ly event
 * khai đúng app + OA tuyển dụng.
 */
export function checkZaloBinding(
  binding: ZaloBinding,
  payload: Json,
):
  | { ok: true; eventType: string }
  | {
      ok: false;
      code: 'APP_MISMATCH' | 'MALFORMED_EVENT' | 'OA_MISMATCH';
      eventType?: string;
    } {
  if (scalar(payload.app_id) !== binding.appId) {
    return { ok: false, code: 'APP_MISMATCH' };
  }
  const eventType = payload.event_name;
  if (typeof eventType !== 'string' || !EVENT_NAME.test(eventType)) {
    return { ok: false, code: 'MALFORMED_EVENT' };
  }
  const parties = partiesOf(eventType, payload);
  const declaredOa = payload.oa_id === undefined ? null : scalar(payload.oa_id);
  if (
    parties.oaId !== binding.oaId ||
    (payload.oa_id !== undefined && declaredOa !== binding.oaId)
  ) {
    return { ok: false, code: 'OA_MISMATCH', eventType };
  }
  return { ok: true, eventType };
}

/**
 * Chẩn đoán `OA_MISMATCH` để ghi log: OA đọc ở vị trí theo loại event (`party_oa`) và
 * `oa_id` khai báo (`declared_oa`), mỗi cái là `match` / `none` / `absent` hoặc
 * fingerprint sha256[:10] — KHÔNG bao giờ trả id thô.
 */
export function describeZaloOaMismatch(
  binding: ZaloBinding,
  eventType: string,
  payload: Json,
): string {
  const label = (value: string | null) =>
    value === null
      ? 'none'
      : value === binding.oaId
        ? 'match'
        : createHash('sha256').update(value).digest('hex').slice(0, 10);
  const declared =
    payload.oa_id === undefined ? 'absent' : label(scalar(payload.oa_id));
  return `party_oa=${label(partiesOf(eventType, payload).oaId)} declared_oa=${declared}`;
}

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
  const decoded = parseZaloPayload(rawBody);
  if (!decoded.ok) return decoded;
  const payload = decoded.payload;
  const body = rawBody as Buffer;

  const rawTimestamp = scalar(payload.timestamp);
  if (!verifyZaloSignature(config, body, rawTimestamp ?? '', signatureHeader)) {
    return { ok: false, code: 'INVALID_SIGNATURE' };
  }
  const bound = checkZaloBinding(config, payload);
  if (!bound.ok) return bound;
  const eventType = bound.eventType;
  const parties = partiesOf(eventType, payload);

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
  const messageText = supported
    ? normalizeMessageText(message?.text as string)
    : null;
  if (messageText !== null && messageText.length > MAX_MESSAGE_TEXT_LENGTH) {
    return { ok: false, code: 'MALFORMED_EVENT', eventType };
  }
  // Tin chỉ có khoảng trắng/ký tự điều khiển: hợp lệ nhưng không có gì để trả lời.
  const status =
    supported && messageText
      ? ChannelEventStatus.RECEIVED
      : ChannelEventStatus.IGNORED;

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
      status,
      messageText: status === ChannelEventStatus.RECEIVED ? messageText : null,
      payloadHash: createHash('sha256').update(body).digest('hex'),
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

/**
 * Nội dung tin đưa cho worker: Unicode NFC (tiếng Việt gõ tổ hợp/dựng sẵn về một
 * dạng), xuống dòng `\n`, bỏ ký tự điều khiển (trừ xuống dòng/tab), bỏ khoảng
 * trắng hai đầu. Không đổi chữ — đây là lời ứng viên.
 */
export function normalizeMessageText(text: string): string {
  return (
    text
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
  );
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
