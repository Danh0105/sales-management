import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { ZaloLocationHttpClient } from './zalo-location-http.client';
import {
  ZaloLocationApiPayload,
  ZaloLocationResponse,
} from './zalo-location.types';
import {
  invalidLocationToken,
  locationServiceError,
  locationTimeout,
} from './zalo-location.error';

// Zalo only produced no result at all for these, so re-sending the one-time
// location token is safe. Timeouts are excluded: Zalo may already have consumed
// the token, and a retry would turn a TIMEOUT into a misleading TOKEN_INVALID.
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const RETRY_DELAYS_MS = [300, 800];

@Injectable()
export class ZaloLocationService {
  private readonly logger = new Logger(ZaloLocationService.name);
  private readonly appSecret: string;
  private upstreamFailures = 0;

  constructor(
    config: ConfigService,
    private readonly client: ZaloLocationHttpClient,
  ) {
    this.appSecret = config.get<string>('ZALO_APP_SECRET')?.trim() ?? '';
    if (config.get<string>('NODE_ENV') === 'production' && !this.appSecret) {
      throw new Error(
        'Missing required production configuration: ZALO_APP_SECRET',
      );
    }
  }

  async resolve(
    locationToken: string,
    accessToken: string,
  ): Promise<ZaloLocationResponse> {
    if (!this.appSecret) {
      this.failure('ZALO_APP_SECRET is empty, cannot call Zalo location API');
      throw locationServiceError();
    }

    const payload = await this.fetchPayload(locationToken, accessToken);

    if (payload?.error !== 0) {
      // Zalo answered, but rejected the token: business error, not an outage.
      this.logger.warn(
        `Zalo rejected location token: error=${String(payload?.error)} message=${String(payload?.message)}`,
      );
      throw invalidLocationToken();
    }

    const latitude = this.number(payload.data?.latitude);
    const longitude = this.number(payload.data?.longitude);
    if (
      latitude === null ||
      longitude === null ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      this.failure(
        `Zalo returned error=0 but unusable coordinates: latitude=${String(payload.data?.latitude)} longitude=${String(payload.data?.longitude)}`,
      );
      throw locationServiceError();
    }

    const rawTimestamp = payload.data?.timestamp;
    const timestamp =
      rawTimestamp === undefined || rawTimestamp === null
        ? null
        : this.number(rawTimestamp);
    if (
      timestamp === null &&
      rawTimestamp !== undefined &&
      rawTimestamp !== null
    ) {
      this.failure(
        `Zalo returned an unparsable timestamp: ${String(rawTimestamp)}`,
      );
      throw locationServiceError();
    }

    return {
      latitude,
      longitude,
      provider:
        typeof payload.data?.provider === 'string'
          ? payload.data.provider
          : null,
      timestamp,
    };
  }

  private async fetchPayload(
    locationToken: string,
    accessToken: string,
  ): Promise<ZaloLocationApiPayload> {
    const maxAttempts = RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; ; attempt++) {
      const startedAt = Date.now();
      let response: AxiosResponse<ZaloLocationApiPayload>;
      try {
        response = await this.client.get(
          locationToken,
          accessToken,
          this.appSecret,
        );
      } catch (error: unknown) {
        const elapsed = Date.now() - startedAt;
        if (!axios.isAxiosError(error)) {
          this.failure(
            `Unexpected error calling Zalo location API after ${elapsed}ms: ${String(error)}`,
          );
          throw locationServiceError();
        }

        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          this.failure(
            `Zalo location API timed out after ${elapsed}ms (attempt ${attempt}/${maxAttempts}, code=${error.code})`,
          );
          throw locationTimeout();
        }

        const status = error.response?.status;
        if (status !== undefined && [400, 401, 403, 422].includes(status)) {
          this.logger.warn(
            `Zalo location API rejected the request with HTTP ${status} after ${elapsed}ms: ${this.body(error)}`,
          );
          throw invalidLocationToken();
        }

        const retryable =
          status === undefined || RETRYABLE_STATUSES.includes(status);
        if (retryable && attempt < maxAttempts) {
          this.logger.warn(
            `Zalo location API failed (attempt ${attempt}/${maxAttempts}, ${this.describe(error)}, ${elapsed}ms), retrying`,
          );
          await this.delay(RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }

        this.failure(
          `Zalo location API failed after ${attempt} attempt(s) in ${elapsed}ms: ${this.describe(error)} body=${this.body(error)}`,
        );
        throw locationServiceError();
      }

      if (attempt > 1) {
        this.logger.log(
          `Zalo location API recovered on attempt ${attempt}/${maxAttempts}`,
        );
      }
      return response.data;
    }
  }

  /** Log an upstream failure loudly and keep a running count for alerting. */
  private failure(detail: string): void {
    this.upstreamFailures += 1;
    this.logger.error(
      `[ZALO_LOCATION_UPSTREAM] ${detail} (total failures since boot: ${this.upstreamFailures})`,
    );
  }

  private describe(error: AxiosError): string {
    const status = error.response?.status;
    return status === undefined
      ? `no response, code=${error.code ?? 'unknown'} message=${error.message}`
      : `HTTP ${status}`;
  }

  /** Upstream body, truncated and with any credential-looking field masked. */
  private body(error: AxiosError): string {
    const data = error.response?.data;
    if (data === undefined || data === null) return '<empty>';
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    const safe = text.replace(
      /("?(?:secret_key|access_token|code|refresh_token)"?\s*[:=]\s*"?)([^",&\s]+)/gi,
      '$1<redacted>',
    );
    return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private number(value: unknown): number | null {
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      value === ''
    )
      return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
}
