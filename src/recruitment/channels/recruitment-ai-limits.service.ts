import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ClaimedChannelEvent } from './recruitment-channel-event.queue';
import { returnedRows } from './recruitment-channel-event.queue';
import {
  type AiLimits,
  DEFAULT_AI_LIMITS,
  readAiSafetyConfig,
} from './recruitment-ai-safety.config';

export type AiLimitVerdict =
  | { ok: true }
  | {
      ok: false;
      /** SENDER: chỉ người gửi này (HR trả lời). GLOBAL: cả hệ thống (tự dừng AI). */
      scope: 'SENDER' | 'GLOBAL';
      limit:
        | 'SENDER_HOURLY_TURNS'
        | 'SENDER_DAILY_TURNS'
        | 'DAILY_TURNS'
        | 'DAILY_TOKENS'
        | 'MONTHLY_TOKENS';
      used: number;
      max: number;
    };

export type AiReservationResult =
  | { kind: 'RESERVED' | 'EXISTING' }
  | { kind: 'HALTED' | 'LOST' | 'UNCERTAIN' }
  | { kind: 'LIMIT'; verdict: Exclude<AiLimitVerdict, { ok: true }> };

/** Mốc ngày / tháng theo giờ Việt Nam (timestamptz). */
const VN_DAY = `date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'`;
const VN_MONTH = `date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'`;

/**
 * Trần lượt / token của AI (P3-7.3 / G8) — kiểm TRƯỚC khi bắt đầu lượt mới. Lượt = event đã
 * ghi `ai_control_version` (lượt đã bắt đầu, kể cả lượt lỗi); token = `ai_total_tokens` theo
 * `usage` OpenClaw. Toàn hệ thống kiểm trước người gửi (vượt toàn hệ thống thì dừng hẳn).
 */
