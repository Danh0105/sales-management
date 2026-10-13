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
 * Request webhook nhận ở chế độ cách ly (P3-7.2A — chưa có OA secret key):
 * - `QUARANTINED`: đã ghi (thân request mã hoá), CHƯA xác minh chữ ký, không xử lý;
 * - `VERIFIED`: chữ ký khớp khi có key → đã đưa vào inbox như event thường;
 * - `REJECTED`: chữ ký/nội dung không hợp lệ khi xác minh → đã xoá nội dung;
 * - `EXPIRED`: quá hạn giữ (72 giờ) chưa xác minh → đã xoá nội dung.
 */
export enum ChannelQuarantineStatus {
  QUARANTINED = 'QUARANTINED',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
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
 * Lý do người vận hành loại một event inbox khỏi xử lý nghiệp vụ — ghi vào `failure_code`
 * của event `IGNORED` (phân biệt với `IGNORED` do loại event không hỗ trợ: `failure_code` NULL).
 */
export enum ChannelEventExcludeReason {
  /** Tin thử nội bộ (vd. gửi trong lúc nghiệm thu webhook, trước khi bật worker). */
  TEST_MESSAGE = 'TEST_MESSAGE',
}

/**
 * Tin trả lời chờ gửi ra kênh (worker P3-4 tạo `PENDING`, sender P3-5 gửi).
 *
 * - `SENDING`: đã claim; `dispatched_at` có giá trị = request có thể đã tới Zalo.
 * - `RETRY`: chắc chắn CHƯA gửi được (429, 5xx, lỗi trước khi kết nối...) — thử lại.
 * - `UNKNOWN`: request có thể đã tới Zalo nhưng không biết kết quả — KHÔNG tự gửi
 *   lại (tránh trùng tin), chờ đối soát; chặn các tin sau của cùng người nhận.
 * - `DEAD_LETTER`: không bao giờ gửi (bị từ chối hẳn, dữ liệu sai, quá hạn).
 * - `SUPPRESSED`: tin AI bị chặn ngay trước khi gửi vì HR đã đổi điều khiển hội
 *   thoại (tiếp quản / đóng / đổi version) sau khi tin được xếp hàng — chưa từng
 *   mở kết nối; không gửi lại, không chặn hàng (P3-6.5).
 */
export enum ChannelOutboxStatus {
  PENDING = 'PENDING',
  SENDING = 'SENDING',
  SENT = 'SENT',
  RETRY = 'RETRY',
  UNKNOWN = 'UNKNOWN',
  DEAD_LETTER = 'DEAD_LETTER',
  SUPPRESSED = 'SUPPRESSED',
}

/**
 * Chế độ điều khiển hội thoại do **HR chọn tường minh** (lưu trên hội thoại).
 * `AI_PAUSED` KHÔNG lưu ở đây — nó suy ra từ nguồn sự thật đã có (handoff đang mở,
 * hồ sơ `aiPaused`/`NEEDS_HR_REVIEW`, ứng viên dừng AI) để không có state machine
 * thứ hai cạnh tranh với handoff/hồ sơ.
 */
export enum ConversationControlMode {
  AI_ACTIVE = 'AI_ACTIVE',
  HUMAN_TAKEOVER = 'HUMAN_TAKEOVER',
  CLOSED = 'CLOSED',
}

/** Trạng thái điều khiển hiệu lực (API trả về, worker dựa vào đó). */
export enum ConversationControlState {
  AI_ACTIVE = 'AI_ACTIVE',
  AI_PAUSED = 'AI_PAUSED',
  HUMAN_TAKEOVER = 'HUMAN_TAKEOVER',
  CLOSED = 'CLOSED',
}

/** Nguồn của tin đi trong outbox. */
export enum OutboxSourceType {
  AI_REPLY = 'AI_REPLY',
  HR_MESSAGE = 'HR_MESSAGE',
}

/** Thao tác đối soát dòng outbox `UNKNOWN` của người vận hành. */
export enum OutboxResolution {
  MARK_SENT = 'MARK_SENT',
  RETRY = 'RETRY',
  DEAD_LETTER = 'DEAD_LETTER',
}

/** Worker đã làm gì với một tin đến. */
export enum ChannelEventAiDecision {
  AI_REPLIED = 'AI_REPLIED',
  SKIPPED_AI_PAUSED = 'SKIPPED_AI_PAUSED',
  SKIPPED_HUMAN_TAKEOVER = 'SKIPPED_HUMAN_TAKEOVER',
  SKIPPED_CLOSED = 'SKIPPED_CLOSED',
  /** HR đổi chế độ điều khiển trong lúc OpenClaw đang chạy — bỏ câu trả lời của AI. */
  DISCARDED_CONTROL_CHANGED = 'DISCARDED_CONTROL_CHANGED',
  /** Người gửi vượt trần lượt AI (giờ / ngày) — không gọi AI, HR trả lời. */
  SKIPPED_RATE_LIMITED = 'SKIPPED_RATE_LIMITED',
  /** Câu trả lời của AI vi phạm chính sách (lộ dữ liệu / dấu hiệu nội bộ) — không gửi. */
  BLOCKED_BY_POLICY = 'BLOCKED_BY_POLICY',
  /** Emergency stop đã commit trong lúc lượt AI chạy — bỏ tin, không tạo outbox. */
  DISCARDED_RUNTIME_HALTED = 'DISCARDED_RUNTIME_HALTED',
}

/** Phạm vi dừng khẩn (bảng `recruitment_runtime_controls`). */
export enum RuntimeControlScope {
  /** API `/recruitment/ai/*` → 503 `AI_HALTED`; worker không bắt đầu lượt mới. */
  AI = 'AI',
  /** Worker không claim event mới. */
  WORKER = 'WORKER',
  /** Sender không mở kết nối gửi tin (tin giữ nguyên chờ). */
  OUTBOUND = 'OUTBOUND',
}

export enum HrAlertType {
  CANDIDATE_REQUESTED_HUMAN = 'CANDIDATE_REQUESTED_HUMAN',
  AI_POLICY_HANDOFF = 'AI_POLICY_HANDOFF',
  CANDIDATE_MESSAGE_WAITING = 'CANDIDATE_MESSAGE_WAITING',
  OUTBOUND_UNKNOWN = 'OUTBOUND_UNKNOWN',
  OUTBOUND_DEAD_LETTER = 'OUTBOUND_DEAD_LETTER',
  CHANNEL_EVENT_DEAD_LETTER = 'CHANNEL_EVENT_DEAD_LETTER',
  REFRESH_OUTCOME_UNKNOWN = 'REFRESH_OUTCOME_UNKNOWN',
  REPEATED_AI_FAILURE = 'REPEATED_AI_FAILURE',
  /** Vượt trần lượt / token toàn hệ thống — AI đã tự dừng, cần người vận hành. */
  AI_LIMIT_REACHED = 'AI_LIMIT_REACHED',
}

export enum HrAlertSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum HrAlertStatus {
  OPEN = 'OPEN',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
}
