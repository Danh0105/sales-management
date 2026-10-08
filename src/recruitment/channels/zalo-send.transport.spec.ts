import * as http from 'http';
import type { AddressInfo } from 'net';

import {
  classifySend,
  postRequest,
  type TransportOutcome,
} from './zalo-send.transport';

const TIMEOUTS = { connectTimeoutMs: 1000, responseTimeoutMs: 300 };
const CODES = {
  permanentErrors: new Set([-213]),
  tokenErrors: new Set([-216]),
};

/** Server HTTP thật trên localhost — hành vi do từng test quyết định. */
async function withServer(
  handler: http.RequestListener,
  run: (url: string) => Promise<void>,
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v3.0/oa/message/cs`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('postRequest — ranh giới "chưa gửi" / "có thể đã gửi"', () => {
  it('server trả lời → response kèm status/body; header token tới đúng server', async () => {
    let seen: http.IncomingHttpHeaders = {};
    await withServer(
      (req, res) => {
        seen = req.headers;
        res.end('{"error":0,"data":{"message_id":"m1"}}');
      },
      async (url) => {
        await expect(
          postRequest(url, { access_token: 'tok' }, '{}', TIMEOUTS),
        ).resolves.toEqual({
          kind: 'response',
          status: 200,
          body: '{"error":0,"data":{"message_id":"m1"}}',
        });
      },
    );
    expect(seen.access_token).toBe('tok');
  });

  it('cổng không mở (từ chối kết nối) → not-sent: chắc chắn chưa đi', async () => {
    let port = 0;
    await withServer(
      (_req, res) => res.end(),
      (url) => {
        port = Number(new URL(url).port);
        return Promise.resolve();
      },
    );
    await expect(
      postRequest(`http://127.0.0.1:${port}/x`, {}, '{}', TIMEOUTS),
    ).resolves.toEqual({ kind: 'not-sent', code: 'CONNECT_FAILED' });
  });

  it('đã kết nối, server nhận request nhưng không trả lời → maybe-sent (RESPONSE_TIMEOUT)', async () => {
    let received = false;
    await withServer(
      (req) => {
        req.resume();
        req.on('end', () => (received = true));
      },
      async (url) => {
        await expect(
          postRequest(url, {}, '{"a":1}', TIMEOUTS),
        ).resolves.toEqual({
          kind: 'maybe-sent',
          code: 'RESPONSE_TIMEOUT',
        });
      },
    );
    expect(received).toBe(true);
  });

  it('server nhận request rồi cắt kết nối → maybe-sent (CONNECTION_LOST)', async () => {
    await withServer(
      (req) => {
        req.resume();
        req.on('end', () => req.socket.destroy());
      },
      async (url) => {
        await expect(postRequest(url, {}, '{}', TIMEOUTS)).resolves.toEqual({
          kind: 'maybe-sent',
          code: 'CONNECTION_LOST',
        });
      },
    );
  });
});

describe('classifySend', () => {
  const response = (status: number, body: unknown): TransportOutcome => ({
    kind: 'response',
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  it.each<[string, TransportOutcome, unknown]>([
    [
      '200 error=0 → SENT + message_id',
      response(200, {
        error: 0,
        message: 'Success',
        data: { message_id: 'abc' },
      }),
      { result: 'SENT', providerMessageId: 'abc' },
    ],
    [
      'lỗi trước khi kết nối → RETRY',
      { kind: 'not-sent', code: 'CONNECT_FAILED' },
      { result: 'RETRY', code: 'NETWORK_BEFORE_SEND' },
    ],
    [
      'hết giờ kết nối → RETRY',
      { kind: 'not-sent', code: 'CONNECT_TIMEOUT' },
      { result: 'RETRY', code: 'CONNECT_TIMEOUT' },
    ],
    [
      'hết giờ sau khi gửi → UNKNOWN',
      { kind: 'maybe-sent', code: 'RESPONSE_TIMEOUT' },
      { result: 'UNKNOWN', code: 'RESPONSE_TIMEOUT' },
    ],
    [
      'mất kết nối sau khi gửi → UNKNOWN',
      { kind: 'maybe-sent', code: 'CONNECTION_LOST' },
      { result: 'UNKNOWN', code: 'CONNECTION_LOST' },
    ],
    [
      '429 → RETRY',
      response(429, ''),
      { result: 'RETRY', code: 'PROVIDER_RATE_LIMIT' },
    ],
    [
      '500 → RETRY',
      response(500, ''),
      { result: 'RETRY', code: 'PROVIDER_5XX' },
    ],
    [
      '503 → RETRY',
      response(503, ''),
      { result: 'RETRY', code: 'PROVIDER_5XX' },
    ],
    [
      '504 (cổng hết giờ, Zalo có thể đã xử lý) → UNKNOWN',
      response(504, ''),
      { result: 'UNKNOWN', code: 'PROVIDER_GATEWAY_TIMEOUT' },
    ],
    [
      '401 → TOKEN_INVALID',
      response(401, ''),
      { result: 'TOKEN_INVALID', code: 'HTTP_401' },
    ],
    [
      'mã token cấu hình (-216) → TOKEN_INVALID',
      response(200, { error: -216, message: 'x' }),
      { result: 'TOKEN_INVALID', code: 'ZALO_-216' },
    ],
    [
      'message nói access token hỏng → TOKEN_INVALID',
      response(200, { error: -999, message: 'Access token is invalid' }),
      { result: 'TOKEN_INVALID', code: 'ZALO_-999' },
    ],
    [
      'mã vĩnh viễn cấu hình → REJECTED permanent',
      response(200, { error: -213, message: 'x' }),
      { result: 'REJECTED', code: 'ZALO_-213', permanent: true },
    ],
    [
      'mã chưa phân loại → REJECTED (thử lại có giới hạn)',
      response(200, { error: -230, message: 'x' }),
      { result: 'REJECTED', code: 'ZALO_-230', permanent: false },
    ],
    [
      '400 → REJECTED permanent',
      response(400, ''),
      { result: 'REJECTED', code: 'PROVIDER_HTTP_400', permanent: true },
    ],
    [
      '200 nhưng không phải JSON → UNKNOWN',
      response(200, '<html>'),
      { result: 'UNKNOWN', code: 'PROVIDER_UNPARSEABLE' },
    ],
    [
      '200 JSON thiếu error → UNKNOWN',
      response(200, { ok: true }),
      { result: 'UNKNOWN', code: 'PROVIDER_UNPARSEABLE' },
    ],
  ])('%s', (_name, outcome, expected) => {
    expect(classifySend(outcome, CODES)).toEqual(expected);
  });
});
