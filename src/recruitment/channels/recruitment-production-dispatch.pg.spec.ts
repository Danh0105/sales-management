/**
 * Production dispatch (G8 go-live) trên PostgreSQL THẬT — quota ledger, GO PROD, múi giờ,
 * advisory lock + concurrency, restart/crash, retry, TTL tin HR, huỷ tin HR, approval expiry,
 * rollback transaction. Không gọi Zalo (chỉ cửa kiểm + ghi kết quả).
 *
 * Chỉ chạy khi có `G8_PROD_PG_URL` (superuser — đóng vai Owner: seed, uỷ quyền) và
 * `G8_PROD_APP_URL` (role `sales_app`, đúng quyền ứng dụng production) trỏ vào một DB TẠM có
 * schema production (pg_dump -s) + `g8-production-outbound-ledger-up.sql` +
 * `g8-production-go-prod-up.sql`. Dữ liệu recruitment của DB đó bị TRUNCATE.
 */
import { DataSource, type EntityManager } from 'typeorm';

import type { RecruitmentAuditService } from '../recruitment-audit.service';
import { RecruitmentActorType } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import {
  RecruitmentChannelOutboxQueue,
  type ClaimedOutbox,
} from './recruitment-channel-outbox.queue';
import { RecruitmentHrAlertService } from './recruitment-hr-alert.service';
import { RecruitmentOutboxApprovalExpiryService } from './recruitment-outbox-approval-expiry.service';
import { RecruitmentOutboxOperationsService } from './recruitment-outbox-operations.service';
import type { RecruitmentOutboundSafetyConfig } from './recruitment-outbound-safety.config';

const OWNER_URL = process.env.G8_PROD_PG_URL;
const APP_URL = process.env.G8_PROD_APP_URL;
const suite = OWNER_URL && APP_URL ? describe : describe.skip;

const OA = '1705071610099849262';
const A = '8812000000000000001';
const B = '8812000000000000002';
const LEASE = 60_000;
const HR: RecruitmentActor = {
  type: RecruitmentActorType.HR,
  employeeId: 158,
  name: 'HR trực ca',
  roles: ['HR'],
};
/** Env production (trần cao hơn uỷ quyền — uỷ quyền của Owner phải thắng). */
const ENV: RecruitmentOutboundSafetyConfig = {
  productionMode: true,
  interactionWindowHours: 168,
  freeWindowHours: 48,
  maxRequestsPerRecipientDay: 50,
  maxRequestsPerDay: 1000,
  dailyCostBudgetVnd: 0,
  monthlyCostBudgetVnd: 0,
  estimatedPaidMessageCostVnd: 500,
};

function source(url: string) {
  const u = new URL(url);
  return new DataSource({
    type: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    poolSize: 6,
  });
}

