import {
  ConflictException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';

import { RecruitmentAuditService } from '../recruitment-audit.service';
import type { RecruitmentActor } from '../recruitment.roles';
import { returnedRows } from './recruitment-channel-event.queue';
import { insertChannelEvent } from './zalo-channel-event.store';
import {
  checkZaloBinding,
  isRecruitmentZaloEnabled,
  isRecruitmentZaloQuarantine,
  parseZaloPayload,
  parseZaloRecruitmentEvent,
  readRecruitmentZaloConfig,
  readRecruitmentZaloQuarantineConfig,
  type ZaloBinding,
} from './zalo-recruitment-event';
import { decodeKey } from './zalo-outbound.config';
import { decryptToken, encryptToken } from './zalo-token.crypto';
import { rejection } from './zalo-webhook-rejection';

/** Giữ request cách ly tối đa chừng này rồi xoá nội dung (chưa xác minh = không dùng). */
export const QUARANTINE_RETENTION_HOURS = 72;
/**
 * Endpoint công khai, app id + OA id không bí mật → ai cũng gửi được request không chữ ký
 * vào cách ly. Giới hạn kích thước mỗi request và số dòng để chặn nhồi dung lượng
 * (tối đa ~2000 × 64 KB, tự xoá sau 72 giờ). Event Zalo thật nhỏ hơn nhiều.
 */
const DEFAULT_MAX_ROWS = 2000;
export const QUARANTINE_MAX_BODY_BYTES = 64 * 1024;
/** Advisory lock tuần tự hoá việc ghi cách ly (đếm trần + chèn). */
const QUARANTINE_LOCK_KEY = 'recruitment_channel_quarantine:insert';
const SIGNATURE_MAX_LENGTH = 200;
const VERIFY_BATCH = 100;
const EXPIRE_EVERY_MS = 10 * 60 * 1000;

export interface ZaloQuarantineAck {
  ok: true;
  quarantined: true;
  duplicate: boolean;
}

export interface QuarantineVerifyResult {
  /** Chữ ký khớp → đã vào inbox (mới). */
  verified: number;
  /** Chữ ký khớp nhưng inbox đã có event này (Zalo gửi lại sau khi có key). */
  duplicates: number;
  /** Theo mã: INVALID_SIGNATURE, MALFORMED_EVENT, INTEGRITY… — nội dung đã xoá. */
  rejected: Record<string, number>;
  expired: number;
  /** Không giải mã được (sai `RECRUITMENT_ZALO_TOKEN_KEY`?) — GIỮ NGUYÊN để sửa key rồi chạy lại. */
  undecryptable: number;
  /**
   * Lỗi giữa chừng (DB…) khi xử lý dòng: transaction của dòng đã rollback → dòng vẫn
   * `QUARANTINED` nguyên bản mã, không mất, không vào inbox dở dang — chạy lại sau.
   */
  failed: number;
  /** Còn `QUARANTINED` sau lần chạy. */
  remaining: number;
}

interface QuarantineRow {
  id: number;
  channel_account_id: string;
  payload_hash: string;
  signature: string | null;
  body_enc: string;
}

/**
 * Chế độ cách ly webhook Zalo OA tuyển dụng (P3-7.2A) — bootstrap khi Zalo chỉ cấp OA
 * secret key SAU khi URL webhook trả 200, nên chưa kiểm được chữ ký.
 *
 * Nhận (`RECRUITMENT_ZALO_WEBHOOK_QUARANTINE=true`, chưa có secret key):
 * - body phải là JSON object, khai đúng `app_id` + OA tuyển dụng (như receiver thường);
 * - ghi bền body thô **mã hoá** + header chữ ký, COMMIT xong mới trả 200; lỗi DB → 503
 *   (Zalo gửi lại); bảng đầy (`RECRUITMENT_ZALO_QUARANTINE_MAX_ROWS`, mặc định 2000) → 503;
 *   request > 64 KB → 413;
 * - KHÔNG xử lý: không inbox, không worker, không ứng viên/hội thoại.
 *
 * Xác minh hồi tố (có secret key, tắt quarantine): thao tác vận hành tường minh tính
 * lại chữ ký trên đúng body thô đã lưu → khớp: đi tiếp vào inbox bằng đường ghi
 * chung (chống trùng như thường) → không khớp: xoá nội dung. Quá 72 giờ: xoá nội dung.
 */
@Injectable()
export class RecruitmentZaloQuarantineService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('RecruitmentZaloQuarantine');
  private readonly enabled: boolean;
  private readonly receiving: { binding: ZaloBinding; key: Buffer } | null;
  private readonly maxRows: number;
  private readonly get: (key: string) => string | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    configService: ConfigService,
    private readonly audit: RecruitmentAuditService,
  ) {
    this.get = (key: string) => configService.get<string>(key);
    this.enabled = isRecruitmentZaloEnabled(this.get);
    const read = isRecruitmentZaloQuarantine(this.get)
      ? readRecruitmentZaloQuarantineConfig(this.get)
      : null;
    this.receiving = read && 'binding' in read ? read : null;
    const max = Number(this.get('RECRUITMENT_ZALO_QUARANTINE_MAX_ROWS'));
    this.maxRows =
      Number.isInteger(max) && max > 0 && max <= 100_000
        ? max
        : DEFAULT_MAX_ROWS;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    void this.expire();
    this.timer = setInterval(() => void this.expire(), EXPIRE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async receive(
    rawBody: Buffer | undefined,
    signature: unknown,
  ): Promise<ZaloQuarantineAck> {
    if (!this.receiving) {
      // Không tới được khi khởi động qua RecruitmentModule (fail-closed lúc init).
      throw new ServiceUnavailableException({
        code: 'RECRUITMENT_ZALO_MISCONFIGURED',
      });
    }
    const signed = typeof signature === 'string' && signature.trim() !== '';
    const size = Buffer.isBuffer(rawBody) ? rawBody.length : 0;
    if (size > QUARANTINE_MAX_BODY_BYTES) {
      this.logger.warn(
        `zalo-recruitment quarantine rejected code=PAYLOAD_TOO_LARGE sig=${signed ? 'present' : 'absent'} bytes=${size}`,
      );
      throw new PayloadTooLargeException({ code: 'PAYLOAD_TOO_LARGE' });
    }
    const decoded = parseZaloPayload(rawBody);
    const bound = decoded.ok
      ? checkZaloBinding(this.receiving.binding, decoded.payload)
      : decoded;
    if (!bound.ok) {
      this.logger.warn(
        `zalo-recruitment quarantine rejected code=${bound.code} type=${('eventType' in bound && bound.eventType) || '-'} ` +
          `sig=${signed ? 'present' : 'absent'} bytes=${size}`,
      );
      throw rejection(bound.code);
    }

    const body = rawBody as Buffer;
    const { binding, key } = this.receiving;
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const bodyEnc = encryptToken(
      key,
      quarantineAad(binding.oaId, payloadHash),
      body.toString('base64'),
    );
    const header = signed
      ? signature.trim().slice(0, SIGNATURE_MAX_LENGTH)
      : null;

    let outcome: { id: number; duplicate: boolean };
    try {
      outcome = await this.store(
        binding.oaId,
        payloadHash,
        header,
        bound.eventType,
        size,
        bodyEnc,
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.error(
        `zalo-recruitment quarantine store failed type=${bound.eventType} ` +
          `error=${(error as { code?: string }).code ?? (error as Error).name}`,
      );
      throw new ServiceUnavailableException({
        code: 'EVENT_STORE_UNAVAILABLE',
      });
    }
    this.logger.log(
      `zalo-recruitment quarantined id=${outcome.id} type=${bound.eventType} duplicate=${outcome.duplicate} ` +
        `sig=${signed ? 'present' : 'absent'} bytes=${size}`,
    );
    return { ok: true, quarantined: true, duplicate: outcome.duplicate };
  }

  /**
   * Ghi trong một transaction giữ advisory lock của bảng cách ly: đếm + chèn được tuần tự
   * hoá nên trần `maxRows` CHÍNH XÁC cả khi nhiều request tới cùng lúc (đếm-rồi-chèn trong
   * một câu ở READ COMMITTED để hai request cùng thấy "còn chỗ" và vượt trần). Trùng
   * payload → không ghi. Không có dòng trả về → đọc lại: có dòng cùng hash = trùng (200),
   * không có = bảng đầy (503, Zalo gửi lại sau). Không bao giờ xoá dòng cũ để nhường chỗ.
   */
  private async store(
    oaId: string,
    payloadHash: string,
    signature: string | null,
    eventType: string,
    size: number,
    bodyEnc: string,
  ): Promise<{ id: number; duplicate: boolean }> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        QUARANTINE_LOCK_KEY,
      ]);
      const inserted = await em.query<Array<{ id: number }>>(
        `INSERT INTO "recruitment_channel_quarantine"
           ("channel", "channel_account_id", "payload_hash", "signature", "event_type", "body_size", "body_enc")
         SELECT 'ZALO', $1, $2, $3, $4, $5, $6
         WHERE (SELECT count(*) FROM "recruitment_channel_quarantine" WHERE "status" = 'QUARANTINED') < $7
         ON CONFLICT ON CONSTRAINT "UQ_recruitment_channel_quarantine_payload" DO NOTHING
         RETURNING "id"`,
        [oaId, payloadHash, signature, eventType, size, bodyEnc, this.maxRows],
      );
      if (inserted.length) {
        return { id: Number(inserted[0].id), duplicate: false };
      }
      const [existing] = await em.query<Array<{ id: number }>>(
        `SELECT "id" FROM "recruitment_channel_quarantine"
         WHERE "channel" = 'ZALO' AND "channel_account_id" = $1 AND "payload_hash" = $2`,
        [oaId, payloadHash],
      );
      if (existing) return { id: Number(existing.id), duplicate: true };
      this.logger.error(
        `zalo-recruitment quarantine full (max=${this.maxRows}) — 503, Zalo sẽ gửi lại`,
      );
      throw new ServiceUnavailableException({ code: 'QUARANTINE_FULL' });
    });
  }

  /** Quá hạn giữ → xoá nội dung, giữ hash + metadata. Trả số dòng vừa hết hạn. */
  async expire(): Promise<number> {
    try {
      const expired = returnedRows<{ id: number }>(
        await this.dataSource.query(
          `UPDATE "recruitment_channel_quarantine"
         SET "status" = 'EXPIRED', "body_enc" = NULL, "resolved_at" = now(),
             "resolution_code" = 'RETENTION_EXPIRED', "updated_at" = now()
         WHERE "status" = 'QUARANTINED'
           AND "received_at" < now() - interval '${QUARANTINE_RETENTION_HOURS} hours'
         RETURNING "id"`,
        ),
      );
      if (expired.length) {
        this.logger.warn(
          `zalo-recruitment quarantine expired=${expired.length} (quá ${QUARANTINE_RETENTION_HOURS} giờ chưa xác minh — đã xoá nội dung)`,
        );
      }
      return expired.length;
    } catch (error) {
      this.logger.error(
        `zalo-recruitment quarantine expire failed error=${(error as { code?: string }).code ?? (error as Error).name}`,
      );
      return 0;
    }
  }

  /** Số dòng theo trạng thái + thời điểm nhận sớm nhất còn cách ly — không nội dung. */
  async stats(): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query<
      Array<{ status: string; count: number; oldest: Date }>
    >(
      `SELECT "status", count(*)::int AS "count", min("received_at") AS "oldest"
       FROM "recruitment_channel_quarantine" GROUP BY "status"`,
    );
    const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
    return {
      mode: this.receiving ? 'QUARANTINE' : 'NORMAL',
      retentionHours: QUARANTINE_RETENTION_HOURS,
      counts,
      oldestQuarantinedAt:
        rows.find((r) => r.status === 'QUARANTINED')?.oldest ?? null,
    };
  }

  /**
   * Xác minh hồi tố toàn bộ request đang cách ly. Chỉ chạy khi đã có OA secret key và
   * đã TẮT quarantine (receiver thường đang kiểm chữ ký). Mỗi dòng một transaction:
   * khoá dòng → giải mã → kiểm toàn vẹn → kiểm chữ ký + chuẩn hoá như receiver thường →
   * ghi inbox (chống trùng) → kết thúc dòng, xoá nội dung. Chạy lại an toàn.
   */
  async verifyAll(actor: RecruitmentActor): Promise<QuarantineVerifyResult> {
    if (isRecruitmentZaloQuarantine(this.get)) {
      throw new ConflictException({
        code: 'QUARANTINE_STILL_ACTIVE',
        message:
          'Tắt RECRUITMENT_ZALO_WEBHOOK_QUARANTINE và cấu hình OA secret key trước khi xác minh',
      });
    }
    const read = readRecruitmentZaloConfig(this.get);
    const key = decodeKey(this.get('RECRUITMENT_ZALO_TOKEN_KEY')?.trim() ?? '');
    if (!('config' in read) || !key) {
      throw new ConflictException({
        code: 'QUARANTINE_VERIFY_NOT_CONFIGURED',
        message:
          'Cần RECRUITMENT_ZALO_APP_ID / OA_ID / OA_SECRET_KEY và RECRUITMENT_ZALO_TOKEN_KEY',
      });
    }
    const config = read.config;
    const result: QuarantineVerifyResult = {
      verified: 0,
      duplicates: 0,
      rejected: {},
      expired: await this.expire(),
      undecryptable: 0,
      failed: 0,
      remaining: 0,
    };

    let afterId = 0;
    for (;;) {
      const batch = await this.dataSource.query<Array<{ id: number }>>(
        `SELECT "id" FROM "recruitment_channel_quarantine"
         WHERE "status" = 'QUARANTINED' AND "id" > $1 ORDER BY "id" LIMIT ${VERIFY_BATCH}`,
        [afterId],
      );
      if (!batch.length) break;
      for (const { id } of batch) {
        afterId = Number(id);
        let outcome: string;
        try {
          outcome = await this.verifyOne(Number(id), config, key);
        } catch (error) {
          // Một dòng lỗi không chặn các dòng khác; dòng này giữ nguyên để chạy lại.
          result.failed += 1;
          this.logger.error(
            `zalo-recruitment quarantine verify id=${id} failed (rollback, giữ nguyên) ` +
              `error=${(error as { code?: string }).code ?? (error as Error).name}`,
          );
          continue;
        }
        if (outcome === 'VERIFIED') result.verified += 1;
        else if (outcome === 'DUPLICATE') result.duplicates += 1;
        else if (outcome === 'UNDECRYPTABLE') result.undecryptable += 1;
        else if (outcome !== 'SKIPPED') {
          result.rejected[outcome] = (result.rejected[outcome] ?? 0) + 1;
        }
      }
    }
    const [left] = await this.dataSource.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS "n" FROM "recruitment_channel_quarantine" WHERE "status" = 'QUARANTINED'`,
    );
    result.remaining = left?.n ?? 0;

    this.logger.log(
      `zalo-recruitment quarantine verify verified=${result.verified} duplicates=${result.duplicates} ` +
        `rejected=${JSON.stringify(result.rejected)} expired=${result.expired} ` +
        `undecryptable=${result.undecryptable} failed=${result.failed} remaining=${result.remaining}`,
    );
    await this.audit.record({
      actor,
      action: 'CHANNEL_QUARANTINE_VERIFY',
      entity: 'channel-quarantine',
      entityId: afterId,
      context: { ...result },
    });
    return result;
  }

  private async verifyOne(
    id: number,
    config: Parameters<typeof parseZaloRecruitmentEvent>[0],
    key: Buffer,
  ): Promise<string> {
    return this.dataSource.transaction(async (em) => {
      const [row] = await em.query<QuarantineRow[]>(
        `SELECT "id", "channel_account_id", "payload_hash", "signature", "body_enc"
         FROM "recruitment_channel_quarantine"
         WHERE "id" = $1 AND "status" = 'QUARANTINED'
         FOR UPDATE SKIP LOCKED`,
        [id],
      );
      if (!row) return 'SKIPPED';

      let body: Buffer;
      try {
        body = Buffer.from(
          decryptToken(
            key,
            quarantineAad(row.channel_account_id, row.payload_hash),
            row.body_enc,
          ),
          'base64',
        );
      } catch {
        // Sai khoá: KHÔNG xoá — sửa RECRUITMENT_ZALO_TOKEN_KEY rồi chạy lại.
        return 'UNDECRYPTABLE';
      }
      const finish = async (
        status: 'VERIFIED' | 'REJECTED',
        code: string,
        eventId: number | null,
      ) => {
        await em.query(
          `UPDATE "recruitment_channel_quarantine"
           SET "status" = $2::text::"recruitment_channel_quarantine_status_enum",
               "resolution_code" = $3, "channel_event_id" = $4,
               "body_enc" = NULL, "resolved_at" = now(), "updated_at" = now()
           WHERE "id" = $1`,
          [row.id, status, code, eventId],
        );
      };

      if (
        createHash('sha256').update(body).digest('hex') !== row.payload_hash
      ) {
        await finish('REJECTED', 'INTEGRITY', null);
        return 'INTEGRITY';
      }
      if (row.channel_account_id !== config.oaId) {
        await finish('REJECTED', 'OA_MISMATCH', null);
        return 'OA_MISMATCH';
      }
      const parsed = parseZaloRecruitmentEvent(config, body, row.signature);
      if (!parsed.ok) {
        await finish('REJECTED', parsed.code, null);
        return parsed.code;
      }
      const stored = await insertChannelEvent(em, parsed.event);
      await finish(
        'VERIFIED',
        stored.duplicate ? 'DUPLICATE' : 'NEW',
        stored.id,
      );
      return stored.duplicate ? 'DUPLICATE' : 'VERIFIED';
    });
  }
}

/** AAD gắn bản mã với đúng OA + đúng payload: chép bản mã sang dòng khác là không giải được. */
function quarantineAad(oaId: string, payloadHash: string): string {
  return `quarantine:${oaId}:${payloadHash}`;
}
