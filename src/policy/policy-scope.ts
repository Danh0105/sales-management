import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthUser } from '../type/auth-user.type';

/** Xem được toàn bộ chính sách. `ketoan_truong` là vai trò chỉ-xem (READ_ONLY_ROLES). */
export const POLICY_VIEW_ALL_ROLES = [
    'director',
    'saleadmin',
    'troly_gd',
    'ketoan_truong',
];

/** Vai trò bị giới hạn theo tỉnh — cùng quy ước với employee/province service. */
export const POLICY_VIEW_PROVINCE_ROLES = ['director_la', 'salesadmin_la'];

/** Chỉ xem chính sách của các trường mình phụ trách (schools.employee_id). */
export const POLICY_VIEW_OWN_ROLES = ['sales'];

/** Tỉnh của các vai trò `_la` — giống employee.service.ts / province.service.ts. */
export const LA_PROVINCE_ID = 7;

export const POLICY_VIEW_ROLES = [
    ...POLICY_VIEW_ALL_ROLES,
    ...POLICY_VIEW_PROVINCE_ROLES,
    ...POLICY_VIEW_OWN_ROLES,
];

export type PolicyScope =
    | { kind: 'all' }
    | { kind: 'province'; provinceId: number }
    | { kind: 'own'; employeeId: number };

/**
 * Phạm vi dữ liệu LUÔN suy ra từ access token, không bao giờ từ query của FE.
 * Ưu tiên: toàn quyền > theo tỉnh > chỉ dữ liệu của mình.
 */
export function resolvePolicyScope(user?: AuthUser): PolicyScope {
    if (!user?.id) {
        throw new UnauthorizedException('Token không hợp lệ');
    }

    const roles = user.roles ?? [];

    if (roles.some((r) => POLICY_VIEW_ALL_ROLES.includes(r))) {
        return { kind: 'all' };
    }

    if (roles.some((r) => POLICY_VIEW_PROVINCE_ROLES.includes(r))) {
        return { kind: 'province', provinceId: LA_PROVINCE_ID };
    }

    if (roles.some((r) => POLICY_VIEW_OWN_ROLES.includes(r))) {
        return { kind: 'own', employeeId: user.id };
    }

    throw new ForbiddenException('Bạn không có quyền xem danh sách chính sách');
}
