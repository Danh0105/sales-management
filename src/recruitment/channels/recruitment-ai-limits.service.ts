import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ClaimedChannelEvent } from './recruitment-channel-event.queue';
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
    }> = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE ai_control_version IS NOT NULL AND received_at >= ${VN_DAY})::int AS day_turns,
         coalesce(sum(ai_total_tokens) FILTER (WHERE processed_at >= ${VN_DAY}), 0) AS day_tokens,
         coalesce(sum(ai_total_tokens) FILTER (WHERE processed_at >= ${VN_MONTH}), 0) AS month_tokens
       FROM "recruitment_channel_events"
       WHERE received_at >= ${VN_MONTH} - interval '1 day' OR processed_at >= ${VN_MONTH}`,
    );
    return {
      today: {
        turns: Number(row?.day_turns ?? 0),
        tokens: Number(row?.day_tokens ?? 0),
      },
      month: { tokens: Number(row?.month_tokens ?? 0) },
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
}
