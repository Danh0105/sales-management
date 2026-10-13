// OpenClaw GIẢ cho acceptance P3-4 — chạy trong network namespace của staging
// (container riêng từ image staging-api), nghe MOCK_PORT (mặc định 3099).
// Ghi lại MỌI request worker gửi tới (session key, msg id, auth đúng/sai, thời
// điểm bắt đầu/kết thúc) để đo: claim một lần, tuần tự theo người gửi, song song
// giữa người gửi, session key do worker dựng.
//
// Chế độ (POST /__mode {"mode": ..., "delayMs": n, "drop": n, "times": n, "then": {...}}):
//   `times` + `then`: phục vụ đúng n request ở chế độ này rồi chuyển sang `then`
//   (mặc định ok) — để mỗi lần thử của worker gặp đúng một kiểu lỗi đã định.
//   ok          "model giả": làm đúng như plugin trong session kênh — find-or-create
//               ứng viên + lưu tin đến (msg) + lưu tin đi (msg-reply) qua API AI bằng
//               key KÊNH + header subject lấy từ session key — rồi trả 200 completed
//   ok-nosave   chỉ nhận diện ứng viên, KHÔNG lưu tin (worker phải tự lưu canonical)
//   ok-drop     như ok (đủ tác dụng nghiệp vụ) nhưng CẮT kết nối, không trả lời —
//               giả lập worker chết ngay sau khi OpenClaw chạy xong; `drop` lần đầu
//   proxy       chuyển nguyên request tới gateway THẬT (OPENCLAW_UPSTREAM)
//   proxy-drop  như proxy nhưng cắt kết nối sau khi gateway trả lời (`drop` lần đầu)
//   503 | 500 | 401 | 400 | quota | rate | billing402 | hang | fallback | errortext | incomplete
//   Tham số thêm (P3-7.3 / G8): "reply": "..." — câu trả lời của model giả (thay câu mặc định);
//   "usage": {...} — trường `usage` (định dạng OpenAI Responses) trả kèm khi 200 completed.
// GET /__log → danh sách request; POST /__reset → xoá log.
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 3099);
const TOKEN = process.env.RECRUITMENT_OPENCLAW_TOKEN || '';
const UPSTREAM = process.env.OPENCLAW_UPSTREAM || 'http://openclaw-gateway:18789';
const API = `http://localhost:${process.env.API_PORT || 3021}/recruitment/ai`;
const CHANNEL_KEY = process.env.RECRUITMENT_CHANNEL_API_KEY || '';
const SESSION = /^agent:[^:]+:zalo:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,100})$/;

let state = { mode: 'ok', delayMs: 0, drop: 0 };
let log = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const completed = (text, status = 'completed', usage) => ({
  id: `resp_mock_${Date.now()}`,
  object: 'response',
  status,
  output: [{ type: 'message', role: 'assistant', phase: 'final_answer', status, content: [{ type: 'output_text', text }] }],
  ...(usage ? { usage } : {}),
});
const failed = (code) => ({ status: 'failed', output: [], error: { code, message: 'mock' } });

async function api(method, path, subject, body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CHANNEL_KEY}`,
      'X-Recruitment-Subject': subject,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} ${res.status} ${data?.code ?? ''}`);
  return data;
}

/** Làm phần việc của model + plugin trong một lượt kênh. */
async function fakeModelTurn(sessionKey, input, { save, replyText }) {
  const [, oa, user] = SESSION.exec(sessionKey) || [];
  if (!oa) throw new Error('session key không phải kênh zalo');
  const subject = `zalo:${oa}:${user}`;
  const header = /^\[channel=ZALO sender=([^ \]]+) msg=([^ \]]+)\]\n/.exec(input);
  const msgId = header?.[2];
  const text = input.slice(header?.[0].length ?? 0);
  const found = await api('POST', 'candidates/find-or-create', subject, { source: 'ZALO' });
  const candidateId = found?.candidate?.id ?? found?.data?.candidate?.id;
  const reply = replyText || `Mock đã nhận tin ${msgId} (${text.length} ký tự).`;
  if (save) {
    const base = { candidateId, channel: 'ZALO', externalConversationId: 'ignored-by-subject' };
    await api('POST', 'conversations/message', subject, { ...base, senderType: 'CANDIDATE', direction: 'INBOUND', content: text, externalMessageId: msgId });
    await api('POST', 'conversations/message', subject, { ...base, senderType: 'AI', direction: 'OUTBOUND', content: reply, externalMessageId: `${msgId}-reply` });
  }
  return reply;
}

