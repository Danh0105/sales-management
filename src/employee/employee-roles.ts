import { ForbiddenException } from '@nestjs/common';
import { AuthUser } from '../type/auth-user.type';
import { HR_ROLE, TEACHER_ROLES } from '../teaching/teaching-roles';

/**
 * Được tạo/sửa/xoá tài khoản nhân viên. Cố ý hẹp: tạo tài khoản là cấp quyền
 * đăng nhập, và `roles` gửi kèm quyết định người đó thấy được những gì — ai gọi
 * được endpoint này thì tự nâng quyền cho bất kỳ ai được.
 */
export const EMPLOYEE_ADMIN_ROLES = [HR_ROLE, 'director', 'director_la'];

export function isEmployeeAdmin(user?: AuthUser): boolean {
  return (user?.roles ?? []).some((r) => EMPLOYEE_ADMIN_ROLES.includes(r));
}

/** Thao tác chỉ được làm trên chính mình, trừ khi là người quản trị nhân sự. */
export function assertSelfOrEmployeeAdmin(
  user: AuthUser | undefined,
  targetId: number,
): void {
  if (user?.id === targetId || isEmployeeAdmin(user)) return;

  throw new ForbiddenException(
    'Bạn chỉ thao tác được trên tài khoản của chính mình',
  );
}

/**
 * Chặn **tạo mới** một tài khoản đăng nhập mang role giáo viên qua `/employees`.
 *
 * Tài khoản giáo viên phải đi qua `POST /teachers` — nơi Giáo vụ tạo thì hồ sơ
 * còn phải chờ Nhân sự xác nhận. Để `/employees` tạo thẳng được thì bước duyệt
 * đó chỉ là hình thức, và còn sinh ra tài khoản giáo viên không có hồ sơ nào
 * trong bảng `teachers`.
 *
 * Cố ý **không** áp cho `PATCH /employees/:id`: gán thêm role giáo viên cho một
 * tài khoản đã tồn tại không sinh ra quyền đăng nhập mới (người đó đã đăng nhập
 * được từ trước), mà đó lại là cách duy nhất để một nhân viên có sẵn kiêm thêm
 * việc dạy — `POST /teachers` khi gắn `employeeId` đòi tài khoản phải **đã có**
 * role giáo viên.
 */
export function assertNoTeacherRoleGrant(roles?: string[] | null): void {
  const granted = (roles ?? []).filter((r) => TEACHER_ROLES.includes(r));
  if (!granted.length) return;

  throw new ForbiddenException(
    `Không cấp được role giáo viên (${granted.join(', ')}) ở đây. ` +
      'Tài khoản giáo viên tạo ở màn Giáo viên để đi qua bước Nhân sự duyệt.',
  );
}
