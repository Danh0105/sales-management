import { randomUUID } from "node:crypto";

/**
 * HTTP client cho API tuyển dụng dành cho AI (`/recruitment/ai/*`).
 *
 * Kết quả luôn là `{ ok, httpStatus, data | error }` thay vì ném lỗi: model
 * cần đọc `error.code` để rẽ nhánh (AI_PAUSED_FOR_HR, SLOT_UNAVAILABLE...).
 * Không đặt dữ liệu API ở cấp trên cùng — OpenClaw coi `status`/`ok`/`error`
 * ở cấp đó là trạng thái của lời gọi tool, mà API trả nhiều trường `status`.
 *
 * API key **không bao giờ** xuất hiện trong kết quả hay thông báo lỗi.
 */

export interface PluginConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Biến môi trường chứa key của kênh tin cậy (mặc định RECRUITMENT_CHANNEL_API_KEY). */
  channelApiKeyEnv?: string;
  timeoutMs?: number;
}

export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /** Danh tính kênh do session (adapter) gắn — có thì gửi header subject + key kênh. */
  subject?: string;
}

export type ApiResult =
  | { ok: true; httpStatus: number; data: unknown }
  | { ok: false; httpStatus: number; error: { code: string; message: string } };

export interface ApiRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  /** Thêm header `Idempotency-Key` (bắt buộc với propose interview). */
  idempotent?: boolean;
}

export const DEFAULT_API_KEY_ENV = "RECRUITMENT_AI_API_KEY";
export const DEFAULT_CHANNEL_API_KEY_ENV = "RECRUITMENT_CHANNEL_API_KEY";
export const SUBJECT_HEADER = "X-Recruitment-Subject";

/**
 * Session do adapter Zalo tạo: `agent:<agentId>:zalo:<oaId>:<zaloUserId>`.
 * Model không đặt được session key — đây là nguồn danh tính tin cậy duy nhất.
 */
const CHANNEL_SESSION = /^agent:[^:]+:zalo:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,100})$/;

export function channelSubject(sessionKey: string | undefined | null): string | null {
  const match = sessionKey ? CHANNEL_SESSION.exec(sessionKey) : null;
  return match ? `zalo:${match[1]}:${match[2]}` : null;
}
export const DEFAULT_BASE_URL_ENV = "RECRUITMENT_API_BASE_URL";
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Session của kênh → key kênh + subject (thiếu key kênh thì `null`, **không**
 * quay về key chung: request không subject sẽ bỏ qua ranh giới danh tính).
 * Session khác (harness, tools.invoke) → key AI chung, không subject.
 */
export function resolveConfig(
  config: PluginConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  sessionKey?: string | null,
): ResolvedConfig | null {
  const baseUrl = (config?.baseUrl || env[DEFAULT_BASE_URL_ENV] || "").replace(/\/+$/, "");
  const subject = channelSubject(sessionKey);
  const apiKey = subject
    ? env[config?.channelApiKeyEnv || DEFAULT_CHANNEL_API_KEY_ENV] || ""
    : env[config?.apiKeyEnv || DEFAULT_API_KEY_ENV] || "";
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(subject ? { subject } : {}),
  };
}

function buildUrl(baseUrl: string, req: ApiRequest): string {
  const base = baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/recruitment/ai/${req.path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Bỏ các khoá `undefined` để body khớp `forbidNonWhitelisted` của API. */
function cleanBody(body: Record<string, unknown> | undefined) {
  if (!body) return undefined;
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

function errorFrom(httpStatus: number, body: unknown): ApiResult {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rawMessage = record.message;
  const message = Array.isArray(rawMessage)
    ? rawMessage.map(String).join("; ")
    : typeof rawMessage === "string"
      ? rawMessage
      : `HTTP ${httpStatus}`;
  const code =
    typeof record.code === "string"
      ? record.code
      : httpStatus === 400
        ? "VALIDATION_ERROR"
        : `HTTP_${httpStatus}`;
  return { ok: false, httpStatus, error: { code, message } };
}

/**
 * Một dòng log cho mỗi lời gọi tool, để đối chiếu hội thoại với đúng thứ tự tool
 * đã gọi (scripts/simulate-conversation.sh đọc dòng `kido-trace` từ log gateway).
 * Chỉ ghi tên tool, method, đường dẫn (chỉ chứa id nội bộ) và kết quả — không
 * ghi body, query, API key hay nội dung ứng viên.
 */
export function traceLine(
  tool: string,
  toolCallId: string | undefined,
  req: ApiRequest,
  result: ApiResult,
  ms: number,
  mode: "channel" | "ai" = "ai",
): string {
  return `kido-trace ${JSON.stringify({
    tool,
    mode,
    call: toolCallId ?? null,
    method: req.method,
    path: req.path,
    httpStatus: result.httpStatus,
    ok: result.ok,
    code: result.ok ? null : result.error.code,
    ms,
  })}`;
}

export async function callApi(
  config: ResolvedConfig | null,
  req: ApiRequest,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiResult> {
  if (!config) {
    return {
      ok: false,
      httpStatus: 0,
      error: {
        code: "PLUGIN_NOT_CONFIGURED",
        message: "Plugin kido-recruitment chưa có baseUrl hoặc API key",
      },
    };
  }

  const url = buildUrl(config.baseUrl, req);
  const body = cleanBody(req.body);
  // Sinh một lần và dùng lại khi thử lại: retry không được tạo thêm lịch.
  const idempotencyKey = req.idempotent ? `openclaw-${randomUUID()}` : undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (config.subject) headers[SUBJECT_HEADER] = config.subject;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetchImpl(url, {
        method: req.method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: combined,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { message: text.slice(0, 500) };
      }
      return res.ok
        ? { ok: true, httpStatus: res.status, data: parsed }
        : errorFrom(res.status, parsed);
    } catch (error) {
      lastError = error;
      // Người gọi huỷ thì dừng ngay; lỗi mạng/timeout thì thử lại 1 lần.
      if (signal?.aborted) break;
    }
  }

  const timedOut = (lastError as { name?: string } | undefined)?.name === "TimeoutError";
  return {
    ok: false,
    httpStatus: 0,
    error: {
      code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      message: timedOut
        ? "API tuyển dụng không phản hồi kịp"
        : "Không kết nối được API tuyển dụng",
    },
  };
}
