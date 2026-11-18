/**
 * Single dispatch guard (G8 C2) trên PostgreSQL THẬT — khoá, transaction, quyền DB.
 *
 * Chỉ chạy khi có `G8_GUARD_PG_URL` (superuser, đóng vai Owner: seed + cấp grant) và
 * `G8_GUARD_APP_URL` (role `sales_app`, đúng quyền ứng dụng production) trỏ vào một DB
 * thử đã có schema tuyển dụng + `g8-dispatch-guard-up.sql`. Không gọi Zalo.
 */
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';

import { pilotFingerprint } from './recruitment-ai-safety.config';
import {
  RecruitmentChannelOutboxQueue,
  type ClaimedOutbox,
  type DispatchGuard,
} from './recruitment-channel-outbox.queue';

const OWNER_URL = process.env.G8_GUARD_PG_URL;
const APP_URL = process.env.G8_GUARD_APP_URL;
const suite = OWNER_URL && APP_URL ? describe : describe.skip;

const OA = '1705071610099849262';
const PILOT = '8812000000000000001';
const OTHER = '8812000000000000002';
const TEXT = 'Chào bạn, mình là trợ lý tuyển dụng của ICHI SKILL.';
/** Mỗi grant một mã GO C2S riêng (UQ_dispatch_grant_go; trigger chỉ nhận G8-C2S-…). */
let goSeq = 0;
const nextGo = () =>
  `G8-C2S-20261018-090000-${(goSeq++ % 0xffff).toString(16).padStart(4, '0')}`;
const LEASE = 60_000;
const guard: DispatchGuard = { oaId: OA };
const pilots = [pilotFingerprint(OA, PILOT)];
const sha = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** Tách URL để lớp bảo vệ test (`test/setup/production-db-guard.ts`) thấy đúng tên DB. */
function source(url: string) {
  const u = new URL(url);
  return new DataSource({
    type: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    poolSize: 4,
  });
}

