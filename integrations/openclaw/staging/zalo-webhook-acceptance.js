// Acceptance P3-3 (mức HTTP) — webhook Zalo OA tuyển dụng. Chạy BÊN TRONG container
// staging-api (cùng network namespace với instance đích), đọc App ID / OA / secret
// từ env của chính container — không truyền secret qua tham số, không in ra.
//
//   TARGET_PORT=3022 node - full <runId>                 # các case HTTP 1–7, 9
//   TARGET_PORT=3022 node - send <runId> <msgId> <sender> [oaId] [path]
//                                                         # gửi lại đúng một event (byte y hệt)
//
// In ra một dòng JSON cuối: { results: [{name, ok, detail}], ids: {...} } hoặc {status, body}.
const { createHash } = require('crypto');

const MODE = process.argv[2];
const RUN = process.argv[3];
const PORT = process.env.TARGET_PORT || 3022;
const APP = process.env.RECRUITMENT_ZALO_APP_ID;
const OA = process.env.RECRUITMENT_ZALO_OA_ID;
const SECRET = process.env.RECRUITMENT_ZALO_OA_SECRET_KEY;
const WEBHOOK = '/recruitment/channels/zalo/webhook';
const results = [];
const ids = {};

/** Timestamp tất định theo (run, msgId) → gửi lại là byte y hệt, như Zalo retry. */
function timestampOf(seed) {
  let n = 0;
  for (const ch of seed) n = (n * 31 + ch.charCodeAt(0)) % 997;
  return String(Number(RUN) * 1000 + n);
}

function textEvent({ msgId, sender, oa = OA, overrides = {} }) {
  return {
    app_id: APP,
    user_id_by_app: `byapp-${sender}`,
    event_name: 'user_send_text',
    timestamp: timestampOf(msgId),
    sender: { id: sender },
    recipient: { id: oa },
    message: { text: 'Xin chào, em muốn ứng tuyển vị trí tư vấn', msg_id: msgId },
    ...overrides,
  };
}

function mac(raw, timestamp, { secret = SECRET, app = APP } = {}) {
  return createHash('sha256')
    .update(app)
    .update(Buffer.from(raw, 'utf8'))
    .update(timestamp ?? '')
    .update(secret)
    .digest('hex');
}

function sign(payload, opts) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { raw, signature: `mac=${mac(raw, payload.timestamp, opts)}` };
}

async function post(raw, signature, { contentType = 'application/json', path = WEBHOOK } = {}) {
  const headers = { 'Content-Type': contentType };
  if (signature !== undefined) headers['X-ZEvent-Signature'] = signature;
  const res = await fetch(`http://localhost:${PORT}${path}`, { method: 'POST', headers, body: raw });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 120) };
  }
  return { status: res.status, body };
}

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : JSON.stringify(detail).slice(0, 300) });
}

const isAck = (r, duplicate, status) =>
  r.status === 200 && r.body.ok === true && r.body.duplicate === duplicate && r.body.status === status;
const isReject = (r, status, code) => r.status === status && (code === undefined || r.body.code === code);

