import { returnedRows } from './recruitment-channel-event.queue';
import {
  assertRecruitmentWorkerConfig,
  readRecruitmentWorkerConfig,
  RECRUITMENT_WORKER_CONFIG_ERROR,
  retryDelayMs,
} from './recruitment-channel-worker.config';

const TOKEN = 'gateway-token-0123456789abcdef0123456789';
const BASE = {
  RECRUITMENT_WORKER_ENABLED: 'true',
  RECRUITMENT_ZALO_OA_ID: 'oa-recruit',
  RECRUITMENT_OPENCLAW_URL: 'http://openclaw-gateway:18789',
  RECRUITMENT_OPENCLAW_TOKEN: TOKEN,
};
const get = (values: Record<string, string | undefined>) => (key: string) =>
  values[key];

describe('cấu hình worker OpenClaw', () => {
  it('đủ biến bắt buộc → mặc định an toàn', () => {
    expect(readRecruitmentWorkerConfig(get(BASE))).toEqual({
      config: {
        oaId: 'oa-recruit',
        openclaw: {
          url: 'http://openclaw-gateway:18789',
          token: TOKEN,
          agentId: 'main',
          timeoutMs: 240_000,
        },
        concurrency: 2,
        pollMs: 2_000,
        leaseMs: 300_000,
        settleMs: 2_000,
        retryBaseMs: 30_000,
        retryMaxMs: 900_000,
        janitorMs: 60_000,
      },
    });
  });

  it('cờ tắt → không kiểm (mặc định của 3010/3011)', () => {
    expect(() => assertRecruitmentWorkerConfig(get({}))).not.toThrow();
  });

  it.each([
    ['RECRUITMENT_OPENCLAW_TOKEN', { RECRUITMENT_OPENCLAW_TOKEN: 'short' }],
    [
      'RECRUITMENT_OPENCLAW_URL',
      { RECRUITMENT_OPENCLAW_URL: 'openclaw:18789' },
    ],
    [
      'RECRUITMENT_OPENCLAW_URL',
      { RECRUITMENT_OPENCLAW_URL: 'http://u:p@gw:1' },
    ],
    ['RECRUITMENT_ZALO_OA_ID', { RECRUITMENT_ZALO_OA_ID: 'legacy' }],
    ['RECRUITMENT_ZALO_OA_ID', { RECRUITMENT_ZALO_OA_ID: undefined }],
    [
      'RECRUITMENT_OPENCLAW_AGENT_ID',
      { RECRUITMENT_OPENCLAW_AGENT_ID: 'Main!' },
    ],
    ['RECRUITMENT_WORKER_CONCURRENCY', { RECRUITMENT_WORKER_CONCURRENCY: '0' }],
    ['RECRUITMENT_WORKER_LEASE_MS', { RECRUITMENT_WORKER_LEASE_MS: 'abc' }],
    [
      'RECRUITMENT_WORKER_RETRY_MAX_MS',
      {
        RECRUITMENT_WORKER_RETRY_BASE_MS: '60000',
        RECRUITMENT_WORKER_RETRY_MAX_MS: '1000',
      },
    ],
  ])('bật mà %s sai → không khởi động, lỗi không lộ token', (name, patch) => {
    const values = { ...BASE, ...patch };
    let message = '';
    try {
      assertRecruitmentWorkerConfig(get(values));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(RECRUITMENT_WORKER_CONFIG_ERROR);
    expect(message).toContain(name);
    expect(message).not.toContain(TOKEN);
  });

  it('giãn cách thử lại tăng gấp đôi, có trần', () => {
    const config = { retryBaseMs: 1000, retryMaxMs: 5000 };
    expect([1, 2, 3, 4, 10].map((n) => retryDelayMs(config, n))).toEqual([
      1000, 2000, 4000, 5000, 5000,
    ]);
  });
});

describe('returnedRows', () => {
  it('UPDATE ... RETURNING của TypeORM trả [rows, rowCount]', () => {
    expect(returnedRows([[{ id: 1 }], 1])).toEqual([{ id: 1 }]);
    expect(returnedRows([[], 0])).toEqual([]);
  });

  it('INSERT/SELECT trả thẳng rows', () => {
    expect(returnedRows([{ id: 1 }, { id: 2 }])).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    expect(returnedRows([])).toEqual([]);
  });
});
