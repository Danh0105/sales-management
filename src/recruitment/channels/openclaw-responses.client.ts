/**
 * Client gọi OpenClaw `POST /v1/responses` cho **một lượt** của ứng viên.
 *
 * Danh tính đi bằng header `x-openclaw-session-key` do worker dựng từ DB (OA +
 * người gửi) — không lấy từ model hay request bên ngoài. Gateway token chỉ có ở
 * worker. Plugin `kido-recruitment` đọc session key này để gắn subject cho API AI.
 *
 * `classifyOpenClawResponse` thuần để test được từng nhánh: chỉ một câu trả lời
 * `completed` có text thật mới là thành công; mọi thứ khác (429 hết quota, 5xx,
 * timeout, text dự phòng "No response from OpenClaw.", text lỗi "⚠️ ...") đều
 * KHÔNG được coi là xử lý xong.
 */

export interface OpenClawClientConfig {
  /** Gốc gateway, vd. `http://openclaw-gateway:18789` (không có `/v1/responses`). */
  url: string;
  token: string;
  agentId: string;
  timeoutMs: number;
}

/**
 * - `infra`: gateway/mạng/xác thực — thử lại tới hết hạn giữ nội dung.
 * - `provider`: OpenAI giới hạn tốc độ / hết quota — thử lại, giãn cách dài hơn.
 * - `agent`: lượt chạy xong nhưng kết quả không dùng được — thử lại có giới hạn.
 * - `rejected`: gateway từ chối request (4xx) — thử lại vô ích.
 */
export type AgentFailureKind = 'infra' | 'provider' | 'agent' | 'rejected';

export type AgentOutcome =
  | { ok: true; text: string; responseId: string | null }
  | {
      ok: false;
      code: string;
      kind: AgentFailureKind;
      httpStatus: number | null;
    };

/** Text gateway tự chèn khi model không trả lời gì (`openresponses-http`). */
export const OPENCLAW_EMPTY_REPLY_TEXT = 'No response from OpenClaw.';

/** Lỗi do OpenClaw tự viết thành câu trả lời (vd. "⚠️ openai ... billing error"). */
const OPENCLAW_ERROR_TEXT = /^\s*⚠️/u;

export async function invokeOpenClaw(
  config: OpenClawClientConfig,
  request: { sessionKey: string; input: string; instructions?: string },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<AgentOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl(
      `${config.url.replace(/\/+$/, '')}/v1/responses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
          'x-openclaw-agent-id': config.agentId,
          'x-openclaw-session-key': request.sessionKey,
        },
        body: JSON.stringify({
          model: `openclaw/${config.agentId}`,
          input: request.input,
          // Tín hiệu hệ thống một lượt (vd. HR vừa trả hội thoại) — gateway gộp vào system prompt.
          ...(request.instructions
            ? { instructions: request.instructions }
            : {}),
        }),
        signal,
      },
    );
    const raw = await response.text();
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
  } catch {
    // Không phân biệt chi tiết lỗi mạng trong log — chỉ mã.
    return timeout.aborted
      ? { ok: false, code: 'AGENT_TIMEOUT', kind: 'infra', httpStatus: null }
      : {
          ok: false,
          code: options.signal?.aborted ? 'AGENT_ABORTED' : 'AGENT_UNAVAILABLE',
          kind: 'infra',
          httpStatus: null,
        };
  }
  return classifyOpenClawResponse(response.status, body);
}

export function classifyOpenClawResponse(
  httpStatus: number,
  body: unknown,
): AgentOutcome {
  const fail = (code: string, kind: AgentFailureKind): AgentOutcome => ({
    ok: false,
    code,
    kind,
    httpStatus,
  });
  const record = isRecord(body) ? body : null;
  const error = isRecord(record?.error) ? record.error : null;
  const errorType =
    typeof error?.code === 'string'
      ? error.code
      : typeof error?.type === 'string'
        ? error.type
        : '';

  if (httpStatus !== 200) {
    if (errorType === 'insufficient_quota' || httpStatus === 402) {
      return fail('PROVIDER_QUOTA', 'provider');
    }
    if (httpStatus === 429) return fail('PROVIDER_RATE_LIMIT', 'provider');
    if (httpStatus === 401 || httpStatus === 403) {
      return fail('AGENT_AUTH', 'infra');
    }
    if (httpStatus === 408 || httpStatus >= 500) {
      return fail(
        httpStatus === 504 ? 'AGENT_TIMEOUT' : 'AGENT_UNAVAILABLE',
        'infra',
      );
    }
    return fail('AGENT_REJECTED', 'rejected');
  }

  if (!record) return fail('AGENT_UNEXPECTED_OUTPUT', 'agent');
  if (record.status === 'incomplete') return fail('AGENT_INCOMPLETE', 'agent');
  if (record.status !== 'completed' || record.error) {
    return fail('AGENT_FAILED', 'agent');
  }

  const output = Array.isArray(record.output) ? record.output : [];
  // Worker không khai client tool nào — có function_call là bất thường.
  if (output.some((item) => isRecord(item) && item.type !== 'message')) {
    return fail('AGENT_UNEXPECTED_OUTPUT', 'agent');
  }
  const text = output
    .flatMap((item): unknown[] =>
      isRecord(item) && item.role === 'assistant' && Array.isArray(item.content)
        ? (item.content as unknown[])
        : [],
    )
    .flatMap((part) =>
      isRecord(part) &&
      part.type === 'output_text' &&
      typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n\n')
    .trim();

  if (!text || text === OPENCLAW_EMPTY_REPLY_TEXT) {
    return fail('AGENT_EMPTY_REPLY', 'agent');
  }
  if (OPENCLAW_ERROR_TEXT.test(text)) return fail('AGENT_ERROR_TEXT', 'agent');

  return {
    ok: true,
    text,
    responseId: typeof record.id === 'string' ? record.id : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
