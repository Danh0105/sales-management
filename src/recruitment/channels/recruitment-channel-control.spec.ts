import { BadRequestException, ConflictException, Logger } from '@nestjs/common';

import { REDACTED_BODY_PATHS } from '../../activity-log/audited-entities';
import { RecruitmentActorType } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { RecruitmentConversationControlService } from './recruitment-conversation-control.service';
import { RecruitmentHrAlertService } from './recruitment-hr-alert.service';
import { RecruitmentOutboxOperationsService } from './recruitment-outbox-operations.service';

const HR: RecruitmentActor = {
  type: RecruitmentActorType.HR,
  employeeId: 42,
  name: 'HR Lan',
  roles: ['nhansu'],
};
const TEXT = 'Chào bạn, mình là chị Lan bên nhân sự KIDO.';

/** DB giả: trả kết quả theo câu SQL (regex), ghi lại mọi câu đã chạy. */
function fakeDb(routes: Array<[RegExp, (params: unknown[]) => unknown]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const route = routes.find(([re]) => re.test(sql));
    return Promise.resolve(route ? route[1](params) : []);
  });
  const em = { query };
  const dataSource = {
    query,
    manager: em,
    transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
  };
  return {
    dataSource,
    calls,
    ran: (re: RegExp) => calls.filter((c) => re.test(c.sql)),
  };
}

function controlRow(patch: Record<string, unknown> = {}) {
  return {
    id: 9,
    candidate_id: 7,
    status: 'ACTIVE',
    control_mode: 'AI_ACTIVE',
    control_version: 3,
    resume_signal_pending: false,
    taken_over_by: null,
    channel: 'ZALO',
    external_conversation_id: 'oa-recruit:8812345',
    ai_stopped: false,
    app_paused: false,
    handoff_open: false,
    ...patch,
  };
}

function controlService(db: ReturnType<typeof fakeDb>) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const applications = { resumeAi: jest.fn().mockResolvedValue({}) };
  const service = new RecruitmentConversationControlService(
    db.dataSource as any,
    applications as any,
    audit as any,
    {
      get: (key: string) =>
        key === 'RECRUITMENT_ZALO_OA_ID' ? 'oa-recruit' : undefined,
    } as any,
  );
  return { service, audit, applications };
}

describe('RecruitmentConversationControlService — trạng thái hiệu lực', () => {
  it.each([
    ['AI_ACTIVE, không gì chặn', {}, 'AI_ACTIVE', []],
    [
      'handoff mở → AI_PAUSED',
      { handoff_open: true },
      'AI_PAUSED',
      ['HANDOFF_OPEN'],
    ],
    [
      'hồ sơ aiPaused → AI_PAUSED',
      { app_paused: true },
      'AI_PAUSED',
      ['APPLICATION_PAUSED'],
    ],
    [
      'ứng viên dừng AI → AI_PAUSED',
      { ai_stopped: true },
      'AI_PAUSED',
      ['CANDIDATE_AI_STOPPED'],
    ],
    [
      'HR tiếp quản (dù có handoff) → HUMAN_TAKEOVER',
      { control_mode: 'HUMAN_TAKEOVER', handoff_open: true },
      'HUMAN_TAKEOVER',
      ['HANDOFF_OPEN'],
    ],
    [
      'đóng → CLOSED',
      { control_mode: 'CLOSED', status: 'CLOSED' },
      'CLOSED',
      [],
    ],
  ])('%s', async (_name, patch, state, pausedBy) => {
    const db = fakeDb([
      [/FROM "recruitment_conversations" c/, () => [controlRow(patch)]],
    ]);
    const control = await controlService(db).service.control(9);
    expect(control).toMatchObject({ state, pausedBy, version: 3 });
  });
});

