import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Danh tính kênh (Phase 3) do **tầng tin cậy** gắn, không phải do model khai.
 *
 * Adapter Zalo đặt session OpenClaw `agent:main:zalo:<oaId>:<zaloUserId>`; plugin
 * đọc session đó và gửi header `X-Recruitment-Subject: zalo:<oaId>:<zaloUserId>`
 * kèm `RECRUITMENT_CHANNEL_API_KEY`. API AI chỉ tin header này khi đi cùng key
 * kênh — key AI chung (harness Phase 2) gửi kèm subject sẽ bị từ chối.
 */
export const RECRUITMENT_SUBJECT_HEADER = 'x-recruitment-subject';

/** OA của dữ liệu có từ trước Phase 3 (không biết thuộc OA nào). Không kênh nào được nhận. */
export const LEGACY_ZALO_OA_ID = 'legacy';

export interface RecruitmentAiSubject {
  channel: 'zalo';
  oaId: string;
  userId: string;
}

export type RecruitmentAiCredential = 'ai' | 'channel';

export interface RecruitmentAiRequestContext {
  credential: RecruitmentAiCredential;
  /** Có giá trị khi và chỉ khi request đi bằng key kênh. */
  subject: RecruitmentAiSubject | null;
}

export type RecruitmentAiRequest = Request & {
  recruitmentAi?: RecruitmentAiRequestContext;
};

const SUBJECT = /^zalo:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,100})$/;

/** `null` = sai định dạng hoặc tự nhận OA `legacy`. */
export function parseRecruitmentSubject(
  raw: unknown,
): RecruitmentAiSubject | null {
  if (typeof raw !== 'string') return null;
  const match = SUBJECT.exec(raw.trim());
  if (!match || match[1] === LEGACY_ZALO_OA_ID) return null;
  return { channel: 'zalo', oaId: match[1], userId: match[2] };
}

export function formatRecruitmentSubject(subject: RecruitmentAiSubject) {
  return `${subject.channel}:${subject.oaId}:${subject.userId}`;
}

/**
 * `externalConversationId` của hội thoại kênh: kèm OA vì id người dùng Zalo chỉ
 * duy nhất trong một OA — hội thoại nhận diện theo (kênh, externalConversationId).
 * Adapter và API AI phải dùng cùng quy ước này.
 */
export function channelConversationId(subject: RecruitmentAiSubject) {
  return `${subject.oaId}:${subject.userId}`;
}

/** Context xác thực mà `RecruitmentAiAuthGuard` gắn vào request. */
export const AiRequestContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RecruitmentAiRequestContext =>
    ctx.switchToHttp().getRequest<RecruitmentAiRequest>().recruitmentAi ?? {
      credential: 'ai',
      subject: null,
    },
);

export const REQUIRE_SUBJECT_CONFIG_ERROR =
  'RECRUITMENT_AI_REQUIRE_SUBJECT_MUST_BE_TRUE';

/**
 * Fail-closed: production bật API AI thì bắt buộc mọi request mang subject của
 * kênh tin cậy. Thiếu/false → app không khởi động (gọi lúc init module).
 */
export function assertRecruitmentAiConfig(
  get: (key: string) => string | undefined,
): void {
  if (
    get('NODE_ENV') === 'production' &&
    get('RECRUITMENT_AI_ENABLED') === 'true' &&
    get('RECRUITMENT_AI_REQUIRE_SUBJECT') !== 'true'
  ) {
    throw new Error(
      `${REQUIRE_SUBJECT_CONFIG_ERROR}: NODE_ENV=production và RECRUITMENT_AI_ENABLED=true ` +
        'thì RECRUITMENT_AI_REQUIRE_SUBJECT phải là "true".',
    );
  }
}
