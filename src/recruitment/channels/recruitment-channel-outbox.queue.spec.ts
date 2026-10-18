import {
  RecruitmentChannelOutboxQueue,
  type ClaimedOutbox,
} from './recruitment-channel-outbox.queue';
import { pilotFingerprint } from './recruitment-ai-safety.config';

function row(patch: Partial<ClaimedOutbox> = {}): ClaimedOutbox {
  return {
    id: 21,
    channelAccountId: 'oa-recruit',
    externalRecipientId: '8812345',
    messageText: 'Chào bạn',
    recruitmentMessageId: 301,
    attemptCount: 1,
    sourceType: 'AI_REPLY',
    controlVersion: 3,
    ...patch,
  };
}

/** DB giả cho `dispatch()`: hội thoại của tin canonical + kết quả UPDATE có fencing. */
function fakeDb(
  control: { control_mode: string; control_version: number } | null,
  updated = true,
  /** Dòng `recruitment_runtime_controls`: `null` = không có dòng (fail-closed). */
  runtime: { outbound_halted: boolean; failsafe_halted?: boolean } | null = {
    outbound_halted: false,
    failsafe_halted: false,
  },
) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const em = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM "recruitment_runtime_controls"/.test(sql)) {
        return Promise.resolve(runtime ? [runtime] : []);
      }
      if (/FROM "recruitment_conversations" c/.test(sql)) {
        return Promise.resolve(control ? [{ id: 9, ...control }] : []);
      }
      if (/UPDATE "recruitment_channel_outbox"/.test(sql)) {
        // TypeORM postgres: UPDATE ... RETURNING → [rows, rowCount]
        return Promise.resolve(updated ? [[{ id: 21 }], 1] : [[], 0]);
      }
      return Promise.resolve([[], 1]);
    }),
  };
  const dataSource = {
    transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
  };
  return {
    queue: new RecruitmentChannelOutboxQueue(dataSource as any),
    dataSource,
    ran: (re: RegExp) => calls.filter((c) => re.test(c.sql)),
  };
}