describe('RecruitmentConversationControlService — thao tác HR', () => {
  it('takeover khi đã HUMAN_TAKEOVER → idempotent: không tăng version, không audit', async () => {
    const db = fakeDb([
      [
        /FROM "recruitment_conversations" c/,
        () => [controlRow({ control_mode: 'HUMAN_TAKEOVER' })],
      ],
    ]);
    const { service, audit } = controlService(db);
    await expect(service.takeover(9, HR)).resolves.toMatchObject({
      changed: false,
      state: 'HUMAN_TAKEOVER',
    });
    expect(db.ran(/UPDATE "recruitment_conversations"/)).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('takeover → khoá dòng hội thoại, tăng version, audit đúng nhân viên', async () => {
    let mode = 'AI_ACTIVE';
    const db = fakeDb([
      [
        /FROM "recruitment_conversations" c/,
        () => [
          controlRow({
            control_mode: mode,
            control_version: mode === 'AI_ACTIVE' ? 3 : 4,
          }),
        ],
      ],
      [
        /UPDATE "recruitment_conversations"/,
        () => {
          mode = 'HUMAN_TAKEOVER';
          return [];
        },
      ],
      [
        /FROM "recruitment_channel_outbox" o/,
        () => [
          { id: 70, dispatched: true },
          { id: 71, dispatched: false },
          { id: 72, dispatched: false },
        ],
      ],
    ]);
    const { service, audit } = controlService(db);
    await expect(service.takeover(9, HR)).resolves.toMatchObject({
      changed: true,
      state: 'HUMAN_TAKEOVER',
      version: 4,
      aiOutbound: { alreadyDispatched: [70], willBeSuppressed: [71, 72] },
    });
    // Tin AI còn trong outbox: đọc trong CÙNG transaction giữ FOR UPDATE, sau khi đổi chế độ.
    const order = db.calls.map((c) =>
      /FOR UPDATE OF c/.test(c.sql)
        ? 'lock'
        : /control_version = control_version \+ 1/.test(c.sql)
          ? 'mode'
          : /FROM "recruitment_channel_outbox" o/.test(c.sql)
            ? 'outbox'
            : null,
    );
    expect(order.filter(Boolean).slice(0, 3)).toEqual([
      'lock',
      'mode',
      'outbox',
    ]);
    expect(db.ran(/FROM "recruitment_channel_outbox" o/)[0].sql).toMatch(
      /source_type = 'AI_REPLY'/,
    );
    expect(db.ran(/FOR UPDATE OF c/).length).toBeGreaterThan(0);
    expect(db.ran(/control_version = control_version \+ 1/)[0].params).toEqual([
      9,
      'HUMAN_TAKEOVER',
      42,
      false,
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: HR,
        action: 'CONVERSATION_TAKEOVER',
        entity: 'conversations',
        entityId: 9,
        context: {
          version: 4,
          aiOutbound: { alreadyDispatched: [70], willBeSuppressed: [71, 72] },
        },
      }),
    );
  });

  it('resume AI khi ứng viên đã yêu cầu xoá dữ liệu → 409, không đổi gì', async () => {
    const db = fakeDb([
      [
        /FROM "recruitment_conversations" c/,
        () => [
          controlRow({ ai_stopped: true, control_mode: 'HUMAN_TAKEOVER' }),
        ],
      ],
    ]);
    const { service } = controlService(db);
    await expect(service.resumeAi(9, {}, HR)).rejects.toMatchObject({
      response: { code: 'AI_STOPPED_FOR_CANDIDATE' },
    });
    expect(db.ran(/UPDATE/)).toHaveLength(0);
  });

  it('resume AI → mở khoá hồ sơ bằng nghiệp vụ Phase 1, trả handoff về AI, bật cờ nhắc làm mới context', async () => {
    let mode = 'HUMAN_TAKEOVER';
    const db = fakeDb([
      [
        /FROM "recruitment_conversations" c/,
        () => [
          controlRow({ control_mode: mode, app_paused: mode !== 'AI_ACTIVE' }),
        ],
      ],
      [/SELECT a.id FROM "recruitment_applications"/, () => [{ id: 31 }]],
      [
        /UPDATE "recruitment_conversations"/,
        () => {
          mode = 'AI_ACTIVE';
          return [];
        },
      ],
    ]);
    const { service, applications, audit } = controlService(db);
    await service.resumeAi(9, { note: 'đã gọi ứng viên' }, HR);
    expect(applications.resumeAi).toHaveBeenCalledWith(
      31,
      { note: 'đã gọi ứng viên', status: undefined },
      HR,
    );
    expect(db.ran(/UPDATE "recruitment_handoffs"/)[0].sql).toMatch(
      /RETURNED_TO_AI/,
    );
    expect(db.ran(/control_version = control_version \+ 1/)[0].params).toEqual([
      9,
      'AI_ACTIVE',
      42,
      true,
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONVERSATION_RESUME_AI' }),
    );
  });
});

describe('RecruitmentConversationControlService.sendHumanMessage', () => {
  const dto = { content: TEXT, clientMessageId: 'c0ffee00-1111' };

  it.each([
    [
      'clientMessageId sai',
      { ...dto, clientMessageId: 'x' },
      'CLIENT_MESSAGE_ID_INVALID',
    ],
    ['nội dung rỗng', { ...dto, content: '   ' }, 'CONTENT_INVALID'],
    [
      'nội dung quá 2000 ký tự',
      { ...dto, content: 'a'.repeat(2001) },
      'CONTENT_INVALID',
    ],
  ])('%s → 400, không chạm DB', async (_name, body, code) => {
    const db = fakeDb([]);
    const error = await controlService(db)
      .service.sendHumanMessage(9, body, HR)
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(code);
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    ['hội thoại không phải Zalo', { channel: 'WEB' }, 'CHANNEL_NOT_SUPPORTED'],
    [
      'hội thoại của OA khác',
      { external_conversation_id: 'oa-teacher:8812345' },
      'OA_MISMATCH',
    ],
    [
      'hội thoại đã đóng',
      { control_mode: 'CLOSED', status: 'CLOSED' },
      'CONVERSATION_CLOSED',
    ],
  ])('%s → 409, không tạo tin/outbox', async (_name, patch, code) => {
    const db = fakeDb([
      [/FROM "recruitment_conversations" c/, () => [controlRow(patch)]],
    ]);
    const error = await controlService(db)
      .service.sendHumanMessage(9, dto, HR)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe(code);
    expect(db.ran(/INSERT/)).toHaveLength(0);
  });

  it('AI đang chạy → tự chuyển HUMAN_TAKEOVER, tạo tin HR (tác giả) + đúng một outbox HR_MESSAGE; audit không chứa nội dung', async () => {
    const db = fakeDb([
      [/FROM "recruitment_conversations" c/, () => [controlRow()]],
      [/INSERT INTO "recruitment_messages"/, () => [{ id: 501 }]],
      [/INSERT INTO "recruitment_channel_outbox"/, () => [{ id: 601 }]],
      [/SELECT control_version FROM/, () => [{ control_version: 4 }]],
      [
        /FROM "recruitment_channel_outbox" o/,
        () => [{ id: 600, dispatched: false }],
      ],
    ]);
    const { service, audit } = controlService(db);
    await expect(service.sendHumanMessage(9, dto, HR)).resolves.toEqual({
      messageId: 501,
      outboxId: 601,
      outboxStatus: 'PENDING',
      idempotent: false,
      tookOver: true,
      version: 4,
      aiOutbound: { alreadyDispatched: [], willBeSuppressed: [600] },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CONVERSATION_TAKEOVER',
        context: {
          version: 4,
          trigger: 'HR_MESSAGE',
          aiOutbound: { alreadyDispatched: [], willBeSuppressed: [600] },
        },
      }),
    );
    expect(db.ran(/control_version = control_version \+ 1/)[0].params[1]).toBe(
      'HUMAN_TAKEOVER',
    );
    expect(db.ran(/INSERT INTO "recruitment_messages"/)[0].params).toEqual([
      9,
      'hr:c0ffee00-1111',
      TEXT,
      42,
    ]);
    expect(db.ran(/INSERT INTO "recruitment_messages"/)[0].sql).toMatch(
      /'HR', 'OUTBOUND'/,
    );
    expect(
      db.ran(/INSERT INTO "recruitment_channel_outbox"/)[0].params,
    ).toEqual(['oa-recruit', '8812345', TEXT, 501]);
    expect(db.ran(/INSERT INTO "recruitment_channel_outbox"/)[0].sql).toMatch(
      /'HR_MESSAGE'/,
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(TEXT);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CONVERSATION_HR_MESSAGE',
        context: { messageId: 501, outboxId: 601, length: TEXT.length },
      }),
    );
  });

  it('gửi lại cùng clientMessageId → idempotent: không tin/outbox mới, không audit', async () => {
    const db = fakeDb([
      [
        /FROM "recruitment_conversations" c/,
        () => [controlRow({ control_mode: 'HUMAN_TAKEOVER' })],
      ],
      [
        /SELECT id, content, author_employee_id FROM "recruitment_messages"/,
        () => [{ id: 501, content: TEXT, author_employee_id: 42 }],
      ],
      [
        /SELECT id, status FROM "recruitment_channel_outbox"/,
        () => [{ id: 601, status: 'SENT' }],
      ],
    ]);
    const { service, audit } = controlService(db);
    await expect(service.sendHumanMessage(9, dto, HR)).resolves.toMatchObject({
      messageId: 501,
      outboxId: 601,
      idempotent: true,
    });
    expect(db.ran(/INSERT/)).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('clientMessageId đã dùng cho nội dung khác → 409', async () => {
    const db = fakeDb([
      [/FROM "recruitment_conversations" c/, () => [controlRow()]],
      [
        /SELECT id, content, author_employee_id FROM "recruitment_messages"/,
        () => [{ id: 501, content: 'khác', author_employee_id: 42 }],
      ],
    ]);
    await expect(
      controlService(db).service.sendHumanMessage(9, dto, HR),
    ).rejects.toMatchObject({
      response: { code: 'CLIENT_MESSAGE_ID_REUSED' },
    });
  });
});

describe('RecruitmentOutboxOperationsService — đối soát UNKNOWN', () => {
  function ops(db: ReturnType<typeof fakeDb>) {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const alerts = {
      acknowledgeSource: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new RecruitmentOutboxOperationsService(
        db.dataSource as any,
        audit as any,
        alerts as any,
      ),
      audit,
      alerts,
    };
  }

  it('retry thiếu confirmDuplicateRisk → 400, không chạm DB', async () => {
    const db = fakeDb([]);
    await expect(ops(db).service.retry(40, {}, HR)).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_REQUIRED' },
    });
    expect(db.calls).toHaveLength(0);
  });

  it('mark-sent: chỉ từ UNKNOWN, redact nội dung, đóng cảnh báo, audit đúng người — không có lời gọi mạng nào', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const db = fakeDb([
      [
        /UPDATE "recruitment_channel_outbox"/,
        () => [[{ id: 40, last_error_code: 'RESPONSE_TIMEOUT' }], 1],
      ],
      [
        /SELECT id, status, resolution, resolved_by AS/,
        () => [{ id: 40, status: 'SENT', resolution: 'MARK_SENT' }],
      ],
    ]);
    const { service, audit, alerts } = ops(db);
    await expect(service.markSent(40, {}, HR)).resolves.toMatchObject({
      status: 'SENT',
      idempotent: false,
    });
    const update = db.ran(/UPDATE "recruitment_channel_outbox"/)[0];
    expect(update.sql).toMatch(/WHERE id = \$1 AND status = 'UNKNOWN'/);
    expect(update.sql).toMatch(/message_text = NULL/);
    expect(update.params.slice(0, 2)).toEqual([40, 42]);
    expect(alerts.acknowledgeSource).toHaveBeenCalledWith(
      'OUTBOUND_UNKNOWN',
      'outbox:40',
      HR,
      expect.anything(),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: HR,
        action: 'OUTBOX_MARK_SENT',
        entityId: 40,
        context: expect.objectContaining({
          from: 'UNKNOWN',
          to: 'SENT',
          previousCode: 'RESPONSE_TIMEOUT',
        }),
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('retry: nội dung lấy lại từ tin canonical, về PENDING (giữ vị trí đầu hàng)', async () => {
    const db = fakeDb([
      [
        /UPDATE "recruitment_channel_outbox" o/,
        () => [[{ id: 41, last_error_code: 'CONNECTION_LOST' }], 1],
      ],
      [
        /SELECT id, status, resolution, resolved_by AS/,
        () => [{ id: 41, status: 'PENDING', resolution: 'RETRY' }],
      ],
    ]);
    const { service } = ops(db);
    await expect(
      service.retry(41, { confirmDuplicateRisk: true }, HR),
    ).resolves.toMatchObject({ status: 'PENDING' });
    expect(db.ran(/UPDATE "recruitment_channel_outbox" o/)[0].sql).toMatch(
      /message_text = m.content/,
    );
  });

  it('bấm lại cùng thao tác → idempotent, không audit, không gửi lại', async () => {
    const db = fakeDb([
      [/UPDATE "recruitment_channel_outbox"/, () => [[], 0]],
      [
        /SELECT id, status, resolution, resolved_by, last_error_code/,
        () => [{ id: 41, status: 'SENT', resolution: 'RETRY' }],
      ],
      [
        /SELECT id, status, resolution, resolved_by AS/,
        () => [{ id: 41, status: 'SENT', resolution: 'RETRY' }],
      ],
    ]);
    const { service, audit } = ops(db);
    await expect(
      service.retry(41, { confirmDuplicateRisk: true }, HR),
    ).resolves.toMatchObject({ idempotent: true });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('dòng không ở UNKNOWN (và không phải cùng thao tác) → 409', async () => {
    const db = fakeDb([
      [/UPDATE "recruitment_channel_outbox"/, () => [[], 0]],
      [
        /SELECT id, status, resolution, resolved_by, last_error_code/,
        () => [{ id: 42, status: 'PENDING', resolution: null }],
      ],
    ]);
    await expect(ops(db).service.deadLetter(42, HR)).rejects.toMatchObject({
      response: { code: 'OUTBOX_NOT_UNKNOWN' },
    });
  });
});

describe('RecruitmentHrAlertService', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('raise: INSERT ... ON CONFLICT (type, source_key) DO NOTHING, chỉ metadata', async () => {
    const db = fakeDb([
      [/INSERT INTO "recruitment_hr_alerts"/, () => [{ id: 1 }]],
    ]);
    const service = new RecruitmentHrAlertService(
      db.dataSource as any,
      { record: jest.fn() } as any,
    );
    await service.raise({
      type: 'OUTBOUND_UNKNOWN' as any,
      severity: 'HIGH' as any,
      sourceKey: 'outbox:40',
      outboxId: 40,
      details: { code: 'X' },
    });
    const call = db.ran(/INSERT INTO "recruitment_hr_alerts"/)[0];
    expect(call.sql).toMatch(
      /ON CONFLICT ON CONSTRAINT "UQ_recruitment_hr_alerts_source" DO NOTHING/,
    );
    expect(call.params).toEqual([
      'OUTBOUND_UNKNOWN',
      'HIGH',
      'outbox:40',
      null,
      null,
      null,
      null,
      40,
      null,
      '{"code":"X"}',
    ]);
  });

  it('acknowledge lần 2 → idempotent: giữ nguyên người + thời điểm lần đầu, không audit lại', async () => {
    const first = {
      id: 5,
      status: 'ACKNOWLEDGED',
      acknowledgedAt: '2026-10-08T07:00:00Z',
      acknowledgedBy: 42,
    };
    const db = fakeDb([
      [/UPDATE "recruitment_hr_alerts"/, () => [[], 0]],
      [/SELECT id, status, acknowledged_at/, () => [first]],
    ]);
    const audit = { record: jest.fn() };
    const service = new RecruitmentHrAlertService(
      db.dataSource as any,
      audit as any,
    );
    await expect(
      service.acknowledge(5, { ...HR, employeeId: 99 }),
    ).resolves.toEqual({ ...first, idempotent: true });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('acknowledge lần đầu → ghi đúng nhân viên + audit', async () => {
    const db = fakeDb([
      [
        /UPDATE "recruitment_hr_alerts"/,
        () => [[{ id: 5, status: 'ACKNOWLEDGED', acknowledgedBy: 42 }], 1],
      ],
    ]);
    const audit = { record: jest.fn() };
    const service = new RecruitmentHrAlertService(
      db.dataSource as any,
      audit as any,
    );
    await expect(service.acknowledge(5, HR)).resolves.toMatchObject({
      acknowledgedBy: 42,
      idempotent: false,
    });
    expect(db.ran(/UPDATE "recruitment_hr_alerts"/)[0].params).toEqual([
      5,
      42,
      'HR Lan',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: HR,
        action: 'HR_ALERT_ACKNOWLEDGE',
        entityId: 5,
      }),
    );
  });
});

describe('activity_log: không chép nội dung tin HR', () => {
  it.each([
    ['/recruitment/conversations/12/messages', true],
    ['/recruitment/conversations/12/takeover', false],
    ['/recruitment/candidates/12', false],
  ])('%s → ẩn body: %s', (path, redacted) => {
    expect(REDACTED_BODY_PATHS.some((re) => re.test(path))).toBe(redacted);
  });
});
