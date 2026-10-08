/**
 * Enum của module Tuyển dụng. Giá trị trùng tên khoá để lưu thẳng vào enum
 * Postgres (xem migration `CreateRecruitment1791800000000`) — đổi/thêm giá trị
 * ở đây thì phải đổi cả migration.
 */

export enum RecruitmentJobStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  CLOSED = 'CLOSED',
}

export enum EmploymentType {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
  CONTRACT = 'CONTRACT',
  INTERNSHIP = 'INTERNSHIP',
  COLLABORATOR = 'COLLABORATOR',
}

export enum CandidateSource {
  ZALO = 'ZALO',
  WEBSITE = 'WEBSITE',
  FACEBOOK = 'FACEBOOK',
  REFERRAL = 'REFERRAL',
  MANUAL = 'MANUAL',
  OTHER = 'OTHER',
}

export enum ApplicationStatus {
  NEW = 'NEW',
  COLLECTING_INFO = 'COLLECTING_INFO',
  SCREENING = 'SCREENING',
  QUALIFIED = 'QUALIFIED',
  NEEDS_HR_REVIEW = 'NEEDS_HR_REVIEW',
  INTERVIEW = 'INTERVIEW',
  OFFER = 'OFFER',
  HIRED = 'HIRED',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
}

/** Hồ sơ đã kết thúc — không ai chuyển tiếp được nữa. */
export const TERMINAL_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.HIRED,
  ApplicationStatus.REJECTED,
  ApplicationStatus.WITHDRAWN,
];

/** Hồ sơ không còn hiệu lực — ứng viên được nộp lại cùng vị trí. */
export const INACTIVE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.REJECTED,
  ApplicationStatus.WITHDRAWN,
];

export enum AiMatchLevel {
  HIGH_MATCH = 'HIGH_MATCH',
  MEDIUM_MATCH = 'MEDIUM_MATCH',
  LOW_MATCH = 'LOW_MATCH',
  INSUFFICIENT_DATA = 'INSUFFICIENT_DATA',
}

export enum RecommendedAction {
  PROPOSE_INTERVIEW = 'PROPOSE_INTERVIEW',
  HR_REVIEW = 'HR_REVIEW',
  HANDOFF_TO_HR = 'HANDOFF_TO_HR',
  COLLECT_MORE_INFO = 'COLLECT_MORE_INFO',
}

export enum ConversationChannel {
  ZALO = 'ZALO',
  WEB = 'WEB',
  FACEBOOK = 'FACEBOOK',
  OTHER = 'OTHER',
}

export enum ConversationStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
}

export enum MessageSenderType {
  CANDIDATE = 'CANDIDATE',
  AI = 'AI',
  HR = 'HR',
  SYSTEM = 'SYSTEM',
}

export enum MessageDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum MessageContentType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
  LINK = 'LINK',
  OTHER = 'OTHER',
}

export enum InterviewStatus {
  PROPOSED = 'PROPOSED',
  CONFIRMED = 'CONFIRMED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  NO_SHOW = 'NO_SHOW',
}

export enum HandoffReason {
  CANDIDATE_REQUESTED_HUMAN = 'CANDIDATE_REQUESTED_HUMAN',
  SALARY_OUT_OF_RANGE = 'SALARY_OUT_OF_RANGE',
  AI_UNCERTAIN = 'AI_UNCERTAIN',
  COMPLAINT = 'COMPLAINT',
  DATA_DELETION_REQUEST = 'DATA_DELETION_REQUEST',
  SPECIAL_CASE = 'SPECIAL_CASE',
  FINAL_DECISION_REQUIRED = 'FINAL_DECISION_REQUIRED',
  OTHER = 'OTHER',
}

export enum HandoffPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum HandoffStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  RETURNED_TO_AI = 'RETURNED_TO_AI',
}

/** Ai thực hiện thao tác: OpenClaw, người của phòng Nhân sự, hay hệ thống tự sinh. */
export enum RecruitmentActorType {
  AI = 'AI',
  HR = 'HR',
  SYSTEM = 'SYSTEM',
}

export enum IdempotencyStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

/** Kênh nhắn tin bên ngoài đẩy event vào (webhook). */
export enum ChannelEventChannel {
  ZALO = 'ZALO',
}

/**
 * Vòng đời một event webhook. Lúc nhận chỉ ghi `RECEIVED` (sẽ được xử lý) hoặc
 * `IGNORED` (hợp lệ nhưng không xử lý); worker sau này mới chuyển tiếp.
 */
export enum ChannelEventStatus {
  RECEIVED = 'RECEIVED',
  IGNORED = 'IGNORED',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

/**
 * Tin trả lời chờ gửi ra kênh (worker P3-4 tạo `PENDING`, sender P3-5 gửi).
 *
 * - `SENDING`: đã claim; `dispatched_at` có giá trị = request có thể đã tới Zalo.
 * - `RETRY`: chắc chắn CHƯA gửi được (429, 5xx, lỗi trước khi kết nối...) — thử lại.
 * - `UNKNOWN`: request có thể đã tới Zalo nhưng không biết kết quả — KHÔNG tự gửi
 *   lại (tránh trùng tin), chờ đối soát; chặn các tin sau của cùng người nhận.
 * - `DEAD_LETTER`: không bao giờ gửi (bị từ chối hẳn, dữ liệu sai, quá hạn).
 */
export enum ChannelOutboxStatus {
  PENDING = 'PENDING',
  SENDING = 'SENDING',
  SENT = 'SENT',
  RETRY = 'RETRY',
  UNKNOWN = 'UNKNOWN',
  DEAD_LETTER = 'DEAD_LETTER',
}