describe('RecruitmentChannelOutboxQueue.dispatch — cửa kiểm cuối (P3-6.5)', () => {
  it('khoá chia sẻ dòng hội thoại trong CÙNG transaction với việc ghi dispatched_at', async () => {
    const db = fakeDb({ control_mode: 'AI_ACTIVE', control_version: 3 });
    await expect(db.queue.dispatch(row(), 'o1')).resolves.toEqual({
      outcome: 'DISPATCHED',
    });
    expect(db.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(db.ran(/FOR SHARE OF c/)[0].params).toEqual([301]);
    const [dispatch] = db.ran(/SET dispatched_at = now\(\)/);
    expect(dispatch.sql).toMatch(/status = 'SENDING' AND lease_owner = \$2/);
    expect(dispatch.params).toEqual([21, 'o1']);
    expect(db.ran(/SUPPRESSED/)).toHaveLength(0);
  });

  it.each([
    ['HR tiếp quản', 'HUMAN_TAKEOVER', 4, 3, 'CONTROL_HUMAN_TAKEOVER'],
    ['hội thoại đã đóng', 'CLOSED', 4, 3, 'CONTROL_CLOSED'],
    [
      'HR tiếp quản rồi trả lại AI (version đổi)',
      'AI_ACTIVE',
      5,
      3,
      'CONTROL_VERSION_CHANGED',
    ],
    [
      'tin AI không có version lúc xếp hàng',
      'AI_ACTIVE',
      3,
      null,
      'CONTROL_VERSION_MISSING',
    ],
  ])(
    'tin AI, %s → SUPPRESSED (%s): không ghi dispatched_at, xoá bản sao, đánh dấu tin canonical',
    async (_name, mode, current, enqueued, code) => {
      const db = fakeDb({ control_mode: mode, control_version: current });
      await expect(
        db.queue.dispatch(row({ controlVersion: enqueued }), 'o1'),
      ).resolves.toEqual({
        outcome: 'SUPPRESSED',
        code,
        conversationId: 9,
        mode,
        version: current,
      });
      expect(db.ran(/SET dispatched_at = now\(\)/)).toHaveLength(0);
      const [suppress] = db.ran(/SET status = 'SUPPRESSED'/);
      expect(suppress.sql).toMatch(/message_text = NULL/);
      expect(suppress.sql).toMatch(/source_type = 'AI_REPLY'/);
      expect(suppress.sql).toMatch(/dispatched_at IS NULL OR \$4::boolean/);
      expect(suppress.params).toEqual([21, 'o1', code, false]);
      expect(db.ran(/UPDATE "recruitment_messages"/)[0].params).toEqual([
        301,
        'SUPPRESSED_CONTROL_CHANGED',
      ]);
    },
  );

  it.each(['HUMAN_TAKEOVER', 'AI_ACTIVE'])(
    'tin HR khi %s → luôn DISPATCHED (version không áp cho tin HR)',
    async (mode) => {
      const db = fakeDb({ control_mode: mode, control_version: 8 });
      await expect(
        db.queue.dispatch(
          row({ sourceType: 'HR_MESSAGE', controlVersion: null }),
          'o1',
        ),
      ).resolves.toEqual({ outcome: 'DISPATCHED' });
      expect(db.ran(/SUPPRESSED/)).toHaveLength(0);
    },
  );

  it('gửi lại sau khi Zalo từ chối token → được chặn dù dispatched_at đã có (redispatch = true)', async () => {
    const db = fakeDb({ control_mode: 'HUMAN_TAKEOVER', control_version: 4 });
    await db.queue.dispatch(row(), 'o1', true);
    expect(db.ran(/SET status = 'SUPPRESSED'/)[0].params[3]).toBe(true);
  });

  it('không còn tin canonical / hội thoại → INVALID, không cập nhật gì', async () => {
    const db = fakeDb(null);
    await expect(db.queue.dispatch(row(), 'o1')).resolves.toEqual({
      outcome: 'INVALID',
      code: 'CANONICAL_MISSING',
    });
    await expect(
      db.queue.dispatch(row({ recruitmentMessageId: null }), 'o1'),
    ).resolves.toEqual({ outcome: 'INVALID', code: 'CANONICAL_MISSING' });
    expect(db.ran(/UPDATE/)).toHaveLength(0);
  });

  it.each([
    ['AI_ACTIVE', 3],
    ['HUMAN_TAKEOVER', 4],
  ])(
    'mất lease (%s) → LOST, không đánh dấu tin canonical',
    async (mode, version) => {
      const db = fakeDb(
        { control_mode: mode, control_version: version },
        false,
      );
      await expect(db.queue.dispatch(row(), 'o1')).resolves.toEqual({
        outcome: 'LOST',
      });
      expect(db.ran(/UPDATE "recruitment_messages"/)).toHaveLength(0);
    },
  );
});

describe('RecruitmentChannelOutboxQueue.dispatch — dừng khẩn + pilot (P3-7.3 / G8)', () => {
  it.each([
    [
      'outbound đang dừng khẩn',
      { outbound_halted: true, failsafe_halted: false },
    ],
    ['không có dòng điều khiển (fail-closed)', null],
  ])(
    '%s → HELD: trả về PENDING, hoàn lại lần thử, không ghi dispatched_at, không chặn tin',
    async (_name, runtime) => {
      const db = fakeDb(
        { control_mode: 'AI_ACTIVE', control_version: 3 },
        true,
        runtime,
      );
      await expect(db.queue.dispatch(row(), 'o1')).resolves.toEqual({
        outcome: 'HELD',
      });
      expect(db.ran(/FROM "recruitment_runtime_controls"/)[0].sql).toMatch(
        /FOR SHARE/,
      );
      const [held] = db.ran(/SET status = 'PENDING'/);
      expect(held.sql).toMatch(
        /attempt_count = greatest\(attempt_count - 1, 0\)/,
      );
      expect(held.sql).toMatch(/dispatched_at = NULL/);
      expect(held.params).toEqual([21, 'o1', false]);
      expect(db.ran(/SET dispatched_at = now\(\)/)).toHaveLength(0);
      expect(db.ran(/SUPPRESSED/)).toHaveLength(0);
      expect(db.ran(/FROM "recruitment_conversations" c/)).toHaveLength(0);
    },
  );

  it('đang dừng mà mất lease → LOST', async () => {
    const db = fakeDb(
      { control_mode: 'AI_ACTIVE', control_version: 3 },
      false,
      { outbound_halted: true, failsafe_halted: false },
    );
    await expect(db.queue.dispatch(row(), 'o1')).resolves.toEqual({
      outcome: 'LOST',
    });
  });

  it('pilot: tin AI tới người nhận NGOÀI allowlist → SUPPRESSED PILOT_RECIPIENT_BLOCKED, không gửi', async () => {
    const db = fakeDb({ control_mode: 'AI_ACTIVE', control_version: 3 });
    await expect(
      db.queue.dispatch(row(), 'o1', false, ['0000000000000000']),
    ).resolves.toMatchObject({
      outcome: 'SUPPRESSED',
      code: 'PILOT_RECIPIENT_BLOCKED',
    });
    expect(db.ran(/SET dispatched_at = now\(\)/)).toHaveLength(0);
    expect(db.ran(/UPDATE "recruitment_messages"/)[0].params).toEqual([
      301,
      'SUPPRESSED_PILOT',
    ]);
  });

  it('pilot: người nhận TRONG allowlist → DISPATCHED; tin HR tới người ngoài allowlist vẫn gửi', async () => {
    const allowed = pilotFingerprint('oa-recruit', '8812345');
    const db = fakeDb({ control_mode: 'AI_ACTIVE', control_version: 3 });
    await expect(
      db.queue.dispatch(row(), 'o1', false, [allowed]),
    ).resolves.toEqual({ outcome: 'DISPATCHED' });

    const hr = fakeDb({ control_mode: 'HUMAN_TAKEOVER', control_version: 4 });
    await expect(
      hr.queue.dispatch(
        row({ sourceType: 'HR_MESSAGE', controlVersion: null }),
        'o1',
        false,
        ['0000000000000000'],
      ),
    ).resolves.toEqual({ outcome: 'DISPATCHED' });
  });
});

describe('RecruitmentChannelOutboxQueue — single dispatch guard (G8 C2)', () => {
  const guard = { oaId: 'oa-recruit' };
  const sha = (t: string) =>
    require('crypto').createHash('sha256').update(t, 'utf8').digest('hex');
  const okGrant = {
    id: 7,
    status: 'ACTIVE',
    dispatches_used: 0,
    max_dispatches: 1,
    channel_account_id: 'oa-recruit',
    recipient_fingerprint: pilotFingerprint('oa-recruit', '8812345'),
    approved_text_sha256: sha('Chào bạn'),
    approved_control_version: 3,
    consumed_lease_owner: null,
    live: true,
  };

  function guardDb(grant: Record<string, unknown> | null, consumed = true) {
    const calls: string[] = [];
    const em = {
      query: jest.fn((sql: string) => {
        calls.push(sql);
        if (/pg_try_advisory_xact_lock/.test(sql))
          return Promise.resolve([{ locked: true }]);
        if (/FROM "recruitment_runtime_controls"/.test(sql))
          return Promise.resolve([
            { outbound_halted: false, failsafe_halted: false },
          ]);
        if (/FROM "recruitment_conversations" c/.test(sql))
          return Promise.resolve([
            { id: 9, control_mode: 'AI_ACTIVE', control_version: 3 },
          ]);
        if (
          /FROM "recruitment_outbound_dispatch_grants" WHERE outbox_id/.test(
            sql,
          )
        )
          return Promise.resolve(grant ? [grant] : []);
        if (/UPDATE "recruitment_outbound_dispatch_grants"/.test(sql))
          return Promise.resolve(consumed ? [[{ id: 7 }], 1] : [[], 0]);
        if (/UPDATE "recruitment_channel_outbox"/.test(sql))
          return Promise.resolve([[{ id: 21 }], 1]);
        return Promise.resolve([[{ outbox_id: 21 }], 1]);
      }),
    };
    const dataSource = {
      transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
      query: jest.fn((sql: string) => {
        calls.push(sql);
        return Promise.resolve([]);
      }),
    };
    const pilots = [pilotFingerprint('oa-recruit', '8812345')];
    return {
      queue: new RecruitmentChannelOutboxQueue(dataSource as any),
      calls,
      pilots,
      index: (re: RegExp) => calls.findIndex((c) => re.test(c)),
    };
  }

  it('claim: chỉ khi guard bật mới lọc theo grant ACTIVE + chỉ tin AI', async () => {
    const off = guardDb(okGrant);
    await off.queue.claimNext('oa-recruit', 'o1', 60_000, null);
    expect(off.calls.join('\n')).not.toContain(
      'recruitment_outbound_dispatch_grants',
    );
    const on = guardDb(okGrant);
    on.queue['dataSource'].query = jest
      .fn()
      .mockResolvedValue([{ id: 21, recipient: '8812345' }]);
    await on.queue.claimNext('oa-recruit', 'o1', 60_000, guard);
    const claim = on.calls.find((c) =>
      /UPDATE "recruitment_channel_outbox" t/.test(c),
    )!;
    expect(claim).toContain(`t.source_type = 'AI_REPLY' AND EXISTS`);
    expect(claim).toMatch(
      /g\.status = 'ACTIVE'\s+AND g\.dispatches_used < g\.max_dispatches AND g\.expires_at > now\(\)/,
    );
  });

  it('dispatch: khoá advisory + grant FOR UPDATE TRƯỚC khi ghi dispatched_at, tiêu grant SAU, cùng transaction', async () => {
    const db = guardDb(okGrant);
    await expect(
      db.queue.dispatch(row(), 'o1', false, db.pilots, guard),
    ).resolves.toEqual({ outcome: 'DISPATCHED' });
    const lock = db.index(
      /pg_advisory_xact_lock\(hashtext\('recruitment_outbound_dispatch_grants'\)\)/,
    );
    const select = db.index(
      /FROM "recruitment_outbound_dispatch_grants" WHERE outbox_id = \$1 FOR UPDATE/,
    );
    const dispatched = db.index(/SET dispatched_at = now\(\)/);
    const consume = db.index(/UPDATE "recruitment_outbound_dispatch_grants"/);
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(select);
    expect(select).toBeLessThan(dispatched);
    expect(dispatched).toBeLessThan(consume);
  });

  it('không có grant → HELD, không ghi dispatched_at, không tiêu', async () => {
    const db = guardDb(null);
    await expect(
      db.queue.dispatch(row(), 'o1', false, db.pilots, guard),
    ).resolves.toEqual({ outcome: 'HELD', code: 'DISPATCH_GRANT_MISSING' });
    expect(db.index(/SET dispatched_at = now\(\)/)).toBe(-1);
    expect(db.index(/UPDATE "recruitment_outbound_dispatch_grants"/)).toBe(-1);
  });

  it('tiêu grant không thành → ném lỗi (rollback cả dispatched_at), không trả DISPATCHED', async () => {
    const db = guardDb(okGrant, false);
    await expect(
      db.queue.dispatch(row(), 'o1', false, db.pilots, guard),
    ).rejects.toThrow('DISPATCH_GRANT_CONSUME_FAILED');
  });

  it('guard tắt → không đụng bảng grant (hành vi cũ)', async () => {
    const db = guardDb(null);
    await expect(
      db.queue.dispatch(row(), 'o1', false, db.pilots, null),
    ).resolves.toEqual({ outcome: 'DISPATCHED' });
    expect(db.calls.join('\n')).not.toContain(
      'recruitment_outbound_dispatch_grants',
    );
  });
});

describe('RecruitmentChannelOutboxQueue — production admission + quota ledger', () => {
  const production = {
    productionMode: true,
    interactionWindowHours: 168,
    freeWindowHours: 48,
    maxRequestsPerRecipientDay: 5,
    maxRequestsPerDay: 100,
    dailyCostBudgetVnd: 100_000,
    monthlyCostBudgetVnd: 2_000_000,
    estimatedPaidMessageCostVnd: 500,
  };

  function productionDb(
    patch: {
      hasApplication?: boolean;
      jobStatus?: string | null;
      jobPublishedAt?: Date | null;
      interactionAt?: Date | null;
      ageSeconds?: number;
      recipientDay?: number;
      totalDay?: number;
      costDay?: number;
      costMonth?: number;
    } = {},
  ) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const now = new Date('2026-10-18T03:00:00.000Z');
    const em = {
      query: jest.fn((sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/FROM "recruitment_runtime_controls"/.test(sql)) {
          return Promise.resolve([
            { outbound_halted: false, failsafe_halted: false },
          ]);
        }
        if (/FROM "recruitment_conversations" c/.test(sql)) {
          return Promise.resolve([
            { id: 9, control_mode: 'HUMAN_TAKEOVER', control_version: 8 },
          ]);
        }
        if (/AS has_application/.test(sql)) {
          return Promise.resolve([
            {
              has_application: patch.hasApplication ?? true,
              job_status:
                patch.jobStatus === undefined ? 'ACTIVE' : patch.jobStatus,
              job_published_at:
                patch.jobPublishedAt === undefined
                  ? new Date('2026-10-01T00:00:00.000Z')
                  : patch.jobPublishedAt,
              interaction_at:
                patch.interactionAt === undefined
                  ? new Date('2026-10-18T02:00:00.000Z')
                  : patch.interactionAt,
            },
          ]);
        }
        if (/interaction_age_seconds/.test(sql)) {
          return Promise.resolve([
            {
              at: now,
              day_start: new Date('2026-10-17T17:00:00.000Z'),
              next_day: new Date('2026-10-18T17:00:00.000Z'),
              month_start: new Date('2026-09-30T17:00:00.000Z'),
              next_month: new Date('2026-10-31T17:00:00.000Z'),
              interaction_age_seconds: patch.ageSeconds ?? 3600,
            },
          ]);
        }
        if (/AS recipient_day/.test(sql)) {
          return Promise.resolve([
            {
              recipient_day: patch.recipientDay ?? 0,
              total_day: patch.totalDay ?? 0,
              cost_day: patch.costDay ?? 0,
              cost_month: patch.costMonth ?? 0,
            },
          ]);
        }
        if (/UPDATE "recruitment_channel_outbox"/.test(sql)) {
          return Promise.resolve([[{ id: 21 }], 1]);
        }
        return Promise.resolve([]);
      }),
    };
    const dataSource = {
      transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
    };
    return {
      queue: new RecruitmentChannelOutboxQueue(dataSource as any),
      calls,
      ran: (re: RegExp) => calls.filter((call) => re.test(call.sql)),
    };
  }

  const hr = row({ sourceType: 'HR_MESSAGE', controlVersion: null });

  it('interaction hợp lệ + job ACTIVE + còn quota → ghi ledger rồi mới cho mở mạng', async () => {
    const db = productionDb();
    await expect(
      db.queue.dispatch(hr, 'owner-1', false, null, null, production),
    ).resolves.toEqual({ outcome: 'DISPATCHED' });
    expect(db.ran(/SET dispatched_at = now\(\)/)).toHaveLength(1);
    const [ledger] = db.ran(/INSERT INTO "recruitment_outbound_attempts"/);
    expect(ledger).toBeDefined();
    expect(ledger.params).toEqual([
      21,
      'owner-1',
      'HR_MESSAGE',
      'oa-recruit',
      pilotFingerprint('oa-recruit', '8812345'),
      new Date('2026-10-18T02:00:00.000Z'),
      0,
    ]);
    expect(JSON.stringify(ledger.params)).not.toContain('8812345');
  });

  it.each([
    [
      'không có interaction',
      { interactionAt: null },
      'ZALO_INTERACTION_MISSING',
    ],
    [
      'interaction quá 7 ngày',
      { ageSeconds: 169 * 3600 },
      'ZALO_INTERACTION_EXPIRED',
    ],
    ['job không còn công bố', { jobStatus: 'PAUSED' }, 'JOB_NOT_PUBLISHED'],
    [
      'job ACTIVE nhưng chưa từng publish',
      { jobPublishedAt: null },
      'JOB_NOT_PUBLISHED',
    ],
  ])('%s → INVALID, không dispatch/ledger', async (_name, patch, code) => {
    const db = productionDb(patch as any);
    await expect(
      db.queue.dispatch(hr, 'owner-1', false, null, null, production),
    ).resolves.toEqual({ outcome: 'INVALID', code });
    expect(db.ran(/SET dispatched_at = now\(\)/)).toHaveLength(0);
    expect(db.ran(/INSERT INTO "recruitment_outbound_attempts"/)).toHaveLength(
      0,
    );
  });

  it.each([
    ['ứng viên/ngày', { recipientDay: 5 }, 'OUTBOUND_RECIPIENT_DAILY_LIMIT'],
    ['toàn hệ thống/ngày', { totalDay: 100 }, 'OUTBOUND_DAILY_LIMIT'],
  ])(
    'chạm quota %s → INVALID (kết thúc + cảnh báo), không hoãn sang ngày sau, 0 request mạng',
    async (_n, patch, code) => {
      const db = productionDb(patch);
      await expect(
        db.queue.dispatch(hr, 'owner-1', false, null, null, production),
      ).resolves.toEqual({ outcome: 'INVALID', code });
      expect(db.ran(/SET status = 'RETRY'/)).toHaveLength(0);
      expect(db.ran(/SET dispatched_at = now\(\)/)).toHaveLength(0);
      expect(
        db.ran(/INSERT INTO "recruitment_outbound_attempts"/),
      ).toHaveLength(0);
    },
  );

  it('tin ngoài cửa sổ miễn phí giữ chi phí ước tính và chặn khi hết ngân sách', async () => {
    const allowed = productionDb({ ageSeconds: 49 * 3600 });
    await allowed.queue.dispatch(hr, 'owner-1', false, null, null, production);
    expect(
      allowed.ran(/INSERT INTO "recruitment_outbound_attempts"/)[0].params[6],
    ).toBe(500);

    const blocked = productionDb({
      ageSeconds: 49 * 3600,
      costDay: 100_000,
    });
    await expect(
      blocked.queue.dispatch(hr, 'owner-1', false, null, null, production),
    ).resolves.toEqual({
      outcome: 'INVALID',
      code: 'OUTBOUND_DAILY_COST_LIMIT',
    });

    // Ngân sách tin tính phí = 0 (ngày đầu) → mọi tin ngoài 48 giờ bị chặn ngay.
    const zeroBudget = productionDb({ ageSeconds: 49 * 3600 });
    await expect(
      zeroBudget.queue.dispatch(hr, 'owner-1', false, null, null, {
        ...production,
        dailyCostBudgetVnd: 0,
        monthlyCostBudgetVnd: 0,
      }),
    ).resolves.toEqual({
      outcome: 'INVALID',
      code: 'OUTBOUND_MONTHLY_COST_LIMIT',
    });
    expect(
      zeroBudget.ran(/INSERT INTO "recruitment_outbound_attempts"/),
    ).toHaveLength(0);
  });
});

