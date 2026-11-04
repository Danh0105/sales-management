import { ACTIVITY_LOG_VIEW_ROLES } from '../activity-log/activity-log.controller';
import { DEPARTMENT_ADMIN_ROLES } from '../department/department.controller';
import { OTHER_CASHFLOW_APPROVE_ROLES } from '../other-cashflow/other-cashflow.constants';
import { PAYROLL_VIEW_ALL_ROLES } from '../payroll/payroll.roles';
import { RECRUITMENT_VIEW_ROLES } from '../recruitment/recruitment.roles';
import { TEACHING_VIEW_ROLES } from '../teaching/teaching-roles';
import { EMPLOYEE_ADMIN_ROLES } from './employee-roles';

describe('Giám đốc Long An — ẩn và khóa chức năng Nhân sự / Thu chi', () => {
  it.each([
    ['quản trị nhân viên', EMPLOYEE_ADMIN_ROLES],
    ['quản trị phòng ban', DEPARTMENT_ADMIN_ROLES],
    ['tuyển dụng', RECRUITMENT_VIEW_ROLES],
    ['giảng dạy', TEACHING_VIEW_ROLES],
    ['nhật ký nhân sự', ACTIVITY_LOG_VIEW_ROLES],
    ['xem toàn bộ phiếu lương', PAYROLL_VIEW_ALL_ROLES],
    ['duyệt Thu Chi ngoài', OTHER_CASHFLOW_APPROVE_ROLES],
  ])('không có role director_la trong quyền %s', (_label, roles) => {
    expect(roles).not.toContain('director_la');
    expect(roles).toContain('director');
  });
});
