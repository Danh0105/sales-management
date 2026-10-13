import type { AiReplyPolicyConfig } from './recruitment-ai-safety.config';

/**
 * Chính sách câu trả lời của AI TRƯỚC khi xếp hàng gửi (P3-7.3 / G8) — lớp chặn cuối cho
 * prompt injection / lộ dữ liệu: câu trả lời vi phạm KHÔNG được gửi, HR xem lại.
 * Không thay cho các lớp chính (tool chỉ `recruitment_*`, subject ràng buộc người gửi,
 * backend quyết định nghiệp vụ) — chỉ chặn những gì lọt qua.
 *
 * - SECRET_LIKE: chuỗi giống khoá / token (`sk-…`, `Bearer …`, JWT).
 * - INTERNAL_MARKER: dấu hiệu nội bộ (tên tool `recruitment_*`, header subject, session key,
 *   tên biến môi trường, file skill / system prompt).
 * - FOREIGN_CONTACT: số điện thoại / email không có trong tin của chính ứng viên và không nằm
 *   trong danh sách liên hệ được phép (vd. hotline tuyển dụng).
 * - FOREIGN_URL: URL ngoài danh sách miền được phép.
 */
export type AiReplyViolation =
  | 'SECRET_LIKE'
  | 'INTERNAL_MARKER'
  | 'FOREIGN_CONTACT'
  | 'FOREIGN_URL';

const SECRET_LIKE =
  /\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const INTERNAL_MARKER =
  /\brecruitment_[a-z_]{3,}\b|x-recruitment-subject|agent:[a-z0-9_-]+:zalo:|\bRECRUITMENT_[A-Z_]{3,}\b|OPENAI_API_KEY|SKILL\.md|system prompt/i;
const PHONE = /(?:\+?84|0)(?:[\s.-]?\d){8,10}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL = /\bhttps?:\/\/([^\s/?#:]+)/gi;

const digits = (value: string) => value.replace(/\D/g, '').replace(/^84/, '0');

export function checkAiReply(
  reply: string,
  inboundText: string,
  policy: AiReplyPolicyConfig,
): AiReplyViolation | null {
  if (SECRET_LIKE.test(reply)) return 'SECRET_LIKE';
  if (INTERNAL_MARKER.test(reply)) return 'INTERNAL_MARKER';

  const allowedPhones = new Set(
    [
      ...(inboundText.match(PHONE) ?? []),
      ...policy.allowedContacts.filter((c) => !c.includes('@')),
    ].map(digits),
  );
  const allowedEmails = new Set(
    [
      ...(inboundText.match(EMAIL) ?? []),
      ...policy.allowedContacts.filter((c) => c.includes('@')),
    ].map((e) => e.toLowerCase()),
  );
  if ((reply.match(PHONE) ?? []).some((p) => !allowedPhones.has(digits(p)))) {
    return 'FOREIGN_CONTACT';
  }
  if (
    (reply.match(EMAIL) ?? []).some((e) => !allowedEmails.has(e.toLowerCase()))
  ) {
    return 'FOREIGN_CONTACT';
  }

  for (const match of reply.matchAll(URL)) {
    const host = match[1].toLowerCase();
    const allowed = policy.allowedDomains.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    if (!allowed) return 'FOREIGN_URL';
  }
  return null;
}