async function proxy(req, raw) {
  const res = await fetch(`${UPSTREAM}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: req.headers.authorization,
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': req.headers['x-openclaw-agent-id'],
      'x-openclaw-session-key': req.headers['x-openclaw-session-key'],
    },
    body: raw,
  });
  return { status: res.status, text: await res.text() };
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (req.url === '/__mode' && req.method === 'POST') {
    state = { delayMs: 0, drop: 0, ...JSON.parse(raw || '{}') };
    return json(res, 200, state);
  }
  if (req.url === '/__log') return json(res, 200, log);
  if (req.url === '/__reset') {
    log = [];
    return json(res, 200, { ok: true });
  }
  if (req.url !== '/v1/responses' || req.method !== 'POST') return json(res, 404, {});

  const sessionKey = String(req.headers['x-openclaw-session-key'] || '');
  let input = '';
  let instructions = '';
  try {
    const parsed = JSON.parse(raw);
    input = String(parsed.input || '');
    instructions = String(parsed.instructions || '');
  } catch {
    // ghi log với input rỗng
  }
  const entry = {
    t0: Date.now(),
    t1: null,
    mode: state.mode,
    sessionKey,
    msgId: /msg=([^ \]]+)\]/.exec(input)?.[1] ?? null,
    authOk: req.headers.authorization === `Bearer ${TOKEN}`,
    agentId: req.headers['x-openclaw-agent-id'] ?? null,
    // Tín hiệu hệ thống một lượt (vd. HR vừa trả hội thoại cho AI).
    resumeSignal: /Human takeover has ended/.test(instructions),
    result: null,
  };
  log.push(entry);
  const done = (result) => {
    entry.t1 = Date.now();
    entry.result = result;
  };
  const current = state;
  entry.mode = current.mode;
  const dropping = current.drop > 0;
  if (dropping) current.drop -= 1;
  if (typeof current.times === 'number' && --current.times <= 0) {
    state = { delayMs: 0, drop: 0, ...(current.then || { mode: 'ok' }) };
  }

  try {
    if (current.delayMs) await sleep(current.delayMs);
    switch (current.mode) {
      case 'ok':
      case 'ok-nosave':
      case 'ok-drop': {
        const reply = await fakeModelTurn(sessionKey, input, {
          save: current.mode !== 'ok-nosave',
          replyText: current.reply,
        });
        if (current.mode === 'ok-drop' && dropping) {
          done('dropped');
          return req.socket.destroy();
        }
        done('200');
        return json(res, 200, completed(reply, 'completed', current.usage));
      }
      case 'proxy':
      case 'proxy-drop': {
        const upstream = await proxy(req, raw);
        if (current.mode === 'proxy-drop' && dropping) {
          done(`dropped-after-${upstream.status}`);
          return req.socket.destroy();
        }
        done(String(upstream.status));
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        return res.end(upstream.text);
      }
      case 'hang':
        done('hang');
        return; // không bao giờ trả lời — worker phải timeout
      case 'quota':
        done('429-quota');
        return json(res, 429, failed('insufficient_quota'));
      case 'rate':
        done('429-rate');
        return json(res, 429, failed('rate_limit_error'));
      case 'billing402':
        done('402');
        return json(res, 402, failed('insufficient_quota'));
      case 'fallback':
        done('200-fallback');
        return json(res, 200, completed('No response from OpenClaw.'));
      case 'errortext':
        done('200-errortext');
        return json(res, 200, completed('⚠️ openai (gpt-5.6-terra) returned a billing error — | credit_balance_exhausted'));
      case 'incomplete':
        done('200-incomplete');
        return json(res, 200, completed('Câu trả lời bị cắt', 'incomplete'));
      default: {
        const status = Number(current.mode) || 500;
        done(String(status));
        return json(res, status, failed('api_error'));
      }
    }
  } catch (error) {
    done(`mock-error ${error.message}`);
    return json(res, 500, failed('api_error'));
  }
});

server.listen(PORT, () => console.log(`mock-openclaw listening :${PORT}`));
