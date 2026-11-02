import * as http from 'http';
import * as https from 'https';

import type { ZaloOutboundConfig } from './zalo-outbound.config';

/**
 * Transport HTTP cho Zalo OA tuyển dụng — phân biệt được tin **chắc chắn chưa đi**
 * với tin **có thể đã tới Zalo**, vì đó là ranh giới giữa "thử lại an toàn" và
 * "gửi lại có thể trùng":
 *
 * - lỗi trước khi kết nối TCP/TLS xong (từ chối, DNS, hết giờ kết nối) → `not-sent`
 * - đã kết nối (request đã/đang được ghi đi) rồi mất kết nối hoặc hết giờ chờ
 *   response → `maybe-sent`
 *
 * Mỗi request một socket riêng (`agent: false`) để trạng thái kết nối rõ ràng.
 * Không log, không trả header/token; body response cắt ở 64 KB.
 */
export type TransportOutcome =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'not-sent'; code: 'CONNECT_FAILED' | 'CONNECT_TIMEOUT' }
  | { kind: 'maybe-sent'; code: 'RESPONSE_TIMEOUT' | 'CONNECTION_LOST' };

const MAX_BODY = 64 * 1024;

export function postRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeouts: { connectTimeoutMs: number; responseTimeoutMs: number },
): Promise<TransportOutcome> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const payload = Buffer.from(body, 'utf8');
    let connected = false;
    let settled = false;
    let responseTimer: NodeJS.Timeout | undefined;
    const finish = (outcome: TransportOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      resolve(outcome);
    };

    const req = (secure ? https : http).request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, 'Content-Length': String(payload.length) },
      agent: false,
    });

    const connectTimer = setTimeout(() => {
      if (!connected) {
        finish({ kind: 'not-sent', code: 'CONNECT_TIMEOUT' });
        req.destroy();
      }
    }, timeouts.connectTimeoutMs);

    req.on('socket', (socket) => {
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        connected = true;
        clearTimeout(connectTimer);
        responseTimer = setTimeout(() => {
          finish({ kind: 'maybe-sent', code: 'RESPONSE_TIMEOUT' });
          req.destroy();
        }, timeouts.responseTimeoutMs);
      });
    });

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      res.on('end', () =>
        finish({
          kind: 'response',
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      // Đã có status nhưng body đứt giữa chừng: Zalo đã xử lý, không biết kết quả.
      res.on('aborted', () =>
        finish({ kind: 'maybe-sent', code: 'CONNECTION_LOST' }),
      );
      res.on('error', () =>
        finish({ kind: 'maybe-sent', code: 'CONNECTION_LOST' }),
      );
    });

    req.on('error', () =>
      finish(
        connected
          ? { kind: 'maybe-sent', code: 'CONNECTION_LOST' }
          : { kind: 'not-sent', code: 'CONNECT_FAILED' },
      ),
    );
    req.end(payload);
  });
}

export type SendClassification =
  | { result: 'SENT'; providerMessageId: string | null }
  /** Access token hỏng/hết hạn — refresh rồi gửi lại (Zalo đã từ chối, tin chưa đi). */
  | { result: 'TOKEN_INVALID'; code: string }
  /** Chắc chắn chưa gửi — thử lại an toàn. */
  | { result: 'RETRY'; code: string }
  /** Zalo từ chối (tin chưa đi); `permanent` = không bao giờ gửi được. */
  | { result: 'REJECTED'; code: string; permanent: boolean }
  /** Có thể đã gửi — không tự gửi lại. */
  | { result: 'UNKNOWN'; code: string };

/**
 * Phân loại kết quả Send API (`POST /v3.0/oa/message/cs`). Zalo trả HTTP 200 kèm
 * `{ error, message, data }`; `error = 0` là đã nhận tin. Mã lỗi khác 0 nghĩa là
 * Zalo đã xử lý và **từ chối** — tin chưa đi nên thử lại không gây trùng; ý nghĩa
 * từng mã lấy từ cấu hình (`permanentErrors`, `tokenErrors`), không đoán.
 */
export function classifySend(
  outcome: TransportOutcome,
  config: Pick<ZaloOutboundConfig, 'permanentErrors' | 'tokenErrors'>,
): SendClassification {
  if (outcome.kind === 'not-sent') {
    return {
      result: 'RETRY',
      code:
        outcome.code === 'CONNECT_TIMEOUT'
          ? 'CONNECT_TIMEOUT'
          : 'NETWORK_BEFORE_SEND',
    };
  }
  if (outcome.kind === 'maybe-sent') {
    return { result: 'UNKNOWN', code: outcome.code };
  }

  const { status } = outcome;
  if (status === 401 || status === 403) {
    return { result: 'TOKEN_INVALID', code: `HTTP_${status}` };
  }
  if (status === 429) return { result: 'RETRY', code: 'PROVIDER_RATE_LIMIT' };
  // 504: cổng phía trước Zalo hết giờ chờ — Zalo có thể đã xử lý.
  if (status === 504)
    return { result: 'UNKNOWN', code: 'PROVIDER_GATEWAY_TIMEOUT' };
  if (status >= 500) return { result: 'RETRY', code: 'PROVIDER_5XX' };
  if (status !== 200) {
    return {
      result: 'REJECTED',
      code: `PROVIDER_HTTP_${status}`,
      permanent: true,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(outcome.body);
  } catch {
    return { result: 'UNKNOWN', code: 'PROVIDER_UNPARSEABLE' };
  }
  const record =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : null;
  if (!record || typeof record.error !== 'number') {
    return { result: 'UNKNOWN', code: 'PROVIDER_UNPARSEABLE' };
  }
  if (record.error === 0) {
    const data = record.data as Record<string, unknown> | undefined;
    const id = data?.message_id;
    return {
      result: 'SENT',
      providerMessageId:
        typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    };
  }
  const code = `ZALO_${record.error}`;
  const message = typeof record.message === 'string' ? record.message : '';
  if (
    config.tokenErrors.has(record.error) ||
    /access[_ ]?token/i.test(message)
  ) {
    return { result: 'TOKEN_INVALID', code };
  }
  return {
    result: 'REJECTED',
    code,
    permanent: config.permanentErrors.has(record.error),
  };
}