suite('single dispatch guard — PostgreSQL thật (G8 C2)', () => {
  let owner: DataSource;
  let app: DataSource;
  let app2: DataSource;

  beforeAll(async () => {
    owner = await source(OWNER_URL!).initialize();
    app = await source(APP_URL!).initialize();
    app2 = await source(APP_URL!).initialize();
  });
  afterAll(async () => {
    await Promise.all([owner, app, app2].map((d) => d?.destroy()));
  });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "recruitment_outbound_dispatch_grants", "recruitment_outbox_approvals",
      "recruitment_channel_outbox", "recruitment_channel_events", "recruitment_messages",
      "recruitment_conversations", "recruitment_candidates" RESTART IDENTITY CASCADE`);
    await owner.query(`DELETE FROM "recruitment_runtime_controls"`);
    await owner.query(`INSERT INTO "recruitment_runtime_controls" (id, ai_halted, worker_halted, outbound_halted, failsafe_halted)
      VALUES (1, false, false, false, false)`);
  });

  /** Hội thoại ZALO của người nhận (một lần cho mỗi người nhận). */
  async function conversation(
    recipient = PILOT,
    mode = 'AI_ACTIVE',
    version = 3,
  ) {
    const [cand] = await owner.query(
      `INSERT INTO "recruitment_candidates" (zalo_oa_id, zalo_user_id, source) VALUES ($1, $2, 'ZALO') RETURNING id`,
      [OA, recipient],
    );
    const [conv] = await owner.query(
      `INSERT INTO "recruitment_conversations" (candidate_id, channel, external_conversation_id, control_mode, control_version)
       VALUES ($1, 'ZALO', $2, $3, $4) RETURNING id`,
      [cand.id, `${OA}:${recipient}`, mode, version],
    );
    return Number(conv.id);
  }

  /** Tin AI đã được HR duyệt (PENDING + approval APPROVED còn hạn). */
  async function aiReply(
    conv: number,
    opts: {
      recipient?: string;
      text?: string;
      version?: number;
      approvalMinutes?: number;
    } = {},
  ) {
    const recipient = opts.recipient ?? PILOT;
    const text = opts.text ?? TEXT;
    const version = opts.version ?? 3;
    const [msg] = await owner.query(
      `INSERT INTO "recruitment_messages" (conversation_id, sender_type, direction, content)
       VALUES ($1, 'AI', 'OUTBOUND', $2) RETURNING id`,
      [conv, text],
    );
    // Tin AI luôn có event nguồn (CHK_recruitment_channel_outbox_source).
    const [event] = await owner.query(
      `INSERT INTO "recruitment_channel_events" (channel, channel_account_id, dedupe_key, event_type,
         external_sender_id, status, payload_hash)
       VALUES ('ZALO', $1, md5(random()::text), 'user_send_text', $2, 'PROCESSED', md5(random()::text)) RETURNING id`,
      [OA, recipient],
    );
    const [out] = await owner.query(
      `INSERT INTO "recruitment_channel_outbox" (source_event_id, channel, channel_account_id, external_recipient_id,
         message_text, recruitment_message_id, status, source_type, control_version, created_at)
       VALUES ($6, 'ZALO', $1, $2, $3, $4, 'PENDING', 'AI_REPLY', $5, clock_timestamp()) RETURNING id`,
      [OA, recipient, text, msg.id, version, event.id],
    );
    await owner.query(
      `INSERT INTO "recruitment_outbox_approvals" (outbox_id, state, version, approved_by, approved_at, expires_at,
         approved_text_sha256, approved_oa_id, approved_recipient_id, approved_control_version, approved_message_id)
       VALUES ($1, 'APPROVED', 1, 158, now() + ($2::int - 30) * interval '1 minute',
               now() + $2::int * interval '1 minute', $3, $4, $5, $6, $7)`,
      [
        out.id,
        opts.approvalMinutes ?? 30,
        sha(text),
        OA,
        recipient,
        version,
        msg.id,
      ],
    );
    return Number(out.id);
  }

  async function hrMessage(
    conv: number,
    recipient = PILOT,
    text = 'Tin HR viết tay',
  ) {
    const [msg] = await owner.query(
      `INSERT INTO "recruitment_messages" (conversation_id, sender_type, direction, content, author_employee_id)
       VALUES ($1, 'HR', 'OUTBOUND', $2, 158) RETURNING id`,
      [conv, text],
    );
    const [out] = await owner.query(
      `INSERT INTO "recruitment_channel_outbox" (channel, channel_account_id, external_recipient_id, message_text,
         recruitment_message_id, status, source_type, created_at)
       VALUES ('ZALO', $1, $2, $3, $4, 'PENDING', 'HR_MESSAGE', clock_timestamp()) RETURNING id`,
      [OA, recipient, text, msg.id],
    );
    return Number(out.id);
  }

  /** Owner cấp grant (superuser, như `g8-owner-go.py grant-dispatch`). */
  async function grant(
    outboxId: number,
    patch: Partial<{
      oa: string;
      recipient: string;
      text: string;
      version: number;
      minutes: number;
    }> = {},
  ) {
    const [row] = await owner.query(
      `INSERT INTO "recruitment_outbound_dispatch_grants" (go_code, outbox_id, channel_account_id,
         recipient_fingerprint, approved_text_sha256, approved_control_version, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'SYSTEM OWNER test', now() + $7::int * interval '1 minute') RETURNING id`,
      [
        nextGo(),
        outboxId,
        patch.oa ?? OA,
        pilotFingerprint(patch.oa ?? OA, patch.recipient ?? PILOT),
        sha(patch.text ?? TEXT),
        patch.version ?? 3,
        patch.minutes ?? 30,
      ],
    );
    return Number(row.id);
  }

  const grantRow = async (id: number) =>
    (
      await owner.query(
        `SELECT * FROM "recruitment_outbound_dispatch_grants" WHERE id = $1`,
        [id],
      )
    )[0];
  const outboxRow = async (id: number) =>
    (
      await owner.query(
        `SELECT * FROM "recruitment_channel_outbox" WHERE id = $1`,
        [id],
      )
    )[0];

  /** Một vòng sender: claim (có guard) → cửa kiểm cuối. */
  async function attempt(queue: RecruitmentChannelOutboxQueue, lease: string) {
    const row = await queue.claimNext(OA, lease, LEASE, guard);
    if (!row)
      return {
        claimed: null as number | null,
        outcome: 'NONE' as string,
        code: undefined as string | undefined,
      };
    const gate = await queue.dispatch(row, lease, false, pilots, guard);
    return {
      claimed: row.id,
      outcome: gate.outcome,
      code: 'code' in gate ? gate.code : undefined,
    };
  }

  /** Đặt tay một dòng ở SENDING thuộc lease (bỏ qua bộ lọc claim) — kiểm cửa kiểm cuối độc lập. */
  async function forceClaim(id: number, lease: string): Promise<ClaimedOutbox> {
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET status = 'SENDING', lease_owner = $2,
         lease_until = now() + interval '1 minute', dispatched_at = NULL WHERE id = $1`,
      [id, lease],
    );
    const r = await outboxRow(id);
    return {
      id,
      channelAccountId: r.channel_account_id,
      externalRecipientId: r.external_recipient_id,
      messageText: r.message_text,
      recruitmentMessageId: r.recruitment_message_id,
      attemptCount: Number(r.attempt_count),
      sourceType: r.source_type,
      controlVersion:
        r.control_version === null ? null : Number(r.control_version),
    };
  }

  it('1. AI_REPLY hợp lệ dùng đúng một hạn mức, ghi bền trước khi mở kết nối', async () => {
    const id = await aiReply(await conversation());
    const g = await grant(id);
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await attempt(q, 'lease-A')).toMatchObject({
      claimed: id,
      outcome: 'DISPATCHED',
    });
    const gr = await grantRow(g);
    expect(gr).toMatchObject({
      status: 'CONSUMED',
      dispatches_used: 1,
      consumed_lease_owner: 'lease-A',
    });
    expect(gr.consumed_at).not.toBeNull();
    expect((await outboxRow(id)).dispatched_at).not.toBeNull();
    // Gửi không ra kết quả chắc chắn → RETRY; vòng sau không lấy lại được (hạn mức đã dùng).
    await q.markRetry(id, 'lease-A', 'ZALO_5XX', 0);
    expect(await attempt(q, 'lease-B')).toMatchObject({ claimed: null });
  });

  it('2. hai sender (hai pool kết nối) chạy đồng thời không vượt hạn mức', async () => {
    const conv = await conversation();
    const id = await aiReply(conv);
    await grant(id);
    const qa = new RecruitmentChannelOutboxQueue(app);
    const qb = new RecruitmentChannelOutboxQueue(app2);
    const results = [];
    for (let round = 0; round < 6; round++) {
      results.push(
        ...(await Promise.all([
          attempt(qa, `a-${round}`),
          attempt(qb, `b-${round}`),
          attempt(qa, `c-${round}`),
          attempt(qb, `d-${round}`),
        ])),
      );
      // Mô phỏng sender giải phóng dòng (RETRY ngay) để vòng sau tranh tiếp.
      await owner.query(
        `UPDATE "recruitment_channel_outbox" SET status = 'RETRY', next_attempt_at = now(), lease_until = NULL WHERE id = $1 AND status = 'SENDING'`,
        [id],
      );
    }
    expect(results.filter((r) => r.outcome === 'DISPATCHED')).toHaveLength(1);
    // Toàn hệ thống chỉ một grant ACTIVE: grant thứ hai được (grant đầu đã tiêu), thứ ba bị từ chối.
    const second = await aiReply(conv, { text: 'Tin thứ hai' });
    await grant(second, { text: 'Tin thứ hai' });
    const third = await aiReply(conv, { text: 'Tin thứ ba' });
    await expect(grant(third, { text: 'Tin thứ ba' })).rejects.toThrow(
      /UQ_dispatch_grant_one_active/,
    );
  });

  it('3. HR_MESSAGE không chiếm được hạn mức, không bao giờ dispatch khi guard bật', async () => {
    const conv = await conversation();
    // (a) tin HR mới hơn tin AI có grant: AI đi, HR đứng nguyên PENDING.
    const ai = await aiReply(conv);
    await grant(ai);
    const hr = await hrMessage(conv);
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await attempt(q, 'l1')).toMatchObject({
      claimed: ai,
      outcome: 'DISPATCHED',
    });
    await q.markSent(ai, 'l1', 'zmsg-1');
    for (let i = 0; i < 3; i++)
      expect(await attempt(q, `l${i + 2}`)).toMatchObject({ claimed: null });
    expect((await outboxRow(hr)).status).toBe('PENDING');
    // (b) grant gắn nhầm vào tin HR → cửa kiểm cuối giữ lại (DISPATCH_GRANT_SOURCE), không tiêu.
    // (Grant của tin AI đã CONSUMED nên không còn grant ACTIVE nào; trigger không cho xoá nó.)
    const g = await grant(hr, { text: 'Tin HR viết tay', version: 0 });
    expect(await attempt(q, 'l9')).toMatchObject({ claimed: null });
    const forced = await forceClaim(hr, 'force-hr');
    expect(await q.dispatch(forced, 'force-hr', false, pilots, guard)).toEqual({
      outcome: 'HELD',
      code: 'DISPATCH_GRANT_SOURCE',
    });
    expect(await grantRow(g)).toMatchObject({
      status: 'ACTIVE',
      dispatches_used: 0,
    });
  });

  it('3b. tin HR cũ hơn đứng đầu hàng → tin AI có grant cũng không đi (fail-closed), grant không bị tiêu', async () => {
    const conv = await conversation();
    await hrMessage(conv);
    const ai = await aiReply(conv);
    const g = await grant(ai);
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await attempt(q, 'l1')).toMatchObject({ claimed: null });
    expect(await grantRow(g)).toMatchObject({
      status: 'ACTIVE',
      dispatches_used: 0,
    });
  });

  it('4. restart (pool mới, instance mới) không hồi phục hạn mức đã dùng', async () => {
    const id = await aiReply(await conversation());
    const g = await grant(id);
    expect(
      await attempt(new RecruitmentChannelOutboxQueue(app), 'before'),
    ).toMatchObject({ outcome: 'DISPATCHED' });
    await app.destroy();
    app = await source(APP_URL!).initialize();
    // Như sau restart: dòng vẫn SENDING, lease hết hạn sau dispatch → UNKNOWN.
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await q.recoverDispatched(OA)).toEqual([id]);
    expect(await attempt(q, 'after')).toMatchObject({ claimed: null });
    expect(await grantRow(g)).toMatchObject({
      status: 'CONSUMED',
      dispatches_used: 1,
    });
  });

  it('5. crash sau khi ghi dispatch → UNKNOWN, kể cả "gửi lại" của vận hành cũng không dispatch lần hai', async () => {
    const id = await aiReply(await conversation());
    await grant(id);
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await attempt(q, 'crashing')).toMatchObject({
      outcome: 'DISPATCHED',
    });
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect(await q.recoverDispatched(OA)).toEqual([id]);
    expect((await outboxRow(id)).status).toBe('UNKNOWN');
    // Vận hành bấm "gửi lại" (RecruitmentOutboxOperationsService.retry): UNKNOWN → PENDING.
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET status = 'PENDING', dispatched_at = NULL WHERE id = $1`,
      [id],
    );
    expect(await attempt(q, 'after-retry')).toMatchObject({ claimed: null });
    const forced = await forceClaim(id, 'force');
    expect(await q.dispatch(forced, 'force', false, pilots, guard)).toEqual({
      outcome: 'HELD',
      code: 'DISPATCH_GRANT_NOT_ACTIVE',
    });
  });

  it('5b. crash TRƯỚC khi dispatch commit (lease hết hạn, chưa ghi dispatch) → lấy lại được, vẫn chỉ một dispatch', async () => {
    const id = await aiReply(await conversation());
    const g = await grant(id);
    const q = new RecruitmentChannelOutboxQueue(app);
    const row = await q.claimNext(OA, 'dies-before-dispatch', LEASE, guard);
    expect(row?.id).toBe(id);
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect(await grantRow(g)).toMatchObject({
      status: 'ACTIVE',
      dispatches_used: 0,
    });
    expect(await attempt(q, 'second')).toMatchObject({
      claimed: id,
      outcome: 'DISPATCHED',
    });
    // Sender cũ "sống lại" muộn: mất lease, không dispatch được.
    expect(
      await q.dispatch(row!, 'dies-before-dispatch', false, pilots, guard),
    ).toEqual({ outcome: 'LOST' });
    expect(await grantRow(g)).toMatchObject({
      status: 'CONSUMED',
      dispatches_used: 1,
      consumed_lease_owner: 'second',
    });
  });

  it('6. timeout / UNKNOWN không tự gửi lại', async () => {
    const id = await aiReply(await conversation());
    await grant(id);
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await attempt(q, 'l1')).toMatchObject({ outcome: 'DISPATCHED' });
    expect(await q.markUnknown(id, 'l1', 'RESPONSE_TIMEOUT')).toBe(true);
    for (let i = 0; i < 3; i++)
      expect(await attempt(q, `r${i}`)).toMatchObject({ claimed: null });
    expect((await outboxRow(id)).status).toBe('UNKNOWN');
  });

  it('6b. lần gửi lại sau khi Zalo từ chối token: chỉ đúng lease đã tiêu grant', async () => {
    const id = await aiReply(await conversation());
    const g = await grant(id);
    const q = new RecruitmentChannelOutboxQueue(app);
    const row = (await q.claimNext(OA, 'lease-T', LEASE, guard))!;
    expect(await q.dispatch(row, 'lease-T', false, pilots, guard)).toEqual({
      outcome: 'DISPATCHED',
    });
    expect(await q.dispatch(row, 'lease-T', true, pilots, guard)).toEqual({
      outcome: 'DISPATCHED',
    });
    expect(await grantRow(g)).toMatchObject({ dispatches_used: 1 });
    // Lease khác (sender khác / sau restart) không được "gửi lại" bằng grant đã tiêu bởi lease-T.
    const other = await forceClaim(id, 'lease-X');
    expect(await q.dispatch(other, 'lease-X', true, pilots, guard)).toEqual({
      outcome: 'HELD',
      code: 'DISPATCH_GRANT_REDISPATCH_DENIED',
    });
    expect(await grantRow(g)).toMatchObject({
      status: 'CONSUMED',
      dispatches_used: 1,
      consumed_lease_owner: 'lease-T',
    });
  });

  it('7. bản duyệt hết hạn / grant hết hạn bị chặn, hạn mức không bị tiêu', async () => {
    const conv = await conversation();
    const id = await aiReply(conv, { approvalMinutes: -1 });
    const g = await grant(id);
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await attempt(q, 'l1')).toMatchObject({ claimed: null });
    const forced = await forceClaim(id, 'force');
    expect(
      await q.dispatch(forced, 'force', false, pilots, guard),
    ).toMatchObject({ outcome: 'SUPPRESSED', code: 'APPROVAL_INVALID' });
    expect(await grantRow(g)).toMatchObject({
      status: 'ACTIVE',
      dispatches_used: 0,
    });

    await owner.query(
      `TRUNCATE "recruitment_outbound_dispatch_grants", "recruitment_outbox_approvals", "recruitment_channel_outbox", "recruitment_messages" RESTART IDENTITY CASCADE`,
    );
    const id2 = await aiReply(conv);
    await owner.query(
      `INSERT INTO "recruitment_outbound_dispatch_grants" (go_code, outbox_id, channel_account_id, recipient_fingerprint,
         approved_text_sha256, approved_control_version, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 3, 'SYSTEM OWNER test', now() - interval '40 minutes', now() - interval '10 minutes')`,
      [nextGo(), id2, OA, pilotFingerprint(OA, PILOT), sha(TEXT)],
    );
    expect(await attempt(q, 'l2')).toMatchObject({ claimed: null });
    const forced2 = await forceClaim(id2, 'force2');
    expect(await q.dispatch(forced2, 'force2', false, pilots, guard)).toEqual({
      outcome: 'HELD',
      code: 'DISPATCH_GRANT_EXPIRED',
    });
  });

  it('8. hội thoại bị HR tiếp quản → chặn, hạn mức không bị tiêu', async () => {
    const conv = await conversation();
    const id = await aiReply(conv);
    const g = await grant(id);
    await owner.query(
      `UPDATE "recruitment_conversations" SET control_mode = 'HUMAN_TAKEOVER', control_version = 4 WHERE id = $1`,
      [conv],
    );
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await attempt(q, 'l1')).toMatchObject({
      outcome: 'SUPPRESSED',
      code: 'CONTROL_HUMAN_TAKEOVER',
    });
    expect(await grantRow(g)).toMatchObject({
      status: 'ACTIVE',
      dispatches_used: 0,
    });
    expect((await outboxRow(id)).dispatched_at).toBeNull();
  });

  it('9. sai người nhận, sai OA, sai outbox, sai nội dung, sai version đều bị chặn', async () => {
    const q = new RecruitmentChannelOutboxQueue(app);
    const conv = await conversation();
    const id = await aiReply(conv);
    const cases: Array<[Parameters<typeof grant>[1], string]> = [
      [{ recipient: OTHER }, 'DISPATCH_GRANT_RECIPIENT_MISMATCH'],
      [{ oa: '1705071610099849999' }, 'DISPATCH_GRANT_OA_MISMATCH'],
      [{ text: 'nội dung khác' }, 'DISPATCH_GRANT_TEXT_MISMATCH'],
      [{ version: 2 }, 'DISPATCH_GRANT_CONTROL_MISMATCH'],
    ];
    for (const [patch, code] of cases) {
      await owner.query(`DELETE FROM "recruitment_outbound_dispatch_grants"`);
      const g = await grant(id, patch);
      const forced = await forceClaim(id, `f-${code}`);
      expect(
        await q.dispatch(forced, `f-${code}`, false, pilots, guard),
      ).toEqual({ outcome: 'HELD', code });
      expect(await grantRow(g)).toMatchObject({
        status: 'ACTIVE',
        dispatches_used: 0,
      });
    }
    // Guard cấu hình OA khác với tin.
    await owner.query(`DELETE FROM "recruitment_outbound_dispatch_grants"`);
    await grant(id);
    const forced = await forceClaim(id, 'f-oa');
    expect(
      await q.dispatch(forced, 'f-oa', false, pilots, {
        oaId: '1705071610099849999',
      }),
    ).toEqual({ outcome: 'HELD', code: 'DISPATCH_GRANT_OA_MISMATCH' });
    // Người nhận ngoài pilot allowlist dù grant khớp.
    const forced2 = await forceClaim(id, 'f-pilot');
    expect(
      await q.dispatch(
        forced2,
        'f-pilot',
        false,
        [pilotFingerprint(OA, OTHER)],
        guard,
      ),
    ).toMatchObject({ outcome: 'SUPPRESSED', code: 'PILOT_RECIPIENT_BLOCKED' });
    // Grant cho outbox khác: tin này không có grant.
    await owner.query(`DELETE FROM "recruitment_outbound_dispatch_grants"`);
    await owner.query(
      `UPDATE "recruitment_channel_outbox" SET status = 'PENDING', lease_owner = NULL, lease_until = NULL, message_text = $2 WHERE id = $1`,
      [id, TEXT],
    );
    const otherConv = await conversation(OTHER);
    const otherId = await aiReply(otherConv, { recipient: OTHER });
    await grant(otherId, { recipient: OTHER });
    const forced3 = await forceClaim(id, 'f-missing');
    expect(
      await q.dispatch(forced3, 'f-missing', false, pilots, guard),
    ).toEqual({ outcome: 'HELD', code: 'DISPATCH_GRANT_MISSING' });
  });

  it('10. dừng khẩn Gửi Zalo chặn hoàn toàn, hạn mức không bị tiêu', async () => {
    const id = await aiReply(await conversation());
    const g = await grant(id);
    await owner.query(
      `UPDATE "recruitment_runtime_controls" SET outbound_halted = true WHERE id = 1`,
    );
    const q = new RecruitmentChannelOutboxQueue(app);
    expect(await attempt(q, 'l1')).toMatchObject({
      claimed: id,
      outcome: 'HELD',
    });
    expect(await grantRow(g)).toMatchObject({
      status: 'ACTIVE',
      dispatches_used: 0,
    });
    expect((await outboxRow(id)).status).toBe('PENDING');
    await owner.query(
      `UPDATE "recruitment_runtime_controls" SET outbound_halted = false, failsafe_halted = true WHERE id = 1`,
    );
    expect(await attempt(q, 'l2')).toMatchObject({ outcome: 'HELD' });
    expect(await grantRow(g)).toMatchObject({ dispatches_used: 0 });
  });

  it('quyền DB: sales_app chỉ đọc + tiêu grant, không tạo / xoá / đổi phạm vi', async () => {
    const id = await aiReply(await conversation());
    const g = await grant(id);
    await expect(
      app.query(
        `INSERT INTO "recruitment_outbound_dispatch_grants" (go_code, outbox_id, channel_account_id, recipient_fingerprint,
           approved_text_sha256, approved_control_version, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, 3, 'app', now() + interval '10 minutes')`,
        [nextGo(), id, OA, pilotFingerprint(OA, PILOT), sha(TEXT)],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(
        `DELETE FROM "recruitment_outbound_dispatch_grants" WHERE id = $1`,
        [g],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(
        `UPDATE "recruitment_outbound_dispatch_grants" SET outbox_id = outbox_id WHERE id = $1`,
        [g],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(
        `UPDATE "recruitment_outbound_dispatch_grants" SET expires_at = now() + interval '1 day' WHERE id = $1`,
        [g],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(
        `UPDATE "recruitment_outbound_dispatch_grants" SET status = 'REVOKED' WHERE id = $1`,
        [g],
      ),
    ).rejects.toThrow(/CHK_dispatch_grant_revoked/);
    expect(await grantRow(g)).toMatchObject({
      status: 'ACTIVE',
      dispatches_used: 0,
    });
    // Đã tiêu thì không "hoàn" lại được về ACTIVE mà vẫn giữ dispatches_used.
    await attempt(new RecruitmentChannelOutboxQueue(app), 'l1');
    await expect(
      app.query(
        `UPDATE "recruitment_outbound_dispatch_grants" SET status = 'ACTIVE' WHERE id = $1`,
        [g],
      ),
    ).rejects.toThrow(/không đổi được/);
    // "Hoàn" hạn mức (đủ cả 3 cột, thoả mọi CHECK) — trigger chặn, kể cả superuser.
    const refund = `UPDATE "recruitment_outbound_dispatch_grants" SET status = 'ACTIVE', dispatches_used = 0, consumed_at = NULL WHERE id = $1`;
    await expect(app.query(refund, [g])).rejects.toThrow(/không đổi được/);
    await expect(owner.query(refund, [g])).rejects.toThrow(/không đổi được/);
    await expect(
      owner.query(
        `DELETE FROM "recruitment_outbound_dispatch_grants" WHERE id = $1`,
        [g],
      ),
    ).rejects.toThrow(/không xoá được/);
    expect(await grantRow(g)).toMatchObject({
      status: 'CONSUMED',
      dispatches_used: 1,
    });
  });

  it('trigger: phạm vi grant ACTIVE bất biến, kể cả với superuser; thu hồi ACTIVE → REVOKED được', async () => {
    const id = await aiReply(await conversation());
    const g = await grant(id);
    await expect(
      owner.query(
        `UPDATE "recruitment_outbound_dispatch_grants" SET expires_at = expires_at + interval '1 minute' WHERE id = $1`,
        [g],
      ),
    ).rejects.toThrow(/bất biến/);
    await expect(
      owner.query(
        `UPDATE "recruitment_outbound_dispatch_grants" SET recipient_fingerprint = $2 WHERE id = $1`,
        [g, pilotFingerprint(OA, OTHER)],
      ),
    ).rejects.toThrow(/bất biến/);
    await owner.query(
      `UPDATE "recruitment_outbound_dispatch_grants" SET status = 'REVOKED', revoked_at = now(), revoked_by = 'SYSTEM OWNER test' WHERE id = $1`,
      [g],
    );
    expect(
      await attempt(new RecruitmentChannelOutboxQueue(app), 'l1'),
    ).toMatchObject({ claimed: null });
  });
});
