// PostgreSQL staging only. Run inside staging-api image with worker/outbound disabled.
// Uses synthetic event IDs and a trigger restricted to the synthetic actor name.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { DataSource } = require('/app/node_modules/typeorm');

const root = '/app/dist';
const { ActivityLog } = require(path.join(root, 'activity-log/activity-log.entity.js'));
const { RecruitmentAuditService } = require(path.join(root, 'recruitment/recruitment-audit.service.js'));
const { RecruitmentRuntimeControlService } = require(path.join(root, 'recruitment/channels/recruitment-runtime-control.service.js'));
const { RecruitmentChannelEventOperationsService } = require(path.join(root, 'recruitment/channels/recruitment-channel-event-operations.service.js'));
const { RecruitmentAiLimitsService } = require(path.join(root, 'recruitment/channels/recruitment-ai-limits.service.js'));

const ds = new DataSource({
  type: 'postgres', host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432), username: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  entities: [ActivityLog], poolSize: 75,
});
const run = `p1fix-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const good = { type: 'HR', employeeId: 158, name: 'P1FIX-OK', roles: ['nhansu'] };
const fault = { ...good, name: 'P1FIX-FAULT' };
const systemFault = { type: 'SYSTEM', name: 'P1FIX-FAULT', roles: [] };
const all = ['AI', 'WORKER', 'OUTBOUND'];
const results = [];
let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    results.push({ name, result: 'PASS' }); pass++;
  }, e => {
    results.push({ name, result: 'FAIL', error: e.message }); fail++;
  });
}
async function one(sql, params = []) { return (await ds.query(sql, params))[0]; }
async function count(sql, params = []) { return Number((await one(sql, params)).n); }
async function fixture(sender, status = 'PROCESSING') {
  const dedupe = `${run}-${crypto.randomBytes(8).toString('hex')}`;
  const [row] = await ds.query(`INSERT INTO recruitment_channel_events
    (channel, channel_account_id, dedupe_key, external_sender_id, event_type,
     provider_message_id, payload_hash, normalized_message_text, status, lease_owner)
    VALUES ('ZALO', 'p1fix-staging', $1, $2, 'user_send_text', $1,
            repeat('0', 64), 'synthetic staging only', $3::recruitment_channel_events_status_enum,
            CASE WHEN $3 = 'PROCESSING' THEN 'p1fix-worker' ELSE NULL END)
    RETURNING id`, [dedupe, sender, status]);
  return { id: row.id, channelAccountId: 'p1fix-staging', externalSenderId: sender };
}
const limits = {
  maxTurnsPerSenderHour: 100000, maxTurnsPerSenderDay: 100000,
  maxTurnsPerDay: 100000, dailyTokenBudget: 1000000000,
  monthlyTokenBudget: 2000000000, tokenReservationPerTurn: 1,
};
async function resetRuntime(runtime) {
  const state = await runtime.state();
  if (state.aiHalted || state.workerHalted || state.outboundHalted || state.failClosed)
    await runtime.set(all, false, 'P1FIX staging reset', good);
}
async function auditCount(method, id) {
  return count(`SELECT count(*)::int n FROM activity_log WHERE method = $1
    AND path = $2`, [method, `/recruitment-${id.entity}/${id.id}`]);
}
async function quotaBaseline() {
  const row = await one(`SELECT
    count(*) FILTER (WHERE ai_control_version IS NOT NULL AND
      (ai_reservation_day = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date OR
      (ai_reservation_day IS NULL AND received_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')))::int AS n,
    coalesce(sum(greatest(ai_reserved_tokens, coalesce(ai_total_tokens, 0))), 0)::bigint AS tokens
    FROM recruitment_channel_events`);
  return { turns: Number(row.n), tokens: Number(row.tokens) };
}
async function race(n, sharedSender) {
  const base = await quotaBaseline();
  const items = await Promise.all(Array.from({ length: n }, (_, i) =>
    fixture(sharedSender ? `${run}-shared-${n}` : `${run}-${n}-${i}`)));
  const cap = { ...limits, maxTurnsPerDay: base.turns + 1,
    dailyTokenBudget: base.tokens + 1, monthlyTokenBudget: base.tokens + 1 };
  const outcomes = await Promise.all(items.map(e =>
    new RecruitmentAiLimitsService(ds).reserve(e, 'p1fix-worker', 1, cap)));
  assert.equal(outcomes.filter(x => x.kind === 'RESERVED').length, 1);
  assert.equal(outcomes.filter(x => x.kind === 'LIMIT').length, n - 1);
  assert.equal(await count(`SELECT count(*)::int n FROM recruitment_channel_events
    WHERE id = ANY($1::int[]) AND ai_reserved_tokens IS NOT NULL`, [items.map(x => x.id)]), 1);
  return items.find((_, i) => outcomes[i].kind === 'RESERVED');
}

async function main() {
  assert.equal(process.env.DB_NAME, 'sales_db_staging');
  assert.equal(process.env.RECRUITMENT_WORKER_ENABLED, 'false');
  assert.equal(process.env.RECRUITMENT_ZALO_OUTBOUND_ENABLED, 'false');
  await ds.initialize();
  const audit = new RecruitmentAuditService({ record: async () => {} });
  const runtime = new RecruitmentRuntimeControlService(ds, audit);
  const operations = new RecruitmentChannelEventOperationsService(ds, audit);
  try {
    await ds.query(`DROP TRIGGER IF EXISTS g8_p1fix_audit_fault ON activity_log`);
    await ds.query(`CREATE OR REPLACE FUNCTION g8_p1fix_audit_fault_fn() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."actorName" = 'P1FIX-FAULT' THEN
          RAISE EXCEPTION 'P1FIX_AUDIT_INSERT_FAIL';
        END IF;
        RETURN NEW;
      END $$`);
    await ds.query(`CREATE TRIGGER g8_p1fix_audit_fault BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION g8_p1fix_audit_fault_fn()`);
    await resetRuntime(runtime);

    await check('audit INSERT fail: exclude rollback and retry idempotent', async () => {
      const e = await fixture(`${run}-exclude`, 'RECEIVED');
      await assert.rejects(() => operations.exclude(e.id, 'TEST_MESSAGE', fault), /P1FIX_AUDIT_INSERT_FAIL/);
      const row = await one(`SELECT status, normalized_message_text FROM recruitment_channel_events WHERE id=$1`, [e.id]);
      assert.equal(row.status, 'RECEIVED'); assert.ok(row.normalized_message_text);
      const before = await auditCount('CHANNEL_EVENT_EXCLUDE', { entity: 'channel-events', id: e.id });
      const first = await operations.exclude(e.id, 'TEST_MESSAGE', good);
      const second = await operations.exclude(e.id, 'TEST_MESSAGE', good);
      assert.equal(first.idempotent, false); assert.equal(second.idempotent, true);
      assert.equal(await auditCount('CHANNEL_EVENT_EXCLUDE', { entity: 'channel-events', id: e.id }), before + 1);
    });
    await check('audit INSERT fail: operator stop rollback, all-scope failsafe', async () => {
      await resetRuntime(runtime);
      const before = await auditCount('RUNTIME_STOP', { entity: 'runtime-controls', id: 1 });
      await assert.rejects(() => runtime.set(['AI'], true, 'P1FIX fault stop', fault), /P1FIX_AUDIT_INSERT_FAIL/);
      const row = await one(`SELECT ai_halted, worker_halted, outbound_halted, failsafe_halted FROM recruitment_runtime_controls WHERE id=1`);
      assert.equal(row.ai_halted, false); assert.equal(row.failsafe_halted, true);
      assert.equal((await runtime.state()).workerHalted, true);
      assert.equal((await runtime.state()).outboundHalted, true);
      assert.equal(await auditCount('RUNTIME_STOP', { entity: 'runtime-controls', id: 1 }), before);
      await resetRuntime(runtime);
    });
    await check('audit INSERT fail: resume rollback, no false success', async () => {
      await runtime.set(['AI'], true, 'P1FIX setup stop', good);
      const stopAudit = await one(`SELECT "beforeData" AS before, "afterData" AS after,
        context, "createdAt" AS at FROM activity_log WHERE method='RUNTIME_STOP'
        AND context->>'reason'='P1FIX setup stop' ORDER BY id DESC LIMIT 1`);
      assert.equal(stopAudit.before.ai, false);
      assert.equal(stopAudit.after.ai, true);
      assert.equal(stopAudit.context.result, 'SUCCESS');
      assert.ok(stopAudit.at);
      const before = await auditCount('RUNTIME_RESUME', { entity: 'runtime-controls', id: 1 });
      await assert.rejects(() => runtime.set(['AI'], false, 'P1FIX fault resume', fault), /P1FIX_AUDIT_INSERT_FAIL/);
      assert.equal((await runtime.state()).aiHalted, true);
      assert.equal(await auditCount('RUNTIME_RESUME', { entity: 'runtime-controls', id: 1 }), before);
      await resetRuntime(runtime);
    });
    await check('audit INSERT fail: auto-halt rollback, all-scope failsafe', async () => {
      await resetRuntime(runtime);
      const before = await auditCount('RUNTIME_STOP', { entity: 'runtime-controls', id: 1 });
      await assert.rejects(() => runtime.haltAiIfRunning('P1FIX auto', systemFault), /P1FIX_AUDIT_INSERT_FAIL/);
      const row = await one(`SELECT ai_halted, failsafe_halted FROM recruitment_runtime_controls WHERE id=1`);
      assert.equal(row.ai_halted, false); assert.equal(row.failsafe_halted, true);
      assert.equal(await auditCount('RUNTIME_STOP', { entity: 'runtime-controls', id: 1 }), before);
      await resetRuntime(runtime);
    });
    await check('concurrent stop/resume serialize; exactly one audit per committed change', async () => {
      await resetRuntime(runtime);
      const before = await auditCount('RUNTIME_STOP', { entity: 'runtime-controls', id: 1 }) +
        await auditCount('RUNTIME_RESUME', { entity: 'runtime-controls', id: 1 });
      await Promise.all([runtime.set(['AI'], true, 'P1FIX concurrent stop', good),
        runtime.set(['AI'], false, 'P1FIX concurrent resume', good)]);
      const after = await auditCount('RUNTIME_STOP', { entity: 'runtime-controls', id: 1 }) +
        await auditCount('RUNTIME_RESUME', { entity: 'runtime-controls', id: 1 });
      assert.ok(after - before >= 1 && after - before <= 2);
      await resetRuntime(runtime);
    });
    await check('two workers auto-halt: one state change, one audit', async () => {
      await resetRuntime(runtime);
      const before = await auditCount('RUNTIME_STOP', { entity: 'runtime-controls', id: 1 });
      const outcomes = await Promise.all([1, 2].map(() =>
        runtime.haltAiIfRunning('P1FIX concurrent auto', good)));
      assert.equal(outcomes.filter(Boolean).length, 1);
      assert.equal(await auditCount('RUNTIME_STOP', { entity: 'runtime-controls', id: 1 }), before + 1);
      const auditRow = await one(`SELECT "beforeData" AS before,"afterData" AS after
        FROM activity_log WHERE method='RUNTIME_STOP' AND
        context->>'reason'='P1FIX concurrent auto' ORDER BY id DESC LIMIT 1`);
      assert.equal(auditRow.before.ai, false);
      assert.equal(auditRow.after.ai, true);
      await resetRuntime(runtime);
    });
    await check('PostgreSQL cannot read runtime controls: local fail-closed', async () => {
      const qr = ds.createQueryRunner();
      await qr.connect(); await qr.startTransaction();
      try {
        // Genuine PostgreSQL fault on this transaction, without changing shared schema.
        await qr.query(`SET LOCAL search_path TO pg_temp`);
        const broken = new RecruitmentRuntimeControlService({
          query: (sql, params) => qr.query(sql, params),
        }, audit);
        const state = await broken.state();
        assert.equal(state.aiHalted && state.workerHalted && state.outboundHalted && state.failClosed, true);
      } finally {
        await qr.rollbackTransaction(); await qr.release();
      }
    });
    for (const n of [16, 32, 64]) {
      await check(`${n} workers, one remaining global quota`, async () => { await race(n, false); });
    }
    await check('many senders share one global quota', async () => { await race(32, false); });
    await check('same sender, one remaining sender quota', async () => {
      const base = await quotaBaseline();
      const sender = `${run}-sender`;
      const items = await Promise.all(Array.from({ length: 16 }, () => fixture(sender)));
      const cap = { ...limits, maxTurnsPerDay: base.turns + 100,
        maxTurnsPerSenderHour: 1, maxTurnsPerSenderDay: 1 };
      const outcomes = await Promise.all(items.map(e =>
        new RecruitmentAiLimitsService(ds).reserve(e, 'p1fix-worker', 1, cap)));
      assert.equal(outcomes.filter(x => x.kind === 'RESERVED').length, 1);
    });
    await check('same event retry and crash after reservation do not reserve twice', async () => {
      const e = await fixture(`${run}-retry`);
      const svc = new RecruitmentAiLimitsService(ds);
      assert.equal((await svc.reserve(e, 'p1fix-worker', 1, limits)).kind, 'RESERVED');
      assert.equal((await svc.reserve(e, 'p1fix-worker', 1, limits)).kind, 'EXISTING');
      await ds.query(`UPDATE recruitment_channel_events SET lease_owner='p1fix-recovered' WHERE id=$1`, [e.id]);
      assert.equal((await svc.reserve(e, 'p1fix-recovered', 1, limits)).kind, 'EXISTING');
      await ds.query(`UPDATE recruitment_channel_events SET ai_provider_dispatched_at=clock_timestamp() WHERE id=$1`, [e.id]);
      assert.equal((await svc.reserve(e, 'p1fix-recovered', 1, limits)).kind, 'UNCERTAIN');
      assert.equal((await one(`SELECT ai_reserved_tokens FROM recruitment_channel_events WHERE id=$1`, [e.id])).ai_reserved_tokens, 1);
    });
    await check('VN day/month SQL boundaries', async () => {
      const rows = await ds.query(`SELECT
        ('2026-10-31 16:59:59+00'::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS before_day,
        ('2026-10-31 17:00:00+00'::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS after_day,
        date_trunc('month', '2026-10-31 16:59:59+00'::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS before_month,
        date_trunc('month', '2026-10-31 17:00:00+00'::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS after_month`);
      assert.deepEqual(rows[0], { before_day: '2026-10-31', after_day: '2026-11-01', before_month: '2026-10-01', after_month: '2026-11-01' });
    });
  } finally {
    await ds.query(`DROP TRIGGER IF EXISTS g8_p1fix_audit_fault ON activity_log`);
    await ds.query(`DROP FUNCTION IF EXISTS g8_p1fix_audit_fault_fn()`);
    await ds.query(`DELETE FROM recruitment_channel_events WHERE dedupe_key LIKE $1`, [`${run}-%`]);
    await resetRuntime(runtime);
    await ds.destroy();
  }
  console.log(JSON.stringify({ run, pass, fail, results }));
  if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(`P1FIX_FATAL ${e.message}`); process.exitCode = 1; });
