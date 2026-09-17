import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ZaloLocationApiPayload } from './zalo-location.types';

export const ZALO_LOCATION_URL = 'https://graph.zalo.me/v2.0/me/info';

@Injectable()
export class ZaloLocationHttpClient {
  // Axios does not retry by default. Retry policy lives in ZaloLocationService so
  // that a one-time location token is only re-sent when Zalo produced no result.
  get(locationToken: string, accessToken: string, appSecret: string) {
    return axios.get<ZaloLocationApiPayload>(ZALO_LOCATION_URL, {
      headers: {
        access_token: accessToken,
        code: locationToken,
        secret_key: appSecret,
      },
      timeout: 5000,
    });
  }
}
