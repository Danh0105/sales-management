import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ZaloLocationApiPayload } from './zalo-location.types';

export const ZALO_LOCATION_URL = 'https://graph.zalo.me/v2.0/me/info';

@Injectable()
export class ZaloLocationHttpClient {
  get(locationToken: string, accessToken: string, appSecret: string) {
    // Axios does not retry by default. A one-time location token must have one request only.
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
