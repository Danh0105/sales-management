// Acceptance P3-7.2A — gửi MỘT request webhook Zalo tới instance đích (cùng network namespace).
// Chạy BÊN TRONG container staging-api: App ID / OA / OA secret lấy từ env của chính container
// (= khoá "sẽ có sau" trên staging) — không truyền secret qua tham số, không in ra.
//
//   TARGET_PORT=3026 node - send <runId> <msgId> <sender> <valid|bad|none>
//     valid: ký đúng sha256(appId + body + timestamp + OA secret) · bad: chữ ký ngẫu nhiên · none: không header
//   env tuỳ chọn: EVENT_TEXT (nội dung), EVENT_APP (ghi đè app_id), EVENT_OA (ghi đè OA nhận),
//                 RAW_BODY (gửi thân thô không phải JSON)
//   TARGET_PORT=3026 node - par <runId> <msgPrefix> <số request> <same|distinct>
//     gửi CÙNG LÚC n request ký đúng: same = cùng một request (byte y hệt), distinct = n tin khác nhau
//
// In một dòng JSON: {status, body} (send) hoặc {codes: {200: n, …}, created: số lần duplicate=false} (par).
const { createHash, randomBytes } = require('crypto');

const [mode, run, msgId, sender, sig] = process.argv.slice(2);
const PORT = process.env.TARGET_PORT || 3026;
const APP = process.env.RECRUITMENT_ZALO_APP_ID;
const OA = process.env.RECRUITMENT_ZALO_OA_ID;
const SECRET = process.env.RECRUITMENT_ZALO_OA_SECRET_KEY;

/** Timestamp tất định theo (run, msgId) → gửi lại là byte y hệt, như Zalo retry. */
function timestampOf(seed) {
  let n = 0;
  for (const ch of seed) n = (n * 31 + ch.charCodeAt(0)) % 997;
  return String(Number(run) * 1000 + n);
}

function signedTextEvent(id, user) {
  const timestamp = timestampOf(id);
  const body = Buffer.from(
    JSON.stringify({
      app_id: APP,
      user_id_by_app: `byapp-${user}`,
      event_name: 'user_send_text',
      timestamp,
      sender: { id: user },
      recipient: { id: OA },
      message: { text: `Tin song song ${id}`, msg_id: id },
    }),
  );
  const mac = createHash('sha256').update(APP).update(body).update(timestamp).update(SECRET).digest('hex');
  return fetch(`http://localhost:${PORT}/recruitment/channels/zalo/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zevent-signature': `mac=${mac}` },
    body,
  }).then(async (r) => ({ status: r.status, body: await r.text() }));
}

async function parallel() {
  const [, , prefix, count, kind] = process.argv.slice(2);
  const n = Number(count);
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      kind === 'same' ? signedTextEvent(prefix, `${prefix}-u`) : signedTextEvent(`${prefix}-${i}`, `${prefix}-u${i}`),
    ),
  );
  const codes = {};
  for (const r of results) codes[r.status] = (codes[r.status] || 0) + 1;
  const created = results.filter((r) => r.status === 200 && JSON.parse(r.body).duplicate === false).length;
  console.log(JSON.stringify({ codes, created }));
}

async function main() {
  if (mode === 'par') return parallel();
  if (mode !== 'send') throw new Error('mode');
  let body;
  let timestamp = '';
  if (process.env.RAW_BODY) {
    body = Buffer.from(process.env.RAW_BODY);
  } else {
    timestamp = timestampOf(msgId);
    body = Buffer.from(
      JSON.stringify({
        app_id: process.env.EVENT_APP || APP,
        user_id_by_app: `byapp-${sender}`,
        event_name: 'user_send_text',
        timestamp,
        sender: { id: sender },
        recipient: { id: process.env.EVENT_OA || OA },
        message: { text: process.env.EVENT_TEXT || 'Xin chào, em muốn ứng tuyển', msg_id: msgId },
      }),
    );
  }
  const headers = { 'content-type': 'application/json' };
  if (sig === 'valid') {
    headers['x-zevent-signature'] =
      'mac=' + createHash('sha256').update(APP).update(body).update(timestamp).update(SECRET).digest('hex');
  } else if (sig === 'bad') {
    headers['x-zevent-signature'] = 'mac=' + randomBytes(32).toString('hex');
  }
  const res = await fetch(`http://localhost:${PORT}/recruitment/channels/zalo/webhook`, {
    method: 'POST',
    headers,
    body,
  });
  console.log(JSON.stringify({ status: res.status, body: await res.text() }));
}

main().catch((error) => console.log(JSON.stringify({ status: 0, body: String(error.code || error.name) })));
