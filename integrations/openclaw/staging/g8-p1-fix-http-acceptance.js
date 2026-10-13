// Run in staging-api image while its main staging-api instance serves localhost:3021.
// Creates only synthetic employee/event rows and a narrowly matched fault trigger.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DataSource } = require('/app/node_modules/typeorm');
const bcrypt = require('/app/node_modules/bcrypt');
const ds = new DataSource({
  type: 'postgres', host: 'localhost', username: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const name = 'P1FIX-HTTP-FAULT';
const run = Date.now().toString();
let employeeId = null;
let eventId = null;
let authToken = null;
let pass = 0;
const base = 'http://localhost:3021';
async function row(sql, params = []) { return (await ds.query(sql, params))[0]; }
async function auditCount(method, path) {
  return Number((await row(`SELECT count(*)::int n FROM activity_log WHERE method=$1 AND path=$2`, [method, path])).n);
}
async function request(token, method, uri, body) {
  const r = await fetch(base + uri, { method, headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
  return r.status;
}
async function trigger(on) {
  await ds.query(`DROP TRIGGER IF EXISTS g8_p1fix_http_fault ON activity_log`);
  if (on) await ds.query(`CREATE TRIGGER g8_p1fix_http_fault BEFORE INSERT ON activity_log
    FOR EACH ROW EXECUTE FUNCTION g8_p1fix_http_fault_fn()`);
}
async function main() {
  assert.equal(process.env.DB_NAME, 'sales_db_staging');
  assert.equal(process.env.RECRUITMENT_WORKER_ENABLED, 'false');
  await ds.initialize();
  try {
    await trigger(false);
    await ds.query(`CREATE OR REPLACE FUNCTION g8_p1fix_http_fault_fn() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."actorName" = 'P1FIX-HTTP-FAULT' AND NEW.method IN
           ('RUNTIME_STOP','RUNTIME_RESUME','CHANNEL_EVENT_EXCLUDE') THEN
          RAISE EXCEPTION 'P1FIX_HTTP_AUDIT_FAIL';
        END IF;
        RETURN NEW;
      END $$`);
    const phone = `09${run.slice(-8)}`;
    const password = crypto.randomBytes(18).toString('hex');
    const hash = await bcrypt.hash(password, 10);
    employeeId = (await row(`INSERT INTO employee (name,phone,password,roles)
      VALUES ($1,$2,$3,'{nhansu}') RETURNING id`, [name, phone, hash])).id;
    const login = await fetch(base + '/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password }) });
    assert.ok(login.status >= 200 && login.status < 300);
    const token = (await login.json()).access_token;
    assert.ok(token);
    authToken = token;

    await ds.query(`UPDATE recruitment_runtime_controls SET ai_halted=false,
      worker_halted=false,outbound_halted=false,failsafe_halted=false,
      failsafe_reason=NULL,failsafe_at=NULL WHERE id=1`);
    await trigger(true);
    const runtimePath = '/recruitment-runtime-controls/1';
    let before = await auditCount('RUNTIME_STOP', runtimePath);
    let status = await request(token, 'POST', '/recruitment/operations/runtime-controls/stop',
      { scopes: ['AI'], reason: 'P1FIX HTTP audit fail stop' });
    assert.ok(status < 200 || status >= 300);
    let state = await row(`SELECT ai_halted,failsafe_halted FROM recruitment_runtime_controls WHERE id=1`);
    assert.equal(state.ai_halted, false); assert.equal(state.failsafe_halted, true);
    assert.equal(await auditCount('RUNTIME_STOP', runtimePath), before);
    pass++;

    await trigger(false);
    await ds.query(`UPDATE recruitment_runtime_controls SET failsafe_halted=false,
      failsafe_reason=NULL,failsafe_at=NULL WHERE id=1`);
    status = await request(token, 'POST', '/recruitment/operations/runtime-controls/stop',
      { scopes: ['AI'], reason: 'P1FIX HTTP setup stop' });
    assert.ok(status >= 200 && status < 300);
    await trigger(true);
    before = await auditCount('RUNTIME_RESUME', runtimePath);
    status = await request(token, 'POST', '/recruitment/operations/runtime-controls/resume',
      { scopes: ['AI'], reason: 'P1FIX HTTP audit fail resume' });
    assert.ok(status < 200 || status >= 300);
    state = await row(`SELECT ai_halted FROM recruitment_runtime_controls WHERE id=1`);
    assert.equal(state.ai_halted, true);
    assert.equal(await auditCount('RUNTIME_RESUME', runtimePath), before);
    pass++;

    const dedupe = `p1fix-http-${run}`;
    eventId = (await row(`INSERT INTO recruitment_channel_events
      (channel,channel_account_id,dedupe_key,external_sender_id,event_type,
       provider_message_id,payload_hash,normalized_message_text)
      VALUES ('ZALO','p1fix-staging',$1,'p1fix-http','user_send_text',$1,
              repeat('0',64),'synthetic staging only') RETURNING id`, [dedupe])).id;
    const eventPath = `/recruitment-channel-events/${eventId}`;
    before = await auditCount('CHANNEL_EVENT_EXCLUDE', eventPath);
    status = await request(token, 'POST', `/recruitment/operations/events/${eventId}/exclude`,
      { reason: 'TEST_MESSAGE' });
    assert.ok(status < 200 || status >= 300);
    const event = await row(`SELECT status,normalized_message_text FROM recruitment_channel_events WHERE id=$1`, [eventId]);
    assert.equal(event.status, 'RECEIVED'); assert.ok(event.normalized_message_text);
    assert.equal(await auditCount('CHANNEL_EVENT_EXCLUDE', eventPath), before);
    pass++;
    console.log(JSON.stringify({ run, pass, fail: 0, cases: [
      'HTTP stop audit failure rejects and rolls back',
      'HTTP resume audit failure rejects and rolls back',
      'HTTP exclude audit failure rejects and rolls back',
    ] }));
  } finally {
    await trigger(false);
    await ds.query(`DROP FUNCTION IF EXISTS g8_p1fix_http_fault_fn()`);
    if (eventId) await ds.query(`DELETE FROM recruitment_channel_events WHERE id=$1`, [eventId]);
    if (authToken) {
      await request(authToken, 'POST', '/recruitment/operations/runtime-controls/resume',
        { scopes: ['AI', 'WORKER', 'OUTBOUND'], reason: 'P1FIX HTTP staging cleanup' });
    }
    if (employeeId) await ds.query(`DELETE FROM employee WHERE id=$1`, [employeeId]);
    await ds.destroy();
  }
}
main().catch(e => { console.error(`P1FIX_HTTP_FAIL ${e.message}`); process.exitCode = 1; });
