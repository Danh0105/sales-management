import type { DataSource } from 'typeorm';

import type { RecruitmentAuditService } from '../recruitment-audit.service';
import { RecruitmentActorType } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import type { RecruitmentHrAlertService } from './recruitment-hr-alert.service';
import { RecruitmentOutboxOperationsService } from './recruitment-outbox-operations.service';

const HR: RecruitmentActor = {
  type: RecruitmentActorType.HR,
  employeeId: 158,
  name: 'HR trực ca',
  roles: ['HR'],
};
const REASON = 'Tin thử nghiệm nội bộ, không còn cần gửi';

function setup(
  current: Record<string, unknown> | null,
  opts: { ledger?: boolean; risky?: number; updated?: boolean } = {},
) {
  const sqls: string[] = [];
  const em = {
    query: jest.fn((sql: string) => {
      sqls.push(sql);
      if (/FOR UPDATE/.test(sql))
        return Promise.resolve(current ? [current] : []);
      if (/to_regclass/.test(sql)) {
        return Promise.resolve([{ ready: opts.ledger ?? true }]);
      }
      if (/FROM "recruitment_outbound_attempts"/.test(sql)) {
        return Promise.resolve([{ n: opts.risky ?? 0 }]);
      }
      if (/^\s*UPDATE "recruitment_channel_outbox"/.test(sql)) {
        return Promise.resolve(
          opts.updated === false ? [[], 0] : [[{ id: 7 }], 1],
        );
      }
      return Promise.resolve([[], 1]);
    }),
  };
  const dataSource = {
    transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
  };
  const recordMandatory = jest.fn().mockResolvedValue(undefined);
  const service = new RecruitmentOutboxOperationsService(
    dataSource as unknown as DataSource,
    { recordMandatory } as unknown as RecruitmentAuditService,
    {} as RecruitmentHrAlertService,
  );
  return { service, sqls, recordMandatory, em };
}

const pending = {
  status: 'PENDING',
  source_type: 'HR_MESSAGE',
  dispatched_at: null,
  last_error_code: null,
  recruitment_message_id: 55,
};

describe('RecruitmentOutboxOperationsService.cancelHrMessage — huỷ tin HR có audit', () => {
  it('PENDING → DEAD_LETTER HR_CANCELLED + resolution + metadata + audit bắt buộc cùng transaction', async () => {
    const { service, sqls, recordMandatory, em } = setup(pending);
    await expect(service.cancelHrMessage(7, REASON, HR)).resolves.toEqual({
      id: 7,
      status: 'DEAD_LETTER',
      code: 'HR_CANCELLED',
      idempotent: false,
    });
    const update = sqls.find((s) =>
      /^\s*UPDATE "recruitment_channel_outbox"/.test(s),
    )!;
    expect(update).toMatch(/last_error_code = 'HR_CANCELLED'/);
    expect(update).toMatch(/status IN \('PENDING', 'RETRY'\)/);
    expect(update).toMatch(/dispatched_at IS NULL/);
    expect(update).toMatch(/resolution = 'DEAD_LETTER', resolved_by = \$2/);
    expect(sqls.some((s) => /DEAD_LETTER_HR_CANCELLED/.test(s))).toBe(true);
    expect(recordMandatory).toHaveBeenCalledWith(
      em,
      expect.objectContaining({
        actor: HR,
        action: 'OUTBOX_HR_CANCEL',
        entityId: 7,
        context: expect.objectContaining({ outboxId: 7, reason: REASON }),
      }),
    );
  });

  it('RETRY (chắc chắn chưa tới Zalo) cũng huỷ được', async () => {
    const { service } = setup({ ...pending, status: 'RETRY' });
    await expect(service.cancelHrMessage(7, REASON, HR)).resolves.toMatchObject(
      {
        status: 'DEAD_LETTER',
      },
    );
  });

  it.each([
    ['SENDING (đang dispatch)', { status: 'SENDING' }],
    ['SENT', { status: 'SENT' }],
    ['UNKNOWN (chờ đối soát)', { status: 'UNKNOWN' }],
    ['PENDING nhưng đã có dispatched_at', { dispatched_at: new Date() }],
  ])('%s → 409 OUTBOX_NOT_CANCELLABLE, không ghi gì', async (_n, patch) => {
    const { service, sqls, recordMandatory } = setup({ ...pending, ...patch });
    await expect(service.cancelHrMessage(7, REASON, HR)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OUTBOX_NOT_CANCELLABLE' }),
    });
    expect(sqls.some((s) => /^\s*UPDATE/.test(s))).toBe(false);
    expect(recordMandatory).not.toHaveBeenCalled();
  });

  it('tin AI → 409 OUTBOX_NOT_HR_MESSAGE', async () => {
    const { service } = setup({ ...pending, source_type: 'AI_REPLY' });
    await expect(service.cancelHrMessage(7, REASON, HR)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OUTBOX_NOT_HR_MESSAGE' }),
    });
  });

  it('ledger có request có thể đã tới Zalo → 409, không huỷ', async () => {
    const { service, recordMandatory } = setup(pending, { risky: 1 });
    await expect(service.cancelHrMessage(7, REASON, HR)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OUTBOX_MAY_HAVE_BEEN_SENT' }),
    });
    expect(recordMandatory).not.toHaveBeenCalled();
  });

  it('đã huỷ trước đó → idempotent, không audit lại', async () => {
    const { service, recordMandatory } = setup({
      ...pending,
      status: 'DEAD_LETTER',
      last_error_code: 'HR_CANCELLED',
    });
    await expect(service.cancelHrMessage(7, REASON, HR)).resolves.toMatchObject(
      {
        idempotent: true,
      },
    );
    expect(recordMandatory).not.toHaveBeenCalled();
  });

  it('lý do quá ngắn → 400; không có dòng → 404', async () => {
    const { service } = setup(pending);
    await expect(
      service.cancelHrMessage(7, ' dawdwa ', HR),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CANCEL_REASON_REQUIRED' }),
    });
    const missing = setup(null);
    await expect(
      missing.service.cancelHrMessage(7, REASON, HR),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OUTBOX_NOT_FOUND' }),
    });
  });

  it('UPDATE không áp được dù đã khoá dòng → ném lỗi (rollback cả audit)', async () => {
    const { service } = setup(pending, { updated: false });
    await expect(service.cancelHrMessage(7, REASON, HR)).rejects.toThrow(
      'HR_CANCEL_UPDATE_FAILED',
    );
  });
});
