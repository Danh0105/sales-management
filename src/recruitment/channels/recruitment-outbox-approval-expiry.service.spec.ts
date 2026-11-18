import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  APPROVAL_EXPIRY_EVERY_MS,
  DEFAULT_HR_MESSAGE_TTL_MINUTES,
  DEFAULT_PENDING_APPROVAL_TTL_MINUTES,
  RecruitmentOutboxApprovalExpiryService,
  readHrMessageTtl,
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
  const expireHr = jest
    .spyOn(service, 'expireHrMessages')
    .mockResolvedValue({ examined: 0, expired: 0 });
  return { service, expire, expireHr };
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

describe('RecruitmentOutboxApprovalExpiryService — TTL tin HR', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('mặc định 60 phút; env hợp lệ 5–1440; sai → mặc định', () => {
    expect(DEFAULT_HR_MESSAGE_TTL_MINUTES).toBe(60);
    expect(readHrMessageTtl(() => undefined)).toBe(60);
    expect(readHrMessageTtl(() => '5')).toBe(5);
    expect(readHrMessageTtl(() => '1440')).toBe(1440);
    for (const raw of ['4', '0', 'abc', '1441', '30.5', '-60']) {
      expect(readHrMessageTtl(() => raw)).toBe(60);
    }
  });

  it('mỗi lượt dọn cũng hết hạn tin HR; lỗi phần bản duyệt AI không chặn phần tin HR', async () => {
    const { service, expire, expireHr } = make({
      RECRUITMENT_ZALO_OUTBOUND_ENABLED: 'true',
      RECRUITMENT_HR_MESSAGE_TTL_MINUTES: '45',
    });
    expire.mockRejectedValueOnce(new Error('P32_APPROVAL_SCHEMA_NOT_READY'));
    service.onApplicationBootstrap();
    await Promise.resolve();
    await Promise.resolve();
    expect(expireHr).toHaveBeenCalledWith(45);
    service.onModuleDestroy();
  });

  it('expireHrMessages: cấu hình ngoài khoảng → ném lỗi, không truy vấn', async () => {
    const query = jest.fn();
    const service = new RecruitmentOutboxApprovalExpiryService(
      { query } as unknown as DataSource,
      {} as RecruitmentAuditService,
    );
    await expect(service.expireHrMessages(4)).rejects.toThrow(
      'HR_MESSAGE_EXPIRY_CONFIG_INVALID',
    );
    await expect(service.expireHrMessages(60, 21)).rejects.toThrow(
      'HR_MESSAGE_EXPIRY_CONFIG_INVALID',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('expireHrOne: chỉ PENDING/RETRY đã quá hạn; ghi DEAD_LETTER + metadata + audit bắt buộc + cảnh báo cùng transaction', async () => {
    const sqls: string[] = [];
    const em = {
      query: jest.fn((sql: string) => {
        sqls.push(sql);
        if (/FOR UPDATE/.test(sql)) {
          return Promise.resolve([
            {
              status: 'PENDING',
              last_error_code: null,
              attempt_count: 0,
              recruitment_message_id: 77,
              due: true,
            },
          ]);
        }
        if (/UPDATE "recruitment_channel_outbox"/.test(sql)) {
          return Promise.resolve([[{ id: 7 }], 1]);
        }
        return Promise.resolve([[], 1]);
      }),
    };
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ id: 7 }]),
      transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
    };
    const recordMandatory = jest.fn().mockResolvedValue(undefined);
    const raise = jest.fn().mockResolvedValue(true);
    const service = new RecruitmentOutboxApprovalExpiryService(
      dataSource as unknown as DataSource,
      { recordMandatory } as unknown as RecruitmentAuditService,
      undefined,
      { raise } as any,
    );
    await expect(service.expireHrMessages(60)).resolves.toEqual({
      examined: 1,
      expired: 1,
    });
    const update = sqls.find((s) =>
      /UPDATE "recruitment_channel_outbox"/.test(s),
    )!;
    expect(update).toMatch(
      /status = 'DEAD_LETTER', last_error_code = 'HR_MESSAGE_EXPIRED'/,
    );
    expect(update).toMatch(/status IN \('PENDING', 'RETRY'\)/);
    expect(sqls.some((s) => /DEAD_LETTER_HR_MESSAGE_EXPIRED/.test(s))).toBe(
      true,
    );
    expect(recordMandatory).toHaveBeenCalledWith(
      em,
      expect.objectContaining({
        action: 'CHANNEL_OUTBOX_HR_MESSAGE_EXPIRED',
        entityId: 7,
      }),
    );
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'outbox:7', outboxId: 7 }),
      em,
    );
  });

  it('expireHrOne: đang SENDING (ở tay sender) hoặc chưa quá hạn → không đổi gì', async () => {
    for (const current of [
      { status: 'SENDING', due: true },
      { status: 'PENDING', due: false },
    ]) {
      const em = {
        query: jest.fn((sql: string) =>
          Promise.resolve(
            /FOR UPDATE/.test(sql)
              ? [
                  {
                    ...current,
                    last_error_code: null,
                    attempt_count: 1,
                    recruitment_message_id: 1,
                  },
                ]
              : [[], 0],
          ),
        ),
      };
      const recordMandatory = jest.fn();
      const service = new RecruitmentOutboxApprovalExpiryService(
        {
          query: jest.fn().mockResolvedValue([{ id: 8 }]),
          transaction: (fn: (e: typeof em) => unknown) => fn(em),
        } as unknown as DataSource,
        { recordMandatory } as unknown as RecruitmentAuditService,
      );
      await expect(service.expireHrMessages(60)).resolves.toEqual({
        examined: 1,
        expired: 0,
      });
      expect(
        em.query.mock.calls.some(([s]) => /^\s*UPDATE/.test(String(s))),
      ).toBe(false);
      expect(recordMandatory).not.toHaveBeenCalled();
    }
  });
});
