import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { ZaloLocationHttpClient } from './zalo-location-http.client';
import { ZaloLocationService } from './zalo-location.service';

describe('ZaloLocationService', () => {
  const client = {
    get: jest.fn(),
  } as unknown as jest.Mocked<ZaloLocationHttpClient>;
  const config = {
    get: jest.fn((key: string) =>
      key === 'ZALO_APP_SECRET' ? 'server-secret' : 'test',
    ),
  } as unknown as ConfigService;
  let service: ZaloLocationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ZaloLocationService(config, client);
  });

  it('đổi tọa độ và timestamp từ string thành number', async () => {
    client.get.mockResolvedValue({
      data: {
        error: 0,
        data: {
          provider: 'gps',
          latitude: '10.758341',
          longitude: '106.745863',
          timestamp: '1666249171003',
        },
      },
    } as never);
    await expect(service.resolve('location', 'access')).resolves.toEqual({
      latitude: 10.758341,
      longitude: 106.745863,
      provider: 'gps',
      timestamp: 1666249171003,
    });
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith(
      'location',
      'access',
      'server-secret',
    );
  });

  it('trả 422 khi Zalo từ chối token và không retry', async () => {
    client.get.mockResolvedValue({
      data: { error: -201, message: 'expired' },
    } as never);
    await expect(
      service.resolve('sensitive-location', 'sensitive-access'),
    ).rejects.toMatchObject({ status: 422 });
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('trả 504 khi timeout', async () => {
    client.get.mockRejectedValue(
      new AxiosError('timeout', 'ECONNABORTED', undefined, undefined),
    );
    await expect(service.resolve('location', 'access')).rejects.toMatchObject({
      status: 504,
    });
  });

  it.each([
    { error: 0, data: {} },
    { error: 0, data: { latitude: '91', longitude: '106' } },
    { error: 0, data: { latitude: '10', longitude: '-181' } },
    { error: 0, data: { latitude: 'invalid', longitude: '106' } },
  ])('trả 502 cho payload hoặc tọa độ không hợp lệ: %p', async (payload) => {
    client.get.mockResolvedValue({ data: payload } as never);
    await expect(service.resolve('location', 'access')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('trả 502 cho lỗi Zalo 5xx mà không lộ dữ liệu nhạy cảm', async () => {
    const response = {
      status: 500,
      data: { secret_key: 'server-secret', access_token: 'sensitive-access' },
      headers: {},
      statusText: '',
    };
    client.get.mockRejectedValue(
      new AxiosError(
        'upstream',
        'ERR_BAD_RESPONSE',
        undefined,
        undefined,
        response,
      ),
    );
    try {
      await service.resolve('sensitive-location', 'sensitive-access');
      fail('expected exception');
    } catch (error: any) {
      expect(error.status).toBe(502);
      expect(JSON.stringify(error.getResponse())).not.toContain('sensitive');
      expect(JSON.stringify(error.getResponse())).not.toContain(
        'server-secret',
      );
    }
  });
});
