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
  timeoutMs?: number;
}

export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
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
export const DEFAULT_BASE_URL_ENV = "RECRUITMENT_API_BASE_URL";
export const DEFAULT_TIMEOUT_MS = 15_000;

export function resolveConfig(
  config: PluginConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig | null {
  const baseUrl = (config?.baseUrl || env[DEFAULT_BASE_URL_ENV] || "").replace(/\/+$/, "");
  const apiKey = env[config?.apiKeyEnv || DEFAULT_API_KEY_ENV] || "";
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS };
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
