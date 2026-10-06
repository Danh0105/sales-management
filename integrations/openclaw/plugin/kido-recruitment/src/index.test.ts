import { describe, expect, it, vi } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

import entry, { ENDPOINTS, TOOL_NAMES } from "./index.js";
import { callApi, resolveConfig } from "./client.js";

const KEY = "k".repeat(64);
const config = { baseUrl: "http://staging-api:3021/", apiKey: KEY, timeoutMs: 1000 };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("kido-recruitment metadata", () => {
  it("khai đủ 15 tool, mỗi tool một endpoint /recruitment/ai/*", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(TOOL_NAMES).toEqual([
      "recruitment_get_active_jobs",
      "recruitment_get_job",
      "recruitment_find_or_create_candidate",
      "recruitment_get_candidate",
      "recruitment_update_candidate",
      "recruitment_request_data_deletion",
      "recruitment_find_or_create_application",
      "recruitment_get_application_context",
      "recruitment_screen_candidate",
      "recruitment_handoff_to_hr",
      "recruitment_save_message",
      "recruitment_get_conversation_context",
      "recruitment_get_interview_slots",
      "recruitment_propose_interview",
      "recruitment_confirm_interview",
    ]);
  });

  it("chỉ propose interview gửi Idempotency-Key; path param nằm trong URL, không trong body", () => {
    const byName = Object.fromEntries(ENDPOINTS.map((e) => [e.name, e]));
    const req = (name: string, params: unknown) =>
      (byName[name].request as (p: unknown) => ReturnType<(typeof ENDPOINTS)[0]["request"]>)(params);

    expect(req("recruitment_propose_interview", { applicationId: 12, slotId: 3 })).toMatchObject({
      method: "POST",
      path: "interviews/propose",
      idempotent: true,
    });
    expect(req("recruitment_update_candidate", { candidateId: 7, phone: "0901234567" })).toEqual({
      method: "PATCH",
      path: "candidates/7",
      body: { phone: "0901234567" },
    });
    expect(req("recruitment_screen_candidate", { applicationId: 12, totalExperienceMonths: 24 })).toEqual({
      method: "POST",
      path: "applications/12/screen",
      body: { totalExperienceMonths: 24 },
    });
    const others = ENDPOINTS.filter((e) => e.name !== "recruitment_propose_interview");
    for (const e of others) {
      expect((e.request as (p: unknown) => { idempotent?: boolean })({ jobId: 1, candidateId: 1, applicationId: 1, conversationId: 1, interviewId: 1 }).idempotent).toBeFalsy();
    }
  });
});

describe("resolveConfig", () => {
  it("lấy key từ biến môi trường, không từ config", () => {
    expect(resolveConfig({ baseUrl: "http://x:1/" }, { RECRUITMENT_AI_API_KEY: KEY })).toEqual({
      baseUrl: "http://x:1",
      apiKey: KEY,
      timeoutMs: 15000,
    });
    expect(resolveConfig({ apiKeyEnv: "OTHER_KEY" }, { RECRUITMENT_API_BASE_URL: "http://y", OTHER_KEY: KEY })?.baseUrl).toBe("http://y");
    expect(resolveConfig({}, {})).toBeNull();
  });
});

describe("callApi", () => {
  it("gắn Bearer, bọc dữ liệu vào data (không để status của API ở cấp trên cùng)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "QUALIFIED", score: 100 }));
    const result = await callApi(config, { method: "GET", path: "applications/12/context" }, undefined, fetchImpl);

    expect(result).toEqual({ ok: true, httpStatus: 200, data: { status: "QUALIFIED", score: 100 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://staging-api:3021/recruitment/ai/applications/12/context");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("lỗi nghiệp vụ → ok:false với code/message của API", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { code: "AI_PAUSED_FOR_HR", message: "Hồ sơ đã chuyển HR" }),
    );
    const result = await callApi(config, { method: "POST", path: "applications/12/screen", body: {} }, undefined, fetchImpl);
    expect(result).toEqual({
      ok: false,
      httpStatus: 409,
      error: { code: "AI_PAUSED_FOR_HR", message: "Hồ sơ đã chuyển HR" },
    });
  });

  it("lỗi validation dạng mảng → VALIDATION_ERROR, message nối lại", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { message: ["property gender should not exist"], error: "Bad Request", statusCode: 400 }),
    );
    const result = await callApi(config, { method: "PATCH", path: "candidates/7", body: { gender: "x" } }, undefined, fetchImpl);
    expect(result).toEqual({
      ok: false,
      httpStatus: 400,
      error: { code: "VALIDATION_ERROR", message: "property gender should not exist" },
    });
  });

  it("lỗi mạng → thử lại 1 lần với CÙNG Idempotency-Key", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { interview: { id: 70 } }));
    const result = await callApi(
      config,
      { method: "POST", path: "interviews/propose", body: { applicationId: 12, slotId: 3 }, idempotent: true },
      undefined,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toMatchObject({ ok: true, data: { interview: { id: 70 } } });
    const keys = fetchImpl.mock.calls.map(
      ([, init]) => ((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^openclaw-[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("hết lượt thử → NETWORK_ERROR, không lộ API key", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError(`connect failed ${KEY}`));
    const result = await callApi(config, { method: "GET", path: "jobs/active" }, undefined, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, httpStatus: 0, error: { code: "NETWORK_ERROR" } });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("chưa cấu hình → PLUGIN_NOT_CONFIGURED, không gọi mạng", async () => {
    const fetchImpl = vi.fn();
    const result = await callApi(null, { method: "GET", path: "jobs/active" }, undefined, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, error: { code: "PLUGIN_NOT_CONFIGURED" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bỏ khoá undefined khỏi body (API bật forbidNonWhitelisted)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await callApi(config, { method: "PATCH", path: "candidates/7", body: { phone: "0901", email: undefined } }, undefined, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ phone: "0901" });
  });
});