describe('RecruitmentChannelOutboxQueue.dispatch — TTL tin HR', () => {
  function hrDb(expired: boolean | null) {
    const calls: string[] = [];
    const em = {
      query: jest.fn((sql: string) => {
        calls.push(sql);
        if (/FROM "recruitment_runtime_controls"/.test(sql)) {
          return Promise.resolve([
            { outbound_halted: false, failsafe_halted: false },
          ]);
        }
        if (/FROM "recruitment_conversations" c/.test(sql)) {
          return Promise.resolve([
            { id: 9, control_mode: 'HUMAN_TAKEOVER', control_version: 4 },
          ]);
        }
        if (/AS expired/.test(sql)) {
          return Promise.resolve(expired === null ? [] : [{ expired }]);
        }
        if (/UPDATE "recruitment_channel_outbox"/.test(sql)) {
          return Promise.resolve([[{ id: 21 }], 1]);
        }
        return Promise.resolve([[], 1]);
      }),
    };
    const dataSource = {
      transaction: jest.fn((fn: (e: typeof em) => unknown) => fn(em)),
    };
    return {
      queue: new RecruitmentChannelOutboxQueue(dataSource as any),
      dispatched: () =>
        calls.filter((s) => /SET dispatched_at = now\(\)/.test(s)),
    };
  }
  const hr = row({ sourceType: 'HR_MESSAGE', controlVersion: null });

  it('tin HR quá TTL → INVALID HR_MESSAGE_EXPIRED, không ghi dispatched_at', async () => {
    const db = hrDb(true);
    await expect(
      db.queue.dispatch(hr, 'o1', false, null, null, null, 60),
    ).resolves.toEqual({ outcome: 'INVALID', code: 'HR_MESSAGE_EXPIRED' });
    expect(db.dispatched()).toHaveLength(0);
  });

  it('không đọc được tuổi tin (dòng mất) → fail closed như quá hạn', async () => {
    const db = hrDb(null);
    await expect(
      db.queue.dispatch(hr, 'o1', false, null, null, null, 60),
    ).resolves.toEqual({ outcome: 'INVALID', code: 'HR_MESSAGE_EXPIRED' });
  });

  it('tin HR còn hạn → DISPATCHED; tin AI không bị kiểm TTL tin HR', async () => {
    const db = hrDb(false);
    await expect(
      db.queue.dispatch(hr, 'o1', false, null, null, null, 60),
    ).resolves.toEqual({ outcome: 'DISPATCHED' });
    expect(db.dispatched()).toHaveLength(1);
  });
});
