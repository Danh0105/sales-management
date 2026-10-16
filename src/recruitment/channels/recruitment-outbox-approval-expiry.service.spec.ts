import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  APPROVAL_EXPIRY_EVERY_MS,
  DEFAULT_PENDING_APPROVAL_TTL_MINUTES,
  RecruitmentOutboxApprovalExpiryService,
  readPendingApprovalTtl,
} from './recruitment-outbox-approval-expiry.service';

function make(env: Record<string, string>) {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const service = new RecruitmentOutboxApprovalExpiryService(
    {} as DataSource,
    {} as RecruitmentAuditService,
    config,
  );
  const expire = jest
    .spyOn(service, 'expireBatch')
    .mockResolvedValue({ examined: 0, expired: 0 });
  return { service, expire };
}

describe('RecruitmentOutboxApprovalExpiryService — lịch dọn bản duyệt hết hạn', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('worker và outbound đều tắt → không chạy (3011, staging tắt cờ)', () => {
    const { service, expire } = make({});
    service.onApplicationBootstrap();
    jest.advanceTimersByTime(APPROVAL_EXPIRY_EVERY_MS * 3);
    expect(expire).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('C1 (chỉ worker bật) → dọn ngay khi khởi động rồi theo chu kỳ, TTL mặc định', async () => {
    const { service, expire } = make({ RECRUITMENT_WORKER_ENABLED: 'true' });
    service.onApplicationBootstrap();
    await Promise.resolve();
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenLastCalledWith(
      DEFAULT_PENDING_APPROVAL_TTL_MINUTES,
    );
    await jest.advanceTimersByTimeAsync(APPROVAL_EXPIRY_EVERY_MS);
    expect(expire).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(APPROVAL_EXPIRY_EVERY_MS * 2);
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it('chỉ outbound bật cũng chạy; TTL lấy từ env khi hợp lệ', async () => {
    const { service, expire } = make({
      RECRUITMENT_ZALO_OUTBOUND_ENABLED: 'true',
      RECRUITMENT_APPROVAL_PENDING_TTL_MINUTES: '120',
    });
    service.onApplicationBootstrap();
    await Promise.resolve();
    expect(expire).toHaveBeenCalledWith(120);
    service.onModuleDestroy();
  });

  it('TTL sai / ngoài 15–10080 → mặc định', () => {
    for (const raw of ['5', '0', 'abc', '10081', '30.5', '-60']) {
      expect(
        readPendingApprovalTtl((k) =>
          k === 'RECRUITMENT_APPROVAL_PENDING_TTL_MINUTES' ? raw : undefined,
        ),
      ).toBe(DEFAULT_PENDING_APPROVAL_TTL_MINUTES);
    }
    expect(readPendingApprovalTtl(() => '15')).toBe(15);
    expect(readPendingApprovalTtl(() => undefined)).toBe(
      DEFAULT_PENDING_APPROVAL_TTL_MINUTES,
    );
  });

  it('lỗi DB không làm sập vòng lặp, lượt sau vẫn chạy', async () => {
    const { service, expire } = make({ RECRUITMENT_WORKER_ENABLED: 'true' });
    expire.mockRejectedValueOnce(new Error('P32_APPROVAL_SCHEMA_NOT_READY'));
    await expect(service.sweep()).resolves.toBeUndefined();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'approval expiry error=P32_APPROVAL_SCHEMA_NOT_READY',
    );
    await service.sweep();
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it('không chạy chồng khi lượt trước chưa xong', async () => {
    const { service, expire } = make({ RECRUITMENT_WORKER_ENABLED: 'true' });
    let release!: () => void;
    expire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ examined: 1, expired: 1 });
        }),
    );
    const first = service.sweep();
    await service.sweep();
    expect(expire).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'approval expiry expired=1 examined=1',
    );
    await service.sweep();
    expect(expire).toHaveBeenCalledTimes(2);
  });
});
