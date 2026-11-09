import type { ExpensePeriod } from '../expense-periods/expense-period.entity';
import type { School } from '../school/schools.entity';
import type { Subject } from '../subject/subject.entity';
import type { ManagementViewSection } from './expense-management-view';

/** Một trường của đề xuất chi tháng như người dùng gửi lên (chưa kiểm). */
export interface MonthlyItemInput {
  schoolId?: number | null;
  schoolYear?: string | null;
  subjectId?: number | null;
  expensePeriodId?: number | null;
}

/** Một trường của đề xuất chi tháng đã kiểm xong. */
export interface ResolvedMonthlyItem {
  school: School;
  schoolYear: string;
  subject: Subject;
  expensePeriod: ExpensePeriod;
}

/**
 * Client cũ và đề xuất tạo trước khi chọn được nhiều trường chỉ có một trường,
 * nằm ở các cột đơn `schoolId/schoolYear/subjectId/expensePeriodId`.
 */
export function monthlyItemsFromColumns(source: MonthlyItemInput): MonthlyItemInput[] {
  if (source.schoolId === undefined || source.schoolId === null) return [];
  return [
    {
      schoolId: source.schoolId,
      schoolYear: source.schoolYear ?? null,
      subjectId: source.subjectId ?? null,
      expensePeriodId: source.expensePeriodId ?? null,
    },
  ];
}

/**
 * Số tiền lệnh chi của đề xuất chi tháng = tổng dòng "Còn chi" của mọi bảng
 * Chi Ngoài Giám đốc thấy khi duyệt. Làm tròn đồng để khớp cột numeric(18,2).
 */
export function monthlyRemainingTotal(sections: ManagementViewSection[]): number {
  const total = sections.reduce(
    (sum, section) => sum + (Number(section.totals?.remaining) || 0),
    0,
  );
  return Math.round(total * 100) / 100;
}
