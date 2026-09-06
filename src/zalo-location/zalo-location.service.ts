import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
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

@Injectable()
export class ZaloLocationService {
  private readonly appSecret: string;

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
    if (!this.appSecret) throw locationServiceError();

    let payload: ZaloLocationApiPayload;
    try {
      const response = await this.client.get(
        locationToken,
        accessToken,
        this.appSecret,
      );
      payload = response.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          throw locationTimeout();
        }
        if (
          error.response &&
          [400, 401, 403, 422].includes(error.response.status)
        ) {
          throw invalidLocationToken();
        }
      }
      throw locationServiceError();
    }

    if (payload?.error !== 0) throw invalidLocationToken();
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
