import { Type, type Static, type TSchema } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { callApi, resolveConfig, type ApiRequest, type PluginConfig } from "./client.js";

/**
 * Tool OpenClaw cho API tuyển dụng KIDO. Mỗi tool ánh xạ đúng một endpoint
 * `/recruitment/ai/*` (xem RECRUITMENT-AI-API.md). Tool không tự ra quyết
 * định: backend giữ state machine, chấm điểm và các ràng buộc.
 */

const Id = (description: string) => Type.Integer({ minimum: 1, description });
const Str = (maxLength: number, description: string) =>
  Type.String({ minLength: 1, maxLength, description });
const DateOnly = (description: string) =>
  Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description });
const Strict = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });

const Source = Type.Union(
  ["ZALO", "WEBSITE", "FACEBOOK", "REFERRAL", "MANUAL", "OTHER"].map((v) => Type.Literal(v)),
);

/** Mọi tool trả cùng một dạng — có cả biến thể lỗi để OpenClaw kiểm schema. */
const ApiResultSchema = Type.Union([
  Type.Object(
    { ok: Type.Literal(true), httpStatus: Type.Integer(), data: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ok: Type.Literal(false),
      httpStatus: Type.Integer(),
      error: Type.Object(
        { code: Type.String(), message: Type.String() },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

const CandidateProfile = {
  fullName: Type.Optional(Str(255, "Họ tên ứng viên")),
  phone: Type.Optional(Str(30, "Số điện thoại Việt Nam, vd 0901234567")),
  email: Type.Optional(Type.String({ format: "email", maxLength: 255 })),
  location: Type.Optional(Str(255, "Tỉnh/thành đang sống hoặc muốn làm việc")),
  education: Type.Optional(Str(500, "Trình độ học vấn")),
  experienceSummary: Type.Optional(Str(5000, "Tóm tắt kinh nghiệm làm việc")),
  totalExperienceMonths: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 600, description: "Tổng số tháng kinh nghiệm liên quan" }),
  ),
  currentJob: Type.Optional(Str(255, "Công việc hiện tại")),
  expectedSalary: Type.Optional(
    Type.Number({ minimum: 0, description: "Lương mong muốn (VND/tháng, hoặc VND/buổi với vị trí trả theo buổi)" }),
  ),
  availableFrom: Type.Optional(DateOnly("Ngày có thể bắt đầu đi làm, YYYY-MM-DD")),
  skills: Type.Optional(
    Type.Array(Str(100, "Kỹ năng"), {
      maxItems: 50,
      description: "Kỹ năng đã map về đúng từ trong requiredSkills/preferredSkills của vị trí",
    }),
  ),
  cvUrl: Type.Optional(Type.String({ format: "uri", maxLength: 1000, description: "Link CV (http/https)" })),
};

interface Endpoint<S extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: S;
  request: (params: Static<S>) => ApiRequest;
}

const endpoint = <S extends TSchema>(e: Endpoint<S>) => e;

export const ENDPOINTS = [
  endpoint({
    name: "recruitment_get_active_jobs",
    label: "Vị trí đang tuyển",
    description: "List ACTIVE job openings with screening criteria (skill vocabulary, locations, salary range).",
    parameters: Strict({}),
    request: () => ({ method: "GET", path: "jobs/active" }),
  }),
  endpoint({
    name: "recruitment_get_job",
    label: "Chi tiết vị trí",
    description: "Get one published job by id.",
    parameters: Strict({ jobId: Id("Job id") }),
    request: (p) => ({ method: "GET", path: `jobs/${p.jobId}` }),
  }),
  endpoint({
    name: "recruitment_find_or_create_candidate",
    label: "Nhận diện ứng viên",
    description:
      "Find the candidate by zaloUserId or create one. Phone/email matches only return outcome POSSIBLE_DUPLICATE (never another person's data); resend with confirmNewCandidate=true to create.",
    parameters: Strict({
      zaloUserId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$", description: "Sender id from the channel" })),
      phone: Type.Optional(Str(30, "Số điện thoại")),
      email: Type.Optional(Type.String({ format: "email", maxLength: 255 })),
      fullName: Type.Optional(Str(255, "Họ tên")),
      source: Type.Optional(Source),
      location: Type.Optional(Str(255, "Khu vực")),
      confirmNewCandidate: Type.Optional(Type.Boolean()),
    }),
    request: (p) => ({ method: "POST", path: "candidates/find-or-create", body: p }),
  }),
  endpoint({
    name: "recruitment_get_candidate",
    label: "Hồ sơ ứng viên",
    description: "Get the candidate profile.",
    parameters: Strict({ candidateId: Id("Candidate id") }),
    request: (p) => ({ method: "GET", path: `candidates/${p.candidateId}` }),
  }),
  endpoint({
    name: "recruitment_update_candidate",
    label: "Cập nhật ứng viên",
    description:
      "Save information the candidate gave you. Never include sensitive attributes (gender, age, religion, ethnicity, marital status, health, appearance, politics).",
    parameters: Strict({ candidateId: Id("Candidate id"), ...CandidateProfile }),
    request: ({ candidateId, ...body }) => ({ method: "PATCH", path: `candidates/${candidateId}`, body }),
  }),
  endpoint({
    name: "recruitment_request_data_deletion",
    label: "Yêu cầu xoá dữ liệu",
    description:
      "Candidate asks to delete their personal data and has no application yet. Stops AI processing for this candidate and alerts HR.",
    parameters: Strict({ candidateId: Id("Candidate id"), note: Type.Optional(Str(2000, "Ghi chú cho HR")) }),
    request: ({ candidateId, ...body }) => ({ method: "POST", path: `candidates/${candidateId}/deletion-request`, body }),
  }),
  endpoint({
    name: "recruitment_find_or_create_application",
    label: "Hồ sơ ứng tuyển",
    description: "Find or create the candidate's application for a job (idempotent).",
    parameters: Strict({ candidateId: Id("Candidate id"), jobId: Id("Job id"), source: Type.Optional(Source) }),
    request: (p) => ({ method: "POST", path: "applications/find-or-create", body: p }),
  }),
  endpoint({
    name: "recruitment_get_application_context",
    label: "Ngữ cảnh hồ sơ",
    description:
      "Structured context: candidate, job, application, missingFields, allowedActions, guidance, open handoffs, active interview, recent messages. Read before deciding what to do.",
    parameters: Strict({ applicationId: Id("Application id") }),
    request: (p) => ({ method: "GET", path: `applications/${p.applicationId}/context` }),
  }),
  endpoint({
    name: "recruitment_screen_candidate",
    label: "Sàng lọc",
    description:
      "Save collected data and let the backend score it deterministically. Returns score, matchLevel, strengths, concerns, missingInformation and recommendedAction. aiSummary is stored for HR only and does not affect the score.",
    parameters: Strict({
      applicationId: Id("Application id"),
      extractedSkills: CandidateProfile.skills,
      experienceSummary: CandidateProfile.experienceSummary,
      totalExperienceMonths: CandidateProfile.totalExperienceMonths,
      availableFrom: CandidateProfile.availableFrom,
      expectedSalary: CandidateProfile.expectedSalary,
      location: CandidateProfile.location,
      aiSummary: Type.Optional(Str(5000, "Tóm tắt khách quan cho HR")),
    }),
    request: ({ applicationId, ...body }) => ({ method: "POST", path: `applications/${applicationId}/screen`, body }),
  }),
  endpoint({
    name: "recruitment_handoff_to_hr",
    label: "Chuyển HR",
    description:
      "Stop and hand the application to a human recruiter. After this the AI may only save messages and tell the candidate HR will contact them.",
    parameters: Strict({
      applicationId: Id("Application id"),
      reason: Type.Union(
        [
          "CANDIDATE_REQUESTED_HUMAN",
          "SALARY_OUT_OF_RANGE",
          "AI_UNCERTAIN",
          "COMPLAINT",
          "DATA_DELETION_REQUEST",
          "SPECIAL_CASE",
          "FINAL_DECISION_REQUIRED",
          "OTHER",
        ].map((v) => Type.Literal(v)),
      ),
      summary: Str(2000, "Tóm tắt 1–3 câu cho HR, không chứa thuộc tính nhạy cảm"),
      priority: Type.Optional(Type.Union(["LOW", "NORMAL", "HIGH", "URGENT"].map((v) => Type.Literal(v)))),
    }),
    request: ({ applicationId, ...body }) => ({ method: "POST", path: `applications/${applicationId}/handoff`, body }),
  }),
  endpoint({
    name: "recruitment_save_message",
    label: "Lưu tin nhắn",
    description:
      "Store one chat message (candidate INBOUND or your OUTBOUND reply). Idempotent by externalMessageId. Always allowed, even after handoff.",
    parameters: Strict({
      candidateId: Id("Candidate id"),
      applicationId: Type.Optional(Id("Application id")),
      channel: Type.Union(["ZALO", "WEB", "FACEBOOK", "OTHER"].map((v) => Type.Literal(v))),
      externalConversationId: Type.Optional(Str(255, "Conversation id on the channel (use the sender id)")),
      externalMessageId: Type.Optional(Str(255, "Message id on the channel")),
      senderType: Type.Union(["CANDIDATE", "AI"].map((v) => Type.Literal(v))),
      direction: Type.Union(["INBOUND", "OUTBOUND"].map((v) => Type.Literal(v))),
      content: Str(10000, "Message text"),
    }),
    request: (p) => ({ method: "POST", path: "conversations/message", body: { ...p, contentType: "TEXT" } }),
  }),
  endpoint({
    name: "recruitment_get_conversation_context",
    label: "Ngữ cảnh hội thoại",
    description: "Structured context for a conversation (same shape as application context).",
    parameters: Strict({ conversationId: Id("Conversation id") }),
    request: (p) => ({ method: "GET", path: `conversations/${p.conversationId}/context` }),
  }),
  endpoint({
    name: "recruitment_get_interview_slots",
    label: "Khung giờ phỏng vấn",
    description: "Interview slots HR opened for the job (future, with free capacity). Only offer these times.",
    parameters: Strict({
      jobId: Id("Job id"),
      from: Type.Optional(Type.String({ format: "date-time" })),
      to: Type.Optional(Type.String({ format: "date-time" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    request: (p) => ({ method: "GET", path: "interview-slots", query: p }),
  }),
  endpoint({
    name: "recruitment_propose_interview",
    label: "Đề xuất phỏng vấn",
    description: "Reserve an HR-opened slot for a QUALIFIED application (status PROPOSED until the candidate confirms).",
    parameters: Strict({
      applicationId: Id("Application id"),
      slotId: Id("Slot id from recruitment_get_interview_slots"),
      note: Type.Optional(Str(1000, "Ghi chú")),
    }),
    request: (p) => ({ method: "POST", path: "interviews/propose", body: p, idempotent: true }),
  }),
  endpoint({
    name: "recruitment_confirm_interview",
    label: "Xác nhận phỏng vấn",
    description: "The candidate explicitly confirmed the proposed interview time.",
    parameters: Strict({ interviewId: Id("Interview id") }),
    request: (p) => ({ method: "POST", path: `interviews/${p.interviewId}/confirm` }),
  }),
];

export const TOOL_NAMES = ENDPOINTS.map((e) => e.name);

export default defineToolPlugin({
  id: "kido-recruitment",
  name: "KIDO Recruitment",
  description: "Tools for the KIDO recruitment API used by the AI recruiter.",
  configSchema: Type.Object({
    baseUrl: Type.Optional(Type.String({ description: "API base URL, e.g. http://staging-api:3021" })),
    apiKeyEnv: Type.Optional(Type.String({ description: "Name of the env var holding the API key (default RECRUITMENT_AI_API_KEY)" })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000 })),
  }),
  tools: (tool) =>
    ENDPOINTS.map((e) =>
      tool({
        name: e.name,
        label: e.label,
        description: e.description,
        parameters: e.parameters,
        outputSchema: ApiResultSchema,
        execute: (params, config, context) =>
          callApi(
            resolveConfig(config as PluginConfig),
            (e.request as (p: unknown) => ApiRequest)(params),
            context?.signal,
          ),
      }),
    ),
});
