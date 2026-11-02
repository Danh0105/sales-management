import type { NormalizedZaloEvent } from './zalo-recruitment-event';

/** `DataSource`, `EntityManager` hay `Repository` — chỉ cần `query`. */
export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface StoredChannelEvent {
  id: number | null;
  duplicate: boolean;
  samePayload: boolean;
}

/**
 * Ghi event đã xác minh chữ ký vào inbox — đường DUY NHẤT vào
 * `recruitment_channel_events`, dùng chung cho webhook thường và xác minh hồi tố
 * request cách ly. Một câu `INSERT ... ON CONFLICT DO NOTHING` — DB quyết định ai là
 * bản ghi duy nhất, không có khoảng hở SELECT-rồi-INSERT. Không có dòng trả về =
 * trùng; khi đó mới đọc dòng cũ (để ghi log / liên kết).
 */
export async function insertChannelEvent(
  runner: SqlRunner,
  event: NormalizedZaloEvent,
): Promise<StoredChannelEvent> {
  const inserted = (await runner.query(
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
  )) as Array<{ id: number }>;
  if (inserted.length) {
    return { id: Number(inserted[0].id), duplicate: false, samePayload: true };
  }
  const [existing] = (await runner.query(
    `SELECT "id", "payload_hash" FROM "recruitment_channel_events"
     WHERE "channel" = $1 AND "channel_account_id" = $2 AND "dedupe_key" = $3`,
    [event.channel, event.channelAccountId, event.dedupeKey],
  )) as Array<{ id: number; payload_hash: string }>;
  return {
    id: existing ? Number(existing.id) : null,
    duplicate: true,
    samePayload: existing?.payload_hash === event.payloadHash,
  };
}