/** Audit thật vào activity_log, trong transaction của nơi gọi (đúng hợp đồng recordMandatory). */
function auditInto(ds: () => DataSource) {
  const write = (em: { query: EntityManager['query'] }, p: any) =>
    em.query(
      `INSERT INTO activity_log ("actorId", "actorName", method, path, resource, context)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        p.actor.employeeId ?? -1,
        p.actor.name,
        p.action,
        `/recruitment-${p.entity}/${p.entityId}`,
        `recruitment-${p.entity}`,
        JSON.stringify(p.context ?? {}),
      ],
    );
  return {
    recordMandatory: (em: EntityManager, p: any) => write(em, p),
    record: (p: any) => write(ds(), p),
  } as unknown as RecruitmentAuditService;
}

suite('production dispatch — PostgreSQL thật (G8 go-live)', () => {
  let owner: DataSource;
  let app: DataSource;
  let app2: DataSource;
  let queue: RecruitmentChannelOutboxQueue;
  let queue2: RecruitmentChannelOutboxQueue;

  beforeAll(async () => {
    owner = await source(OWNER_URL!).initialize();
    app = await source(APP_URL!).initialize();
    app2 = await source(APP_URL!).initialize();
    queue = new RecruitmentChannelOutboxQueue(app);
    queue2 = new RecruitmentChannelOutboxQueue(app2);
  });
  afterAll(async () => {
    await Promise.all([owner, app, app2].map((d) => d?.destroy()));
  });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "recruitment_production_authorizations", "recruitment_outbound_attempts",
      "recruitment_outbound_dispatch_grants", "recruitment_outbox_approvals", "recruitment_outbox_approval_events",
      "recruitment_hr_alerts", "recruitment_channel_outbox", "recruitment_channel_events", "recruitment_messages",
      "recruitment_conversations", "recruitment_candidates" RESTART IDENTITY CASCADE`);
    await owner.query(
      `DELETE FROM activity_log WHERE resource LIKE 'recruitment-%'`,
    );
    await owner.query(`DELETE FROM "recruitment_runtime_controls"`);
    await owner.query(`INSERT INTO "recruitment_runtime_controls" (id, ai_halted, worker_halted, outbound_halted, failsafe_halted)
      VALUES (1, false, false, false, false)`);
  });

  /** Uỷ quyền GO PROD do Owner (superuser) tạo — ngày đầu: 3/ứng viên, 20/ngày, ngân sách 0, 48 giờ. */
  async function authorize(patch: Record<string, number> = {}) {
    const l = { rd: 3, d: 20, iw: 48, fw: 48, ...patch };
    const [row] = await owner.query(
      `INSERT INTO "recruitment_production_authorizations" (go_code_fp, channel_account_id,
         max_requests_per_recipient_day, max_requests_per_day, daily_cost_budget_vnd, monthly_cost_budget_vnd,
         interaction_window_hours, free_window_hours, release_dist_hash, approved_by, approved_at)
       VALUES (md5(random()::text) || md5(random()::text), $1, $2, $3, 0, 0, $4, $5, 'test', 'Owner test', now())
       RETURNING id`,
      [OA, l.rd, l.d, l.iw, l.fw],
    );
    return Number(row.id);
  }

  async function conversation(
    recipient: string,
    interactionHoursAgo: number | null = 1,
  ) {
    const [cand] = await owner.query(
      `INSERT INTO "recruitment_candidates" (zalo_oa_id, zalo_user_id, source) VALUES ($1, $2, 'ZALO') RETURNING id`,
      [OA, recipient],
    );
    const [conv] = await owner.query(
      `INSERT INTO "recruitment_conversations" (candidate_id, channel, external_conversation_id, control_mode, control_version)
       VALUES ($1, 'ZALO', $2, 'AI_ACTIVE', 3) RETURNING id`,
      [cand.id, `${OA}:${recipient}`],
    );
    if (interactionHoursAgo !== null) {
      await owner.query(
        `INSERT INTO "recruitment_channel_events" (channel, channel_account_id, dedupe_key, event_type,
           external_sender_id, status, payload_hash, provider_created_at, received_at)
         VALUES ('ZALO', $1, md5(random()::text), 'user_send_text', $2, 'PROCESSED', md5(random()::text),
                 now() - $3 * interval '1 hour', now() - $3 * interval '1 hour')`,
        [OA, recipient, interactionHoursAgo],
      );
    }
    return Number(conv.id);
  }

  async function hrMessage(conv: number, recipient: string, minutesAgo = 0) {
    const [msg] = await owner.query(
      `INSERT INTO "recruitment_messages" (conversation_id, sender_type, direction, content, author_employee_id)
       VALUES ($1, 'HR', 'OUTBOUND', 'Chào bạn, mình là HR ICHI SKILL.', 158) RETURNING id`,
      [conv],
    );
    const [out] = await owner.query(
      `INSERT INTO "recruitment_channel_outbox" (channel, channel_account_id, external_recipient_id, message_text,
         recruitment_message_id, status, source_type, created_at)
       VALUES ('ZALO', $1, $2, 'Chào bạn, mình là HR ICHI SKILL.', $3, 'PENDING', 'HR_MESSAGE',
               clock_timestamp() - $4 * interval '1 minute') RETURNING id`,
      [OA, recipient, msg.id, minutesAgo],
    );
    return Number(out.id);
  }

  async function claim(q = queue, production = true) {
    const owner_ = `sender-test:${Math.random().toString(16).slice(2, 10)}`;
    const row = await q.claimNext(OA, owner_, LEASE, null, production);
    return row ? { row, owner: owner_ } : null;
  }

  const dispatch = (c: { row: ClaimedOutbox; owner: string }, q = queue) =>
    q.dispatch(c.row, c.owner, false, null, null, ENV, 60);

  async function sendOne(recipient: string, conv: number) {
    await hrMessage(conv, recipient);
    const c = (await claim())!;
    const gate = await dispatch(c);
    if (gate.outcome === 'DISPATCHED')
      await queue.markSent(c.row.id, c.owner, 'z-' + c.row.id);
    else if (gate.outcome === 'INVALID')
      await queue.markDeadLetter(c.row.id, c.owner, gate.code);
    return gate;
  }

  const ledger = () =>
    owner.query(
      `SELECT outbox_id, request_no, outcome, result_code, estimated_cost_vnd FROM "recruitment_outbound_attempts" ORDER BY id`,
    );

  it('không có uỷ quyền GO PROD → không claim; có uỷ quyền → dispatch ghi ledger DISPATCHING trước mạng, SENT ghi cả hai', async () => {
    const conv = await conversation(A);
    const id = await hrMessage(conv, A);
    expect(await claim()).toBeNull();
    await authorize();
    const c = (await claim())!;
    expect(c.row.id).toBe(id);
    await expect(dispatch(c)).resolves.toEqual({ outcome: 'DISPATCHED' });
    expect(await ledger()).toEqual([
      {
        outbox_id: id,
        request_no: 1,
        outcome: 'DISPATCHING',
        result_code: null,
        estimated_cost_vnd: 0,
      },
    ]);
    await expect(queue.markSent(id, c.owner, 'z-1')).resolves.toBe(true);
    expect((await ledger())[0].outcome).toBe('SENT');
    const [o] = await owner.query(
      `SELECT status, provider_message_id, message_text FROM "recruitment_channel_outbox" WHERE id = $1`,
      [id],
    );
    expect(o).toEqual({
      status: 'SENT',
      provider_message_id: 'z-1',
      message_text: null,
    });
  });

  it('uỷ quyền bị thu hồi → dispatch HELD PRODUCTION_NOT_AUTHORIZED, không ledger; claim sau đó trả null', async () => {
    const conv = await conversation(A);
    await hrMessage(conv, A);
    await authorize();
    const c = (await claim())!;
    await owner.query(`UPDATE "recruitment_production_authorizations" SET status = 'REVOKED', ended_at = now(),
      ended_by = 'Owner test', end_reason = 'kiểm thử thu hồi' WHERE status = 'ACTIVE'`);
    await expect(dispatch(c)).resolves.toEqual({
      outcome: 'HELD',
      code: 'PRODUCTION_NOT_AUTHORIZED',
    });
    expect(await ledger()).toEqual([]);
    const [o] = await owner.query(
      `SELECT status, dispatched_at FROM "recruitment_channel_outbox"`,
    );
    expect(o).toEqual({ status: 'PENDING', dispatched_at: null });
    expect(await claim()).toBeNull();
  });

  it('thu hồi uỷ quyền (kể cả SQL tay) chờ dispatch đang giữ khoá chia sẻ commit — không có khe gửi sau thu hồi', async () => {
    await authorize();
    const inflight = app2.createQueryRunner();
    await inflight.connect();
    await inflight.startTransaction();
    try {
      await inflight.query(
        `SELECT pg_advisory_xact_lock_shared(hashtext('recruitment_production_authorizations'))`,
      );
      let revoked = false;
      const revoke = owner
        .query(
          `UPDATE "recruitment_production_authorizations" SET status = 'REVOKED', ended_at = now(),
          ended_by = 'Owner test', end_reason = 'thu hồi khi đang dispatch' WHERE status = 'ACTIVE'`,
        )
        .then(() => (revoked = true));
      await new Promise((r) => setTimeout(r, 400));
      expect(revoked).toBe(false);
      await inflight.commitTransaction();
      await revoke;
      expect(revoked).toBe(true);
    } finally {
      if (inflight.isTransactionActive) await inflight.rollbackTransaction();
      await inflight.release();
    }
  });

  it('quota ứng viên/ngày = 3 (uỷ quyền thắng env 50): tin thứ 4 → INVALID + DEAD_LETTER, không ledger', async () => {
    await authorize();
    const conv = await conversation(A);
    for (let i = 0; i < 3; i++) {
      await expect(sendOne(A, conv)).resolves.toEqual({
        outcome: 'DISPATCHED',
      });
    }
    await expect(sendOne(A, conv)).resolves.toEqual({
      outcome: 'INVALID',
      code: 'OUTBOUND_RECIPIENT_DAILY_LIMIT',
    });
    expect(await ledger()).toHaveLength(3);
    const statuses = await owner.query(
      `SELECT status, last_error_code FROM "recruitment_channel_outbox" ORDER BY id`,
    );
    expect(statuses.at(-1)).toEqual({
      status: 'DEAD_LETTER',
      last_error_code: 'OUTBOUND_RECIPIENT_DAILY_LIMIT',
    });
    // người khác vẫn gửi được
    await expect(sendOne(B, await conversation(B))).resolves.toEqual({
      outcome: 'DISPATCHED',
    });
  });

  it('múi giờ: request trước 00:00 giờ Việt Nam không tính vào hôm nay; sau 00:00 thì tính', async () => {
    await authorize();
    const conv = await conversation(A);
    const [{ day_start }] = await owner.query(
      `SELECT date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS day_start`,
    );
    const backfill = async (at: string, n: number) => {
      const out = await hrMessage(conv, A);
      await owner.query(
        `ALTER TABLE "recruitment_outbound_attempts" DISABLE TRIGGER "TRG_outbound_attempt_guard"`,
      );
      for (let i = 1; i <= n; i++) {
        await owner.query(
          `INSERT INTO "recruitment_outbound_attempts" (outbox_id, request_no, lease_owner, source_type, channel_account_id,
             recipient_fingerprint, interaction_at, outcome, started_at, completed_at)
           VALUES ($1, $2, 'old', 'HR_MESSAGE', $3::varchar,
                   left(encode(sha256(convert_to($3::text || ':' || $4::text, 'UTF8')), 'hex'), 16),
                   now(), 'SENT', $5::timestamptz, $5::timestamptz)`,
          [out, i, OA, A, at],
        );
      }
      await owner.query(
        `ALTER TABLE "recruitment_outbound_attempts" ENABLE TRIGGER "TRG_outbound_attempt_guard"`,
      );
      await owner.query(
        `UPDATE "recruitment_channel_outbox" SET status = 'SENT', message_text = NULL WHERE id = $1`,
        [out],
      );
    };
    // 3 request lúc 23:59 hôm qua (giờ VN) — UTC đã là "hôm nay" nếu tính sai múi giờ
    await backfill(
      new Date(new Date(day_start).getTime() - 60_000).toISOString(),
      3,
    );
    await expect(sendOne(A, conv)).resolves.toEqual({ outcome: 'DISPATCHED' });
    // 2 request lúc 00:01 hôm nay → cộng 1 vừa gửi = 3 → tin tiếp bị chặn
    await backfill(
      new Date(new Date(day_start).getTime() + 60_000).toISOString(),
      2,
    );
    await expect(sendOne(A, conv)).resolves.toEqual({
      outcome: 'INVALID',
      code: 'OUTBOUND_RECIPIENT_DAILY_LIMIT',
    });
  });

  it('concurrency: hai sender cùng lúc, còn đúng 1 suất toàn hệ thống → đúng 1 DISPATCHED (advisory lock)', async () => {
    await authorize({ rd: 1, d: 1 });
    await hrMessage(await conversation(A), A);
    await hrMessage(await conversation(B), B);
    const c1 = (await claim(queue))!;
    const c2 = (await claim(queue2))!;
    expect(c1.row.id).not.toBe(c2.row.id);
    const gates = await Promise.all([
      dispatch(c1, queue),
      dispatch(c2, queue2),
    ]);
    expect(gates.filter((g) => g.outcome === 'DISPATCHED')).toHaveLength(1);
    expect(gates.filter((g) => g.outcome === 'INVALID')).toEqual([
      { outcome: 'INVALID', code: 'OUTBOUND_DAILY_LIMIT' },
    ]);
    expect(await ledger()).toHaveLength(1);
  });

  it('restart: quota đọc lại từ ledger bền ở kết nối/process mới — không tự reset', async () => {
    await authorize({ rd: 1, d: 20 });
    const conv = await conversation(A);
    await expect(sendOne(A, conv)).resolves.toEqual({ outcome: 'DISPATCHED' });
    const fresh = await source(APP_URL!).initialize();
    try {
      const q = new RecruitmentChannelOutboxQueue(fresh);
      await hrMessage(conv, A);
      const c = (await claim(q))!;
      await expect(
        q.dispatch(c.row, c.owner, false, null, null, ENV, 60),
      ).resolves.toEqual({
        outcome: 'INVALID',
        code: 'OUTBOUND_RECIPIENT_DAILY_LIMIT',
      });
    } finally {
      await fresh.destroy();
    }
  });

  it('crash sau dispatch: lease hết hạn → UNKNOWN (ledger UNKNOWN), không claim lại, vẫn tính quota', async () => {
    await authorize({ rd: 1 });
    const conv = await conversation(A);
    const id = await hrMessage(conv, A);
    const c = (await claim())!;
    await expect(dispatch(c)).resolves.toEqual({ outcome: 'DISPATCHED' });
    // process chết: không ghi kết quả, lease hết hạn
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    await expect(queue.recoverDispatched(OA)).resolves.toEqual([id]);
    expect((await ledger())[0]).toMatchObject({
      outcome: 'UNKNOWN',
      result_code: 'LEASE_EXPIRED_AFTER_DISPATCH',
    });
    expect(await claim()).toBeNull();
    await hrMessage(await conversation(B), B);
    await hrMessage(conv, A); // A vẫn chặn sau dòng UNKNOWN (đầu hàng) + quota A đã dùng
    const next = (await claim())!;
    expect(next.row.externalRecipientId).toBe(B);
  });

  it('retry: RETRY ghi ledger RETRY; lần claim sau tạo request_no 2 (tính quota từng request)', async () => {
    await authorize();
    const id = await hrMessage(await conversation(A), A);
    const c = (await claim())!;
    await dispatch(c);
    await expect(queue.markRetry(id, c.owner, 'PROVIDER_5XX', 0)).resolves.toBe(
      true,
    );
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const again = (await claim())!;
    expect(again.row.id).toBe(id);
    await expect(dispatch(again)).resolves.toEqual({ outcome: 'DISPATCHED' });
    expect((await ledger()).map((r: any) => [r.request_no, r.outcome])).toEqual(
      [
        [1, 'RETRY'],
        [2, 'DISPATCHING'],
      ],
    );
  });

  it('tương tác Zalo: không có tin user_send_text → INVALID; tương tác 49 giờ trước (cửa sổ 48h, ngân sách 0) → INVALID', async () => {
    await authorize();
    await hrMessage(await conversation(A, null), A);
    const c = (await claim())!;
    await expect(dispatch(c)).resolves.toEqual({
      outcome: 'INVALID',
      code: 'ZALO_INTERACTION_MISSING',
    });
    await queue.markDeadLetter(c.row.id, c.owner, 'ZALO_INTERACTION_MISSING');
    await hrMessage(await conversation(B, 49), B);
    const d = (await claim())!;
    await expect(dispatch(d)).resolves.toEqual({
      outcome: 'INVALID',
      code: 'ZALO_INTERACTION_EXPIRED',
    });
    expect(await ledger()).toEqual([]);
  });

  it('rollback: ghi ledger lỗi → cả dispatched_at rollback, không DISPATCHED (không mở mạng)', async () => {
    await authorize();
    const id = await hrMessage(await conversation(A), A);
    const c = (await claim())!;
    await owner.query(
      `REVOKE INSERT ON "recruitment_outbound_attempts" FROM sales_app`,
    );
    try {
      await expect(dispatch(c)).rejects.toThrow(/permission denied/);
    } finally {
      await owner.query(
        `GRANT INSERT ON "recruitment_outbound_attempts" TO sales_app`,
      );
    }
    const [o] = await owner.query(
      `SELECT status, dispatched_at FROM "recruitment_channel_outbox" WHERE id = $1`,
      [id],
    );
    expect(o).toEqual({ status: 'SENDING', dispatched_at: null });
    expect(await ledger()).toEqual([]);
  });

  it('ledger bất biến với sales_app: không xoá, không sửa thời điểm, kết quả ghi một lần', async () => {
    await authorize();
    const conv = await conversation(A);
    await sendOne(A, conv);
    await expect(
      app.query(`DELETE FROM "recruitment_outbound_attempts"`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(
        `UPDATE "recruitment_outbound_attempts" SET started_at = now() - interval '2 days'`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(
        `UPDATE "recruitment_outbound_attempts" SET outcome = 'RETRY', completed_at = now()`,
      ),
    ).rejects.toThrow(/bất biến/);
    await expect(
      app.query(
        `INSERT INTO "recruitment_production_authorizations" (go_code_fp) VALUES (repeat('a', 64))`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('TTL tin HR: quá 60 phút → lượt dọn chuyển DEAD_LETTER + audit + cảnh báo cùng transaction; cửa dispatch cũng chặn', async () => {
    await authorize();
    const conv = await conversation(A);
    const stale = await hrMessage(conv, A, 61);
    const audit = auditInto(() => app);
    const alerts = new RecruitmentHrAlertService(app, audit);
    const expiry = new RecruitmentOutboxApprovalExpiryService(
      app,
      audit,
      undefined,
      alerts,
    );
    // cửa dispatch chặn trước khi lượt dọn kịp chạy
    const c = (await claim())!;
    await expect(dispatch(c)).resolves.toEqual({
      outcome: 'INVALID',
      code: 'HR_MESSAGE_EXPIRED',
    });
    await queue.markDeadLetter(c.row.id, c.owner, 'HR_MESSAGE_EXPIRED');
    // lượt dọn: tin RETRY quá hạn khác
    const retry = await hrMessage(conv, A, 90);
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET status = 'RETRY', next_attempt_at = now() + interval '1 hour' WHERE id = $1`,
      [retry],
    );
    const fresh = await hrMessage(conv, A, 5);
    await expect(expiry.expireHrMessages(60)).resolves.toEqual({
      examined: 1,
      expired: 1,
    });
    const rows = await owner.query(
      `SELECT id, status, last_error_code FROM "recruitment_channel_outbox" ORDER BY id`,
    );
    expect(rows).toEqual([
      {
        id: stale,
        status: 'DEAD_LETTER',
        last_error_code: 'HR_MESSAGE_EXPIRED',
      },
      {
        id: retry,
        status: 'DEAD_LETTER',
        last_error_code: 'HR_MESSAGE_EXPIRED',
      },
      { id: fresh, status: 'PENDING', last_error_code: null },
    ]);
    const [a] = await owner.query(
      `SELECT count(*)::int AS n FROM activity_log WHERE method = 'CHANNEL_OUTBOX_HR_MESSAGE_EXPIRED'`,
    );
    expect(a.n).toBe(1);
    const [al] = await owner.query(
      `SELECT type, source_key FROM "recruitment_hr_alerts" WHERE outbox_id = $1`,
      [retry],
    );
    expect(al).toEqual({
      type: 'OUTBOUND_DEAD_LETTER',
      source_key: `outbox:${retry}`,
    });
    expect(await ledger()).toEqual([]);
  });

  it('huỷ tin HR: PENDING → DEAD_LETTER HR_CANCELLED có audit; tin đang gửi/đã gửi không huỷ được; tranh chấp với sender an toàn', async () => {
    await authorize();
    const conv = await conversation(A);
    const audit = auditInto(() => app);
    const ops = new RecruitmentOutboxOperationsService(
      app,
      audit,
      new RecruitmentHrAlertService(app, audit),
    );
    const id = await hrMessage(conv, A);
    await expect(
      ops.cancelHrMessage(id, 'Tin thử nghiệm nội bộ, không còn cần gửi', HR),
    ).resolves.toMatchObject({
      status: 'DEAD_LETTER',
      code: 'HR_CANCELLED',
    });
    const [audited] = await owner.query(
      `SELECT "actorId", context->>'reason' AS reason FROM activity_log WHERE method = 'OUTBOX_HR_CANCEL'`,
    );
    expect(audited).toEqual({
      actorId: 158,
      reason: 'Tin thử nghiệm nội bộ, không còn cần gửi',
    });
    expect(await claim()).toBeNull();
    // đang SENDING (đã claim) → 409
    const busy = await hrMessage(conv, A);
    const c = (await claim())!;
    expect(c.row.id).toBe(busy);
    await expect(
      ops.cancelHrMessage(busy, 'Thử huỷ tin đang gửi đi', HR),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OUTBOX_NOT_CANCELLABLE' }),
    });
    await dispatch(c);
    await queue.markSent(busy, c.owner, 'z-9');
    await expect(
      ops.cancelHrMessage(busy, 'Thử huỷ tin đã gửi xong', HR),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OUTBOX_NOT_CANCELLABLE' }),
    });
    // tranh chấp: huỷ và claim cùng lúc → hoặc huỷ thắng (không claim), hoặc claim thắng (huỷ 409)
    for (let i = 0; i < 5; i++) {
      const race = await hrMessage(conv, A);
      const [cancel, claimed] = await Promise.allSettled([
        ops.cancelHrMessage(race, 'Huỷ trong lúc sender đang claim', HR),
        claim(queue2),
      ]);
      const [o] = await owner.query(
        `SELECT status FROM "recruitment_channel_outbox" WHERE id = $1`,
        [race],
      );
      const won =
        claimed.status === 'fulfilled' && claimed.value?.row.id === race;
      if (won) {
        expect(cancel.status).toBe('rejected');
        expect(o.status).toBe('SENDING');
        await owner.query(
          `UPDATE "recruitment_channel_outbox" SET status = 'DEAD_LETTER', lease_until = NULL WHERE id = $1`,
          [race],
        );
      } else {
        expect(cancel.status).toBe('fulfilled');
        expect(o.status).toBe('DEAD_LETTER');
      }
    }
  });

  it('approval expiry (tin AI) vẫn chạy với sales_app: bản duyệt quá hạn → SUPPRESSED + audit', async () => {
    const conv = await conversation(A);
    const [msg] = await owner.query(
      `INSERT INTO "recruitment_messages" (conversation_id, sender_type, direction, content) VALUES ($1, 'AI', 'OUTBOUND', 'Trả lời AI') RETURNING id`,
      [conv],
    );
    const [ev] = await owner.query(
      `SELECT id FROM "recruitment_channel_events" LIMIT 1`,
    );
    const [out] = await owner.query(
      `INSERT INTO "recruitment_channel_outbox" (source_event_id, channel, channel_account_id, external_recipient_id, message_text,
         recruitment_message_id, status, source_type, control_version)
       VALUES ($1, 'ZALO', $2, $3, 'Trả lời AI', $4, 'PENDING', 'AI_REPLY', 3) RETURNING id`,
      [ev.id, OA, A, msg.id],
    );
    await owner.query(
      `INSERT INTO "recruitment_outbox_approvals" (outbox_id, state, version, approved_by, approved_at, expires_at,
         approved_text_sha256, approved_oa_id, approved_recipient_id, approved_control_version, approved_message_id)
       VALUES ($1, 'APPROVED', 1, 158, now() - interval '40 minutes', now() - interval '10 minutes',
               encode(sha256(convert_to('Trả lời AI', 'UTF8')), 'hex'), $2, $3, 3, $4)`,
      [out.id, OA, A, msg.id],
    );
    const audit = auditInto(() => app);
    const expiry = new RecruitmentOutboxApprovalExpiryService(app, audit);
    await expect(expiry.expireBatch(60)).resolves.toEqual({
      examined: 1,
      expired: 1,
    });
    const [o] = await owner.query(
      `SELECT status, last_error_code FROM "recruitment_channel_outbox" WHERE id = $1`,
      [out.id],
    );
    expect(o).toEqual({
      status: 'SUPPRESSED',
      last_error_code: 'APPROVED_REPLY_EXPIRED',
    });
  });
});
