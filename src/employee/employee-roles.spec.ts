import { ForbiddenException } from '@nestjs/common';
import {
  assertNoTeacherRoleGrant,
  assertSelfOrEmployeeAdmin,
  isEmployeeAdmin,
} from './employee-roles';
import { TEACHER_STAFF_ROLE, HR_ROLE, ACADEMIC_ROLE } from '../teaching/teaching-roles';

describe('Quyền trên /employees', () => {
  it('Giáo vụ không phải người quản trị nhân sự', () => {
    expect(isEmployeeAdmin({ id: 5, roles: [ACADEMIC_ROLE] })).toBe(false);
    expect(isEmployeeAdmin({ id: 9, roles: [HR_ROLE] })).toBe(true);
    expect(isEmployeeAdmin({ id: 1, roles: ['director'] })).toBe(true);
  });

  it('chỉ thao tác được trên chính mình', () => {
    expect(() =>
      assertSelfOrEmployeeAdmin({ id: 7, roles: ['sales'] }, 7),
    ).not.toThrow();
    expect(() =>
      assertSelfOrEmployeeAdmin({ id: 7, roles: ['sales'] }, 8),
    ).toThrow(ForbiddenException);
    // Nhân sự làm hộ được cho người khác.
    expect(() =>
      assertSelfOrEmployeeAdmin({ id: 9, roles: [HR_ROLE] }, 8),
    ).not.toThrow();
  });

  it('không tạo mới được tài khoản role giáo viên qua /employees', () => {
    expect(() => assertNoTeacherRoleGrant(['sales'])).not.toThrow();
    expect(() => assertNoTeacherRoleGrant(undefined)).not.toThrow();
    // Đây chính là đường vòng qua bước Nhân sự duyệt tài khoản giáo viên.
    expect(() => assertNoTeacherRoleGrant([TEACHER_STAFF_ROLE])).toThrow(
      ForbiddenException,
    );
  });
});
