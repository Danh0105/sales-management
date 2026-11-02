import { ConflictException, ForbiddenException } from '@nestjs/common';

import { ApplicationStatus, RecruitmentActorType } from './recruitment.enums';

const { AI, HR } = RecruitmentActorType;
const S = ApplicationStatus;

interface TransitionRule {
  to: ApplicationStatus;
  actors: RecruitmentActorType[];
  /**
   * AI chỉ được đi bước này khi ứng viên đã xác nhận một lịch nằm trong slot
   * HR mở (`QUALIFIED → INTERVIEW`). HR thì không cần điều kiện này.
   */
  aiRequiresConfirmedInterview?: boolean;
}

/**
 * Luồng hồ sơ ứng tuyển:
 *
 * NEW → COLLECTING_INFO → SCREENING → QUALIFIED → INTERVIEW → OFFER → HIRED
 *                             │  ↖────────┘(chấm lại)
 *                             ├→ COLLECTING_INFO (thiếu dữ liệu)
 *                             └→ NEEDS_HR_REVIEW ──(chỉ HR)──→ ...
 * Mọi trạng thái chưa kết thúc → NEEDS_HR_REVIEW (handoff) / REJECTED / WITHDRAWN (chỉ HR).
 *
 * AI **không bao giờ** được: OFFER, HIRED, REJECTED, WITHDRAWN, hay đi ra khỏi
 * NEEDS_HR_REVIEW — quyết định tuyển dụng là của HR.
 *
 * `SYSTEM` (bước tự sinh trong luồng AI, vd. chấm điểm xong tự chuyển HR)
 * mang quyền của AI.
 */
const HR_EXITS: TransitionRule[] = [
  { to: S.REJECTED, actors: [HR] },
  { to: S.WITHDRAWN, actors: [HR] },
];

const TRANSITIONS: Record<ApplicationStatus, TransitionRule[]> = {
  [S.NEW]: [
    { to: S.COLLECTING_INFO, actors: [AI, HR] },
    { to: S.SCREENING, actors: [AI, HR] },
    { to: S.NEEDS_HR_REVIEW, actors: [AI, HR] },
    ...HR_EXITS,
  ],
  [S.COLLECTING_INFO]: [
    { to: S.SCREENING, actors: [AI, HR] },
    { to: S.NEEDS_HR_REVIEW, actors: [AI, HR] },
    ...HR_EXITS,
  ],
  [S.SCREENING]: [
    { to: S.QUALIFIED, actors: [AI, HR] },
    { to: S.COLLECTING_INFO, actors: [AI, HR] },
    { to: S.NEEDS_HR_REVIEW, actors: [AI, HR] },
    ...HR_EXITS,
  ],
  [S.QUALIFIED]: [
    { to: S.SCREENING, actors: [AI, HR] },
    { to: S.INTERVIEW, actors: [AI, HR], aiRequiresConfirmedInterview: true },
    { to: S.NEEDS_HR_REVIEW, actors: [AI, HR] },
    ...HR_EXITS,
  ],
  [S.NEEDS_HR_REVIEW]: [
    { to: S.COLLECTING_INFO, actors: [HR] },
    { to: S.SCREENING, actors: [HR] },
    { to: S.QUALIFIED, actors: [HR] },
    { to: S.INTERVIEW, actors: [HR] },
    ...HR_EXITS,
  ],
  [S.INTERVIEW]: [
    { to: S.OFFER, actors: [HR] },
    { to: S.NEEDS_HR_REVIEW, actors: [AI, HR] },
    ...HR_EXITS,
  ],
  [S.OFFER]: [{ to: S.HIRED, actors: [HR] }, ...HR_EXITS],
  [S.HIRED]: [],
  [S.REJECTED]: [],
  [S.WITHDRAWN]: [],
};

export interface TransitionContext {
  interviewConfirmed?: boolean;
}

export type TransitionCheck =
  | { allowed: true }
  | { allowed: false; code: string; message: string; forbidden: boolean };

function effectiveActor(actor: RecruitmentActorType): RecruitmentActorType {
  return actor === RecruitmentActorType.SYSTEM ? AI : actor;
}

export function checkApplicationTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  actor: RecruitmentActorType,
  ctx: TransitionContext = {},
): TransitionCheck {
  if (from === to) {
    return {
      allowed: false,
      forbidden: false,
      code: 'STATUS_UNCHANGED',
      message: `Hồ sơ đã ở trạng thái ${to}`,
    };
  }

  const rule = TRANSITIONS[from]?.find((r) => r.to === to);
  if (!rule) {
    return {
      allowed: false,
      forbidden: false,
      code: 'INVALID_STATUS_TRANSITION',
      message: `Không thể chuyển hồ sơ từ ${from} sang ${to}`,
    };
  }

  const who = effectiveActor(actor);
  if (!rule.actors.includes(who)) {
    return {
      allowed: false,
      forbidden: true,
      code: who === AI ? 'AI_TRANSITION_FORBIDDEN' : 'TRANSITION_FORBIDDEN',
      message:
        who === AI
          ? `AI không được chuyển hồ sơ từ ${from} sang ${to} — bước này do HR quyết định`
          : `Không được chuyển hồ sơ từ ${from} sang ${to}`,
    };
  }

  if (
    who === AI &&
    rule.aiRequiresConfirmedInterview &&
    !ctx.interviewConfirmed
  ) {
    return {
      allowed: false,
      forbidden: true,
      code: 'AI_TRANSITION_FORBIDDEN',
      message:
        'AI chỉ chuyển sang INTERVIEW khi ứng viên đã xác nhận lịch phỏng vấn trong slot HR mở',
    };
  }

  return { allowed: true };
}

export function assertApplicationTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  actor: RecruitmentActorType,
  ctx: TransitionContext = {},
): void {
  const check = checkApplicationTransition(from, to, actor, ctx);
  if (check.allowed) return;

  const body = { code: check.code, message: check.message };
  throw check.forbidden
    ? new ForbiddenException(body)
    : new ConflictException(body);
}

export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  actor: RecruitmentActorType,
  ctx: TransitionContext = {},
): boolean {
  return checkApplicationTransition(from, to, actor, ctx).allowed;
}

/** Các trạng thái mà `actor` chuyển tới được từ `from` — để FE/AI biết nút nào bật. */
export function allowedNextStatuses(
  from: ApplicationStatus,
  actor: RecruitmentActorType,
): ApplicationStatus[] {
  const who = effectiveActor(actor);
  return (TRANSITIONS[from] ?? [])
    .filter((r) => r.actors.includes(who))
    .map((r) => r.to);
}
