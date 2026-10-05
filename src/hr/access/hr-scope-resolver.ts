import { Injectable } from '@nestjs/common';

/**
 * Đối tượng đang bị truy cập. PHẢI được dựng từ bản ghi server tự đọc trong
 * DB (theo id trên URL), không bao giờ từ thông tin tổ chức FE gửi lên.
 */
export interface HrAccessTarget {
  /** `public.employee.id` của người được xem — null nếu hồ sơ HR chưa có tài khoản. */
  accountId?: number | null;
  /** `hr.employees.id` (Phase 1). */
  employeeId?: number | null;
}

/**
 * Trả lời "đối tượng có nằm trong TEAM/ORG_UNIT/BRANCH của người xem không"
 * tại một ngày cụ thể — cần dữ liệu tổ chức + quá trình công tác (Phase 1).
 */
export interface HrScopeResolver {
  isInTeam(
    viewerAccountId: number,
    target: HrAccessTarget,
    on: string,
  ): Promise<boolean>;
  isInOrgUnit(
    viewerAccountId: number,
    orgUnitId: number | null,
    target: HrAccessTarget,
    on: string,
  ): Promise<boolean>;
  isInBranch(
    viewerAccountId: number,
    branchId: number | null,
    target: HrAccessTarget,
    on: string,
  ): Promise<boolean>;
}

export const HR_SCOPE_RESOLVER = Symbol('HR_SCOPE_RESOLVER');

/**
 * Mặc định cho tới khi Phase 1 có dữ liệu tổ chức: luôn trả "không".
 *
 * Fail-closed có chủ đích — một quản lý có quyền `EMPLOYEE_VIEW + TEAM` hiện
 * không xem được ai, thay vì lỡ tay xem được tất cả. Phase 1 thay provider
 * `HR_SCOPE_RESOLVER` bằng bản đọc `hr.employment_records`.
 */
@Injectable()
export class FailClosedScopeResolver implements HrScopeResolver {
  isInTeam(): Promise<boolean> {
    return Promise.resolve(false);
  }

  isInOrgUnit(): Promise<boolean> {
    return Promise.resolve(false);
  }

  isInBranch(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
