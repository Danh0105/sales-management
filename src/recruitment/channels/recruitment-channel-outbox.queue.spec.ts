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
  runtime: { outbound_halted: boolean } | null = { outbound_halted: false },
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
    ['outbound đang dừng khẩn', { outbound_halted: true }],
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
      { outbound_halted: true },
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