async function full() {
  const A = `u${RUN}a`;
  const B = `u${RUN}b`;
  const msg = (suffix) => `p33-${RUN}-${suffix}`;
  ids.senderA = A;
  ids.senderB = B;

  // 1. Event hợp lệ có chữ ký → ACK, ghi một dòng RECEIVED.
  const e1 = sign(textEvent({ msgId: msg('c1'), sender: A }));
  const r1 = await post(e1.raw, e1.signature);
  check('1. event hợp lệ có chữ ký → 200 RECEIVED, duplicate=false', isAck(r1, false, 'RECEIVED'), r1);
  ids.c1 = msg('c1');
  ids.c1PayloadHash = createHash('sha256').update(e1.raw).digest('hex');

  // 2. Gửi lại y hệt → vẫn ACK, đánh dấu trùng.
  const r2 = await post(e1.raw, e1.signature);
  check('2. gửi lại cùng event → 200, duplicate=true', isAck(r2, true, 'RECEIVED'), r2);

  // 3. 10 request song song cùng một event → đúng một request được ghi.
  const e3 = sign(textEvent({ msgId: msg('c3'), sender: A }));
  const r3 = await Promise.all(Array.from({ length: 10 }, () => post(e3.raw, e3.signature)));
  const fresh3 = r3.filter((r) => isAck(r, false, 'RECEIVED')).length;
  const dup3 = r3.filter((r) => isAck(r, true, 'RECEIVED')).length;
  check('3. 10 request song song cùng event → 10×200, đúng 1 duplicate=false', fresh3 === 1 && dup3 === 9, r3.map((r) => [r.status, r.body.duplicate]));
  ids.c3 = msg('c3');

  // 3b. Cùng msg_id nhưng 10 body khác nhau (timestamp khác — Zalo gửi lại có thể đổi) song song.
  const r3b = await Promise.all(
    Array.from({ length: 10 }, (_, i) => {
      const e = sign(textEvent({ msgId: msg('c3b'), sender: A, overrides: { timestamp: String(Number(RUN) * 1000 + i) } }));
      return post(e.raw, e.signature);
    }),
  );
  const fresh3b = r3b.filter((r) => isAck(r, false, 'RECEIVED')).length;
  check('3b. 10 body khác nhau cùng msg_id, song song → đúng 1 duplicate=false', fresh3b === 1 && r3b.every((r) => r.status === 200), r3b.map((r) => [r.status, r.body.duplicate]));
  ids.c3b = msg('c3b');

  // 4. Chữ ký sai → 401, không ghi.
  const p4 = (s) => textEvent({ msgId: msg(s), sender: A });
  const wrongSecret = sign(p4('c4a'), { secret: 'not-the-secret-0000000000000000' });
  const r4a = await post(wrongSecret.raw, wrongSecret.signature);
  const r4b = await post(JSON.stringify(p4('c4b')), undefined);
  const e4c = sign(p4('c4c'));
  const r4c = await post(e4c.raw.replace(A, B), e4c.signature);
  const r4d = await post(JSON.stringify(p4('c4d')), e1.signature);
  const wrongApp = sign(p4('c4e'), { app: 'other-app' });
  const r4e = await post(wrongApp.raw, wrongApp.signature);
  check('4a. sai secret → 401 INVALID_SIGNATURE', isReject(r4a, 401, 'INVALID_SIGNATURE'), r4a);
  check('4b. thiếu header chữ ký → 401', isReject(r4b, 401, 'INVALID_SIGNATURE'), r4b);
  check('4c. body bị sửa sau khi ký → 401', isReject(r4c, 401, 'INVALID_SIGNATURE'), r4c);
  check('4d. dùng lại chữ ký của event khác → 401', isReject(r4d, 401, 'INVALID_SIGNATURE'), r4d);
  check('4e. ký bằng app id khác → 401', isReject(r4e, 401, 'INVALID_SIGNATURE'), r4e);
  ids.c4 = ['c4a', 'c4b', 'c4c', 'c4d', 'c4e'].map(msg);

  // 5. Chữ ký đúng nhưng sai OA / sai app → 403, không ghi.
  const e5a = sign(textEvent({ msgId: msg('c5a'), sender: A, oa: 'stg-other-oa' }));
  const r5a = await post(e5a.raw, e5a.signature);
  const e5b = sign(textEvent({ msgId: msg('c5b'), sender: A, overrides: { app_id: 'other-app' } }));
  const r5b = await post(e5b.raw, e5b.signature);
  const e5c = sign(textEvent({ msgId: msg('c5c'), sender: A, overrides: { oa_id: 'stg-other-oa' } }));
  const r5c = await post(e5c.raw, e5c.signature);
  check('5a. chữ ký đúng, event của OA khác → 403 OA_MISMATCH', isReject(r5a, 403, 'OA_MISMATCH'), r5a);
  check('5b. chữ ký đúng, app_id khác cấu hình → 403 APP_MISMATCH', isReject(r5b, 403, 'APP_MISMATCH'), r5b);
  check('5c. chữ ký đúng, oa_id mâu thuẫn → 403 OA_MISMATCH', isReject(r5c, 403, 'OA_MISMATCH'), r5c);
  ids.c5 = ['c5a', 'c5b', 'c5c'].map(msg);

  // 6. Payload hỏng → 4xx, không crash, request sau vẫn được phục vụ.
  const r6a = await post('{"event_name":', 'mac=00');
  const r6b = await post('[1,2,3]', 'mac=00');
  const r6c = await post('event_name=user_send_text', 'mac=00', { contentType: 'text/plain' });
  const e6d = sign(textEvent({ msgId: msg('c6d'), sender: A, overrides: { sender: undefined } }));
  const r6d = await post(e6d.raw, e6d.signature);
  const e6e = sign(textEvent({ msgId: msg('c6e'), sender: A, overrides: { message: { msg_id: msg('c6e') } } }));
  const r6e = await post(e6e.raw, e6e.signature);
  const r6f = await post(JSON.stringify({ pad: 'x'.repeat(200_000) }), 'mac=00');
  const e6g = sign(textEvent({ msgId: msg('c6g'), sender: A }));
  const r6g = await post(e6g.raw, e6g.signature);
  check('6a. JSON hỏng → 400', r6a.status === 400, r6a);
  check('6b. JSON mảng → 400 MALFORMED_PAYLOAD', isReject(r6b, 400, 'MALFORMED_PAYLOAD'), r6b);
  check('6c. không phải JSON (text/plain) → 400 MALFORMED_PAYLOAD', isReject(r6c, 400, 'MALFORMED_PAYLOAD'), r6c);
  check('6d. chữ ký đúng, thiếu sender → 400 MALFORMED_EVENT', isReject(r6d, 400, 'MALFORMED_EVENT'), r6d);
  check('6e. chữ ký đúng, thiếu text → 400 MALFORMED_EVENT', isReject(r6e, 400, 'MALFORMED_EVENT'), r6e);
  check('6f. body > giới hạn (200KB) → 413, không crash', r6f.status === 413, r6f);
  check('6g. sau các payload hỏng, event hợp lệ vẫn 200', isAck(r6g, false, 'RECEIVED'), r6g);
  ids.c6Rejected = ['c6d', 'c6e'].map(msg);
  ids.c6g = msg('c6g');

  // 7. Event hợp lệ nhưng chưa hỗ trợ → IGNORED, ACK.
  const follow = {
    app_id: APP,
    oa_id: OA,
    user_id_by_app: `byapp-${A}`,
    event_name: 'follow',
    source: 'oa_profile',
    timestamp: timestampOf(`follow-${A}`),
    follower: { id: A },
  };
  const e7a = sign(follow);
  const r7a = await post(e7a.raw, e7a.signature);
  const r7a2 = await post(e7a.raw, e7a.signature);
  const e7b = sign(textEvent({ msgId: msg('c7b'), sender: A, overrides: { event_name: 'user_send_image', message: { msg_id: msg('c7b'), attachments: [{ type: 'image', payload: { url: 'https://example.invalid/a.jpg' } }] } } }));
  const r7b = await post(e7b.raw, e7b.signature);
  check('7a. follow (không có msg_id) → 200 IGNORED', isAck(r7a, false, 'IGNORED'), r7a);
  check('7a. gửi lại follow → duplicate=true (khoá hash tất định)', isAck(r7a2, true, 'IGNORED'), r7a2);
  check('7b. user_send_image → 200 IGNORED', isAck(r7b, false, 'IGNORED'), r7b);
  ids.c7b = msg('c7b');

  // 9. Ứng viên A/B xen kẽ, song song.
  const order = [
    ['c9a1', A],
    ['c9b1', B],
    ['c9a2', A],
    ['c9b2', B],
  ];
  const r9 = await Promise.all(order.map(([s, sender]) => {
    const e = sign(textEvent({ msgId: msg(s), sender }));
    return post(e.raw, e.signature);
  }));
  check('9. A/B xen kẽ song song → 4×200 RECEIVED', r9.every((r) => isAck(r, false, 'RECEIVED')), r9);
  ids.c9 = Object.fromEntries(order.map(([s, sender]) => [msg(s), sender]));
}

async function send() {
  const [msgId, sender, oa = OA, path = WEBHOOK] = process.argv.slice(4);
  const e = sign(textEvent({ msgId, sender, oa }));
  return post(e.raw, e.signature, { path });
}

(async () => {
  if (!APP || !OA || !SECRET) throw new Error('thiếu RECRUITMENT_ZALO_* trong env container');
  if (MODE === 'full') {
    await full();
    console.log(JSON.stringify({ results, ids }));
  } else if (MODE === 'send') {
    console.log(JSON.stringify(await send()));
  } else {
    throw new Error('Dùng: node - full|send <runId> ...');
  }
})().catch((error) => {
  console.log(JSON.stringify({ results, ids, error: error.message }));
  process.exitCode = 1;
});