@Injectable()
export class RecruitmentAiLimitsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService?: ConfigService,
  ) {}

  /** Lượt / token hôm nay & tháng này so với trần + pilot bật hay không (không lộ danh sách). */
  async summary() {
    const read = this.configService
      ? readAiSafetyConfig((k) => this.configService!.get<string>(k))
      : null;
    const config = read && 'config' in read ? read.config : null;
    const [row]: Array<{
      day_turns: number;
      day_tokens: string | number;
      month_tokens: string | number;
      day_reserved: string | number;
      month_reserved: string | number;
    }> = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE ai_control_version IS NOT NULL AND
           coalesce(ai_reservation_day, (received_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) =
             (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int AS day_turns,
         coalesce(sum(ai_total_tokens) FILTER (WHERE processed_at >= ${VN_DAY}), 0) AS day_tokens,
         coalesce(sum(ai_total_tokens) FILTER (WHERE processed_at >= ${VN_MONTH}), 0) AS month_tokens,
         coalesce(sum(greatest(ai_reserved_tokens, coalesce(ai_total_tokens, 0)))
           FILTER (WHERE ai_reservation_day = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), 0) AS day_reserved,
         coalesce(sum(greatest(ai_reserved_tokens, coalesce(ai_total_tokens, 0)))
           FILTER (WHERE ai_reservation_month = date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), 0) AS month_reserved
       FROM "recruitment_channel_events"
       WHERE received_at >= ${VN_MONTH} - interval '1 day' OR processed_at >= ${VN_MONTH}
          OR ai_reservation_month = date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
    );
    return {
      today: {
        turns: Number(row?.day_turns ?? 0),
        tokens: Number(row?.day_tokens ?? 0),
        reservedTokens: Number(row?.day_reserved ?? 0),
      },
      month: {
        tokens: Number(row?.month_tokens ?? 0),
        reservedTokens: Number(row?.month_reserved ?? 0),
      },
      limits: config?.limits ?? DEFAULT_AI_LIMITS,
      pilot: {
        enabled:
          config?.pilotSenders !== null && config?.pilotSenders !== undefined,
        senders: config?.pilotSenders?.length ?? 0,
      },
    };
  }

  async evaluate(
    event: Pick<ClaimedChannelEvent, 'channelAccountId' | 'externalSenderId'>,
    limits: AiLimits,
  ): Promise<AiLimitVerdict> {
    const [row]: Array<{
      day_turns: number;
      day_tokens: string | number;
      month_tokens: string | number;
      sender_hour: number;
      sender_day: number;
    }> = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE ai_control_version IS NOT NULL AND received_at >= ${VN_DAY})::int AS day_turns,
         coalesce(sum(ai_total_tokens) FILTER (WHERE processed_at >= ${VN_DAY}), 0) AS day_tokens,
         coalesce(sum(ai_total_tokens) FILTER (WHERE processed_at >= ${VN_MONTH}), 0) AS month_tokens,
         count(*) FILTER (WHERE ai_control_version IS NOT NULL
                            AND channel_account_id = $1 AND external_sender_id = $2
                            AND received_at >= now() - interval '1 hour')::int AS sender_hour,
         count(*) FILTER (WHERE ai_control_version IS NOT NULL
                            AND channel_account_id = $1 AND external_sender_id = $2
                            AND received_at >= now() - interval '24 hours')::int AS sender_day
       FROM "recruitment_channel_events"
       WHERE received_at >= ${VN_MONTH} - interval '1 day' OR processed_at >= ${VN_MONTH}`,
      [event.channelAccountId, event.externalSenderId],
    );
    const used = {
      dayTurns: Number(row?.day_turns ?? 0),
      dayTokens: Number(row?.day_tokens ?? 0),
      monthTokens: Number(row?.month_tokens ?? 0),
      senderHour: Number(row?.sender_hour ?? 0),
      senderDay: Number(row?.sender_day ?? 0),
    };
    const checks: Array<[AiLimitVerdict & { ok: false }, boolean]> = [
      [
        {
          ok: false,
          scope: 'GLOBAL',
          limit: 'MONTHLY_TOKENS',
          used: used.monthTokens,
          max: limits.monthlyTokenBudget,
        },
        used.monthTokens >= limits.monthlyTokenBudget,
      ],
      [
        {
          ok: false,
          scope: 'GLOBAL',
          limit: 'DAILY_TOKENS',
          used: used.dayTokens,
          max: limits.dailyTokenBudget,
        },
        used.dayTokens >= limits.dailyTokenBudget,
      ],
      [
        {
          ok: false,
          scope: 'GLOBAL',
          limit: 'DAILY_TURNS',
          used: used.dayTurns,
          max: limits.maxTurnsPerDay,
        },
        used.dayTurns >= limits.maxTurnsPerDay,
      ],
      [
        {
          ok: false,
          scope: 'SENDER',
          limit: 'SENDER_HOURLY_TURNS',
          used: used.senderHour,
          max: limits.maxTurnsPerSenderHour,
        },
        used.senderHour >= limits.maxTurnsPerSenderHour,
      ],
      [
        {
          ok: false,
          scope: 'SENDER',
          limit: 'SENDER_DAILY_TURNS',
          used: used.senderDay,
          max: limits.maxTurnsPerSenderDay,
        },
        used.senderDay >= limits.maxTurnsPerSenderDay,
      ],
    ];
    return checks.find(([, hit]) => hit)?.[0] ?? { ok: true };
  }

  /**
   * Cửa quota có transaction ngắn, không giữ lock khi gọi OpenClaw.
   *
   * Thứ tự lock cố định: runtime row id=1 → event row. Dòng runtime đã tồn tại từ
   * migration nên không có race tạo counter row đầu tiên. Mọi worker cùng khóa dòng
   * này trước khi đếm và ghi reservation; operator stop/auto-halt cũng khóa dòng đó.
   * Reservation nằm trên event, vì thế retry hoặc crash sau commit không giữ thêm quota.
   */
  async reserve(
    event: ClaimedChannelEvent,
    owner: string,
    controlVersion: number,
    limits: AiLimits,
  ): Promise<AiReservationResult> {
    return this.dataSource.transaction(async (em) => {
      const [runtime]: Array<{
        ai_halted: boolean;
        worker_halted: boolean;
        failsafe_halted: boolean;
      }> = await em.query(
        `SELECT ai_halted, worker_halted, failsafe_halted
         FROM "recruitment_runtime_controls" WHERE id = 1 FOR UPDATE`,
      );
      if (
        !runtime ||
        runtime.ai_halted ||
        runtime.worker_halted ||
        runtime.failsafe_halted
      ) {
        return { kind: 'HALTED' };
      }

      const [row]: Array<{
        status: string;
        lease_owner: string | null;
        ai_control_version: number | null;
        ai_provider_dispatched_at: Date | null;
      }> = await em.query(
        `SELECT status, lease_owner, ai_control_version, ai_provider_dispatched_at
         FROM "recruitment_channel_events" WHERE id = $1 FOR UPDATE`,
        [event.id],
      );
      if (!row || row.status !== 'PROCESSING' || row.lease_owner !== owner) {
        return { kind: 'LOST' };
      }
      if (row.ai_control_version !== null) {
        return row.ai_provider_dispatched_at
          ? { kind: 'UNCERTAIN' }
          : { kind: 'EXISTING' };
      }

      // `clock_timestamp()` lấy SAU khi chờ lock; `now()` của transaction có thể
      // nằm ở ngày/tháng cũ nếu phải chờ qua nửa đêm.
      const [clock]: Array<{ at: Date; day: string; month: string }> =
        await em.query(
          `WITH tick AS (SELECT clock_timestamp() AS at)
           SELECT at, (at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day,
                  date_trunc('month', at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS month
           FROM tick`,
        );
      const [usage]: Array<{
        day_turns: number;
        day_tokens: string | number;
        month_tokens: string | number;
        sender_hour: number;
        sender_day: number;
      }> = await em.query(
        `SELECT
           count(*) FILTER (WHERE ai_control_version IS NOT NULL AND
             (ai_reservation_day = $3::date OR
              (ai_reservation_day IS NULL AND received_at >= ($3::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
               AND received_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))))::int AS day_turns,
           coalesce(sum(CASE
             WHEN ai_reservation_day = $3::date THEN greatest(ai_reserved_tokens, coalesce(ai_total_tokens, 0))
             WHEN ai_reservation_day IS NULL AND processed_at >= ($3::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
               AND processed_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
               THEN coalesce(ai_total_tokens, 0) ELSE 0 END), 0) AS day_tokens,
           coalesce(sum(CASE
             WHEN ai_reservation_month = $4::date THEN greatest(ai_reserved_tokens, coalesce(ai_total_tokens, 0))
             WHEN ai_reservation_month IS NULL AND processed_at >= ($4::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
               AND processed_at < (($4::date + interval '1 month') AT TIME ZONE 'Asia/Ho_Chi_Minh')
               THEN coalesce(ai_total_tokens, 0) ELSE 0 END), 0) AS month_tokens,
           count(*) FILTER (WHERE ai_control_version IS NOT NULL
             AND channel_account_id = $1 AND external_sender_id = $2
             AND coalesce(ai_reserved_at, received_at) >= $5::timestamptz - interval '1 hour')::int AS sender_hour,
           count(*) FILTER (WHERE ai_control_version IS NOT NULL
             AND channel_account_id = $1 AND external_sender_id = $2
             AND coalesce(ai_reserved_at, received_at) >= $5::timestamptz - interval '24 hours')::int AS sender_day
         FROM "recruitment_channel_events"
         WHERE ai_control_version IS NOT NULL OR ai_total_tokens IS NOT NULL`,
        [event.channelAccountId, event.externalSenderId, clock.day, clock.month, clock.at],
      );
      const used = {
        dayTurns: Number(usage?.day_turns ?? 0),
        dayTokens: Number(usage?.day_tokens ?? 0),
        monthTokens: Number(usage?.month_tokens ?? 0),
        senderHour: Number(usage?.sender_hour ?? 0),
        senderDay: Number(usage?.sender_day ?? 0),
      };
      const checks: Array<Exclude<AiLimitVerdict, { ok: true }>> = [
        { ok: false, scope: 'GLOBAL', limit: 'MONTHLY_TOKENS', used: used.monthTokens, max: limits.monthlyTokenBudget },
        { ok: false, scope: 'GLOBAL', limit: 'DAILY_TOKENS', used: used.dayTokens, max: limits.dailyTokenBudget },
        { ok: false, scope: 'GLOBAL', limit: 'DAILY_TURNS', used: used.dayTurns, max: limits.maxTurnsPerDay },
        { ok: false, scope: 'SENDER', limit: 'SENDER_HOURLY_TURNS', used: used.senderHour, max: limits.maxTurnsPerSenderHour },
        { ok: false, scope: 'SENDER', limit: 'SENDER_DAILY_TURNS', used: used.senderDay, max: limits.maxTurnsPerSenderDay },
      ];
      const verdict = checks.find((v) =>
        v.limit === 'MONTHLY_TOKENS'
          ? v.used + limits.tokenReservationPerTurn > v.max
          : v.limit === 'DAILY_TOKENS'
            ? v.used + limits.tokenReservationPerTurn > v.max
            : v.used >= v.max,
      );
      if (verdict) return { kind: 'LIMIT', verdict };

      const reserved = returnedRows(
        await em.query(
          `UPDATE "recruitment_channel_events"
           SET ai_control_version = $3, ai_reserved_tokens = $4,
               ai_reserved_at = $5, ai_reservation_day = $6::date,
               ai_reservation_month = $7::date, updated_at = now()
           WHERE id = $1 AND status = 'PROCESSING' AND lease_owner = $2
             AND ai_control_version IS NULL RETURNING id`,
          [
            event.id,
            owner,
            controlVersion,
            limits.tokenReservationPerTurn,
            clock.at,
            clock.day,
            clock.month,
          ],
        ),
      );
      return reserved.length ? { kind: 'RESERVED' } : { kind: 'LOST' };
    });
  }
}
