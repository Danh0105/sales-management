// Zalo GIẢ cho acceptance P3-5 — chạy trong network namespace staging (container từ
// image staging-api). KHÔNG phải OA thật; token do chính server này sinh ngẫu nhiên.
//
//   API   :3198  POST /v3.0/oa/message/cs   (Send API: header access_token, {recipient, message})
//                POST /v4/oa/access_token    (OAuth refresh: secret_key + form app_id/refresh_token)
//   admin :3199  POST /__mode {"mode", "delayMs", "times", "then"}   chế độ Send API (chuỗi)
//                POST /__expire               access token hiện tại hết hiệu lực (refresh token còn)
//                POST /__down {"ms"}          đóng cổng API (kết nối bị từ chối) trong ms
//                POST /__refresh-delay {"ms"} refresh chậm (mở rộng cửa sổ tranh chấp)
//                GET  /__seed                 token hiện tại — CHỈ để script nạp DB đọc, không in
//                GET  /__state                số lần refresh, version token (không có token)
//                GET  /__log                  request Send API (người nhận, hash nội dung, kết quả)
//
// Chế độ Send API: ok | slow | 429 | 500 | 503 | 504 | reject (-213) | reject-unknown (-230)
//                  | hang (nhận rồi không trả lời) | drop (nhận rồi cắt kết nối) | garbage
// Token sai → luôn {error:-216, message:"Access token is invalid"} (giả lập hết hạn).
const http = require('http');
const { createHash, randomBytes } = require('crypto');

const APP_ID = process.env.RECRUITMENT_ZALO_APP_ID || '';
const APP_SECRET = process.env.RECRUITMENT_ZALO_APP_SECRET || '';
const fresh = () => randomBytes(24).toString('base64url');

let tokens = { access: fresh(), refresh: fresh(), version: 1 };
let refreshCount = 0;
let refreshRejected = 0;
let refreshDelayMs = 0;
let state = { mode: 'ok', delayMs: 0 };
let log = [];
let messageSeq = 0;
const issued = [tokens.access, tokens.refresh];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function sendApi(req, res, raw) {
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    // ghi log với body rỗng
  }
  const current = state;
  if (typeof current.times === 'number' && --current.times <= 0) {
    state = { delayMs: 0, ...(current.then || { mode: 'ok' }) };
  }
  const entry = {
    t0: Date.now(),
    t1: null,
    recipient: body?.recipient?.user_id ?? null,
    textSha: sha(body?.message?.text ?? ''),
    textLength: String(body?.message?.text ?? '').length,
    tokenOk: req.headers.access_token === tokens.access,
    mode: current.mode,
    result: null,
  };
  log.push(entry);
  const done = (result) => {
    entry.t1 = Date.now();
    entry.result = result;
  };
  if (!entry.tokenOk) {
    done('-216');
    return json(res, 200, { error: -216, message: 'Access token is invalid' });
  }
  if (current.delayMs) await sleep(current.delayMs);
  switch (current.mode) {
    case 'ok':
    case 'slow': {
      const id = `fz-${++messageSeq}`;
      done(`200:${id}`);
      return json(res, 200, { error: 0, message: 'Success', data: { message_id: id, user_id: entry.recipient } });
    }
    case '429':
    case '500':
    case '503':
    case '504':
      done(current.mode);
      return json(res, Number(current.mode), { error: Number(current.mode), message: 'fake' });
    case 'reject':
      done('-213');
      return json(res, 200, { error: -213, message: 'User has not followed OA' });
    case 'reject-unknown':
      done('-230');
      return json(res, 200, { error: -230, message: 'fake rejection' });
    case 'hang':
      done('hang');
      return; // không bao giờ trả lời
    case 'drop':
      done('drop');
      return req.socket.destroy();
    case 'garbage':
      done('garbage');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>oops</html>');
    default:
      done('500');
      return json(res, 500, { error: 500 });
  }
}

async function oauth(req, res, raw) {
  const form = Object.fromEntries(new URLSearchParams(raw));
  if (refreshDelayMs) await sleep(refreshDelayMs);
  const valid =
    req.headers.secret_key === APP_SECRET &&
    form.app_id === APP_ID &&
    form.grant_type === 'refresh_token' &&
    form.refresh_token === tokens.refresh;
  if (!valid) {
    refreshRejected += 1;
    return json(res, 200, { error: -14014, error_name: 'Invalid refresh token' });
  }
  // Refresh token chỉ dùng một lần: xoay cả hai.
  tokens = { access: fresh(), refresh: fresh(), version: tokens.version + 1 };
  issued.push(tokens.access, tokens.refresh);
  refreshCount += 1;
  return json(res, 200, { access_token: tokens.access, refresh_token: tokens.refresh, expires_in: 90000 });
}

const api = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  if (req.method === 'POST' && req.url === '/v3.0/oa/message/cs') return sendApi(req, res, raw);
  if (req.method === 'POST' && req.url === '/v4/oa/access_token') return oauth(req, res, raw);
  return json(res, 404, {});
});
const listenApi = () => api.listen(3198);

const admin = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : {};
  switch (`${req.method} ${req.url}`) {
    case 'POST /__mode':
      state = { delayMs: 0, ...body };
      return json(res, 200, state);
    case 'POST /__expire':
      tokens = { ...tokens, access: fresh() };
      issued.push(tokens.access);
      return json(res, 200, { ok: true });
    case 'POST /__down':
      api.close();
      api.closeAllConnections();
      setTimeout(listenApi, Number(body.ms) || 3000);
      return json(res, 200, { ok: true });
    case 'POST /__refresh-delay':
      refreshDelayMs = Number(body.ms) || 0;
      return json(res, 200, { ok: true });
    case 'GET /__seed':
      return json(res, 200, { access_token: tokens.access, refresh_token: tokens.refresh, expires_in: 90000 });
    case 'GET /__issued':
      // Mọi token từng cấp — để acceptance dò rò rỉ trong log (đọc qua pipe, không in).
      return json(res, 200, issued);
    case 'GET /__state':
      return json(res, 200, { refreshCount, refreshRejected, version: tokens.version, mode: state.mode });
    case 'GET /__log':
      return json(res, 200, log);
    default:
      return json(res, 404, {});
  }
});

listenApi();
admin.listen(3199, () => console.log('fake-zalo api :3198 admin :3199'));
