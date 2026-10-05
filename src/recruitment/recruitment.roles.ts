import { HR_ROLE } from '../teaching/teaching-roles';
import type { AuthUser } from '../type/auth-user.type';
import { RecruitmentActorType } from './recruitment.enums';

/**
 * Quyền của module Tuyển dụng — **nơi duy nhất** khai role. Controller/service
 * chỉ tham chiếu các hằng số này, nên thêm role `tuyendung` sau này chỉ cần
 * thêm vào `RECRUITMENT_MANAGE_ROLES`.
 */
export const RECRUITMENT_MANAGE_ROLES: readonly string[] = [HR_ROLE];

/** Ban giám đốc xem được toàn bộ pipeline nhưng không thao tác. */
export const RECRUITMENT_VIEW_ONLY_ROLES: readonly string[] = [
  'director',
  'director_la',
  'troly_gd',
];

export const RECRUITMENT_VIEW_ROLES: readonly string[] = [
  ...RECRUITMENT_MANAGE_ROLES,
  ...RECRUITMENT_VIEW_ONLY_ROLES,
];

export function canManageRecruitment(user?: AuthUser): boolean {
  return (user?.roles ?? []).some((r) => RECRUITMENT_MANAGE_ROLES.includes(r));
}

/**
 * Ai đang thao tác. Service nhận actor thay vì `req.user` để cùng một hàm
 * phục vụ được cả HR (JWT) lẫn OpenClaw (API key) và state machine phân biệt
 * được quyền của hai bên.
 */
export interface RecruitmentActor {
  type: RecruitmentActorType;
  /** Employee id với HR; `null` với AI/hệ thống. */
  employeeId: number | null;
  name: string;
  roles: string[];
}

export const AI_ACTOR: RecruitmentActor = Object.freeze({
  type: RecruitmentActorType.AI,
  employeeId: null,
  name: 'OpenClaw AI',
  roles: ['recruitment_ai'],
}) as RecruitmentActor;

export const SYSTEM_ACTOR: RecruitmentActor = Object.freeze({
  type: RecruitmentActorType.SYSTEM,
  employeeId: null,
  name: 'Hệ thống tuyển dụng',
  roles: ['recruitment_system'],
}) as RecruitmentActor;

export function hrActor(user: AuthUser): RecruitmentActor {
  return {
    type: RecruitmentActorType.HR,
    employeeId: user.id,
    name: user.name ?? `Nhân viên #${user.id}`,
    roles: user.roles ?? [],
  };
}
