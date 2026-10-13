import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ExcludeChannelEventDto } from '../dto/channel-operations.dto';
import {
  ChannelEventExcludeReason,
  RecruitmentActorType,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { RecruitmentChannelEventOperationsService } from './recruitment-channel-event-operations.service';

const HR: RecruitmentActor = {
  type: RecruitmentActorType.HR,
  employeeId: 158,
  name: 'HR vận hành',
  roles: ['nhansu'],
};
const TEST = ChannelEventExcludeReason.TEST_MESSAGE;

/** DB giả: `FOR UPDATE` trả dòng hiện tại; UPDATE / SELECT sau cùng được ghi lại. */
function fakeDb(row: Record<string, unknown> | undefined) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/FOR UPDATE/.test(sql)) return Promise.resolve(row ? [row] : []);
    if (/^\s*UPDATE/.test(sql)) return Promise.resolve([[], 1]);
    if (/GROUP BY status, failure_code/.test(sql)) return Promise.resolve([]);
    return Promise.resolve([{ id: row?.id, status: 'IGNORED' }]);
  });
  const em = { query };
  return {
    dataSource: {
      query,
      transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
    },
    calls,
    ran: (re: RegExp) => calls.filter((c) => re.test(c.sql)),
  };
}

function service(db: ReturnType<typeof fakeDb>) {
  const audit = { recordMandatory: jest.fn().mockResolvedValue(undefined) };
  const svc = new RecruitmentChannelEventOperationsService(
    db.dataSource as any,
    audit as any,
  );
  return { svc, audit };
}

describe('RecruitmentChannelEventOperationsService.exclude', () => {
  it.each(['RECEIVED', 'FAILED'])(
    'event %s → IGNORED + failure_code = lý do, xoá nội dung, gỡ lease/lịch thử; audit đúng nhân viên, không nội dung',
    async (status) => {
      const db = fakeDb({ id: 2, status, failure_code: null, has_text: true });
      const { svc, audit } = service(db);

      await expect(svc.exclude(2, TEST, HR)).resolves.toMatchObject({
        idempotent: false,
      });
      // Khoá dòng trước khi đổi, trong cùng transaction.
      expect(db.dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(db.calls[0].sql).toMatch(/FOR UPDATE/);
      const [update] = db.ran(/^\s*UPDATE "recruitment_channel_events"/);
      expect(update.params).toEqual([2, 'TEST_MESSAGE', status]);
      expect(update.sql).toMatch(/status = 'IGNORED'/);
      expect(update.sql).toMatch(/normalized_message_text = NULL/);
      expect(update.sql).toMatch(
        /lease_until = NULL, lease_owner = NULL, next_attempt_at = NULL/,
      );
      // Chỉ áp khi trạng thái chưa đổi kể từ lúc khoá (fencing).
      expect(update.sql).toMatch(/WHERE id = \$1 AND status = \$3/);
      expect(audit.recordMandatory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        actor: HR,
        action: 'CHANNEL_EVENT_EXCLUDE',
        entity: 'channel-events',
        entityId: 2,
        context: {
          eventId: 2,
          reason: 'TEST_MESSAGE',
          from: status,
          to: 'IGNORED',
          textRemoved: true,
        },
      }));
    },
  );

  it('đã IGNORED cùng lý do → idempotent: không UPDATE, không audit', async () => {
    const db = fakeDb({
      id: 2,
      status: 'IGNORED',
      failure_code: 'TEST_MESSAGE',
      has_text: false,
    });
    const { svc, audit } = service(db);
    await expect(svc.exclude(2, TEST, HR)).resolves.toMatchObject({
      idempotent: true,
    });
    expect(db.ran(/^\s*UPDATE/)).toHaveLength(0);
    expect(audit.recordMandatory).not.toHaveBeenCalled();
  });

  it.each([
    ['PROCESSING', null, 'CHANNEL_EVENT_IN_PROGRESS'],
    ['PROCESSED', null, 'CHANNEL_EVENT_NOT_EXCLUDABLE'],
    // IGNORED vì loại event không hỗ trợ (failure_code NULL) — không ghi đè lý do gốc.
    ['IGNORED', null, 'CHANNEL_EVENT_NOT_EXCLUDABLE'],
  ])(
    'event %s (failure_code %s) → 409 %s, không đổi gì',
    async (status, failureCode, code) => {
      const db = fakeDb({
        id: 7,
        status,
        failure_code: failureCode,
        has_text: false,
      });
      const { svc, audit } = service(db);
      const error = await svc.exclude(7, TEST, HR).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code, status });
      expect(db.ran(/^\s*UPDATE/)).toHaveLength(0);
      expect(audit.recordMandatory).not.toHaveBeenCalled();
    },
  );

  it('không có event → 404 CHANNEL_EVENT_NOT_FOUND', async () => {
    const db = fakeDb(undefined);
    const { svc } = service(db);
    const error = await svc.exclude(99, TEST, HR).catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getResponse()).toMatchObject({
      code: 'CHANNEL_EVENT_NOT_FOUND',
    });
  });
});

describe('RecruitmentChannelEventOperationsService.stats', () => {
  it('đếm theo trạng thái + lý do; tin đang chờ = RECEIVED, cũ nhất', async () => {
    const rows = [
      {
        status: 'IGNORED',
        failureCode: null,
        count: 3,
        oldest: new Date('2026-10-10T01:00:00Z'),
      },
      {
        status: 'IGNORED',
        failureCode: 'TEST_MESSAGE',
        count: 2,
        oldest: new Date('2026-10-12T08:41:55Z'),
      },
      {
        status: 'RECEIVED',
        failureCode: null,
        count: 4,
        oldest: new Date('2026-10-12T09:00:00Z'),
      },
    ];
    const query = jest.fn().mockResolvedValue(rows);
    const svc = new RecruitmentChannelEventOperationsService(
      { query } as any,
      { record: jest.fn() } as any,
    );
    await expect(svc.stats()).resolves.toEqual({
      byStatus: rows,
      waiting: { count: 4, oldest: new Date('2026-10-12T09:00:00Z') },
    });
    // Không đọc nội dung tin / người gửi.
    expect(query.mock.calls[0][0]).not.toMatch(
      /normalized_message_text|external_sender_id/,
    );
  });
});

describe('ExcludeChannelEventDto', () => {
  const errors = (body: unknown) =>
    validateSync(plainToInstance(ExcludeChannelEventDto, body));

  it('nhận lý do đã định nghĩa', () => {
    expect(errors({ reason: 'TEST_MESSAGE' })).toHaveLength(0);
  });

  it.each([{}, { reason: 'SPAM' }, { reason: '' }, { reason: 1 }])(
    'từ chối %j',
    (body) => {
      expect(errors(body)).not.toHaveLength(0);
    },
  );
});
