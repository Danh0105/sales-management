import axios from 'axios';
import {
  ZaloLocationHttpClient,
  ZALO_LOCATION_URL,
} from './zalo-location-http.client';

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

describe('ZaloLocationHttpClient', () => {
  it('gửi đúng ba header, timeout 5 giây và không cấu hình retry', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: {} });
    await new ZaloLocationHttpClient().get(
      'location-code',
      'access-token',
      'app-secret',
    );
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(ZALO_LOCATION_URL, {
      headers: {
        access_token: 'access-token',
        code: 'location-code',
        secret_key: 'app-secret',
      },
      timeout: 5000,
    });
    expect((axios.get as jest.Mock).mock.calls[0][1]).not.toHaveProperty(
      'retry',
    );
  });
});
