import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LA_PROVINCE_ID } from '../policy/policy-scope';

/** Chức danh được tính là nhân viên khu vực Long An. */
export const LONG_AN_STAFF_ROLES = ['sales', 'employee_la'];

/**
 * Giám đốc Long An là nhượng quyền, chỉ được đụng tới dữ liệu của tỉnh mình.
 * Tài khoản có thêm role `director` vẫn là giám đốc toàn hệ thống.
 */
export const isRestrictedLongAnDirector = (roles?: string[] | null): boolean =>
  !!roles?.includes('director_la') && !roles.includes('director');

/**
 * Nhân viên chỉ phụ trách Long An. Báo cáo và kế hoạch tuần không gắn với
 * trường nào, nên nhân viên kiêm thêm tỉnh khác không được tính: báo cáo của
 * họ có thể chứa việc ở tỉnh đó.
 */
export const longAnOnlyStaffSql = (employeeIdExpr: string): string => `EXISTS (
  SELECT 1 FROM employee la_staff
  WHERE la_staff.id = ${employeeIdExpr}
    AND la_staff."isActive" = true
    AND la_staff.roles && ARRAY['${LONG_AN_STAFF_ROLES.join("','")}']::text[]
    AND EXISTS (
      SELECT 1 FROM employee_region la_in
      WHERE la_in.employee_id = la_staff.id AND la_in.province_id = ${LA_PROVINCE_ID}
    )
    AND NOT EXISTS (
      SELECT 1 FROM employee_region la_out
      WHERE la_out.employee_id = la_staff.id AND la_out.province_id IS DISTINCT FROM ${LA_PROVINCE_ID}
    )
)`;

/** Trường thuộc tỉnh Long An — mọi dữ liệu chính sách suy ra từ đây. */
const SCHOOL_IN_LONG_AN = `JOIN schools la_school ON la_school.id = la_subject.school_id
  JOIN wards la_ward ON la_ward.id = la_school.ward_id AND la_ward.province_id = ${LA_PROVINCE_ID}`;

/** Trả lời "bản ghi này có thuộc Long An không". Id không hợp lệ là không thuộc. */
@Injectable()
export class LongAnScopeService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async exists(sql: string, id: unknown): Promise<boolean> {
    const value = Number(id);
    if (!Number.isInteger(value) || value <= 0) return false;
    const rows = await this.dataSource.query(`SELECT 1 ${sql} LIMIT 1`, [value]);
    return rows.length > 0;
  }

  schoolInScope(schoolId: unknown) {
    return this.exists(
      `FROM schools la_school
       JOIN wards la_ward ON la_ward.id = la_school.ward_id AND la_ward.province_id = ${LA_PROVINCE_ID}
       WHERE la_school.id = $1`,
      schoolId,
    );
  }

  wardInScope(wardId: unknown) {
    return this.exists(
      `FROM wards la_ward WHERE la_ward.id = $1 AND la_ward.province_id = ${LA_PROVINCE_ID}`,
      wardId,
    );
  }

  subjectInScope(subjectId: unknown) {
    return this.exists(
      `FROM subjects la_subject ${SCHOOL_IN_LONG_AN} WHERE la_subject.id = $1`,
      subjectId,
    );
  }

  policyInScope(policyId: unknown) {
    return this.exists(
      `FROM policy la_policy
       JOIN subjects la_subject ON la_subject.id = la_policy."subjectId"
       ${SCHOOL_IN_LONG_AN}
       WHERE la_policy.id = $1`,
      policyId,
    );
  }

  policyHistoryInScope(historyId: unknown) {
    return this.exists(
      `FROM policy_history la_history
       JOIN policy la_policy ON la_policy.id = la_history."policyId"
       JOIN subjects la_subject ON la_subject.id = la_policy."subjectId"
       ${SCHOOL_IN_LONG_AN}
       WHERE la_history.id = $1`,
      historyId,
    );
  }

  /** Nhân viên Long An, kể cả người kiêm tỉnh khác (dùng cho Chính sách, Thống kê). */
  employeeInScope(employeeId: unknown) {
    return this.exists(
      `FROM employee la_staff
       JOIN employee_region la_in ON la_in.employee_id = la_staff.id AND la_in.province_id = ${LA_PROVINCE_ID}
       WHERE la_staff.id = $1
         AND la_staff."isActive" = true
         AND la_staff.roles && ARRAY['${LONG_AN_STAFF_ROLES.join("','")}']::text[]`,
      employeeId,
    );
  }

  /** Chỉ nhân viên thuần Long An (dùng cho Báo cáo). */
  employeeIsLongAnOnly(employeeId: unknown) {
    return this.exists(`WHERE ${longAnOnlyStaffSql('$1')}`, employeeId);
  }

  reportInScope(reportId: unknown) {
    return this.exists(
      `FROM daily_reports la_report
       WHERE la_report.id = $1 AND la_report.province_id = ${LA_PROVINCE_ID}`,
      reportId,
    );
  }

  weeklyPlanInScope(planId: unknown) {
    return this.exists(
      `FROM weekly_plans la_plan
       WHERE la_plan.id = $1 AND ${longAnOnlyStaffSql('la_plan."employeeId"')}`,
      planId,
    );
  }
}
