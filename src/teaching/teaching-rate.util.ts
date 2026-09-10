import { Teacher } from './entities/teacher.entity';

/**
 * Đơn giá chốt vào buổi dạy LẤY DUY NHẤT từ đơn giá mặc định của giáo viên.
 *
 * Trước đây thiếu đơn giá giáo viên thì rơi về `subjects.rate_per_period`, nên
 * cùng một người dạy hai môn lại ăn hai giá khác nhau và không ai biết buổi đó
 * chốt theo giá nào. Bỏ nhánh đó đi: giáo viên chưa khai đơn giá thì buổi chốt
 * `null` để lộ ra mà đi khai, thay vì âm thầm trả theo giá của môn.
 *
 * Phép so sánh tường minh với null/undefined giữ nguyên giá 0 hợp lệ.
 */
export function effectiveRatePerPeriod(
  teacher: Pick<Teacher, 'defaultRatePerPeriod'> | null | undefined,
  isCompanyTeacher: boolean,
): number | null {
  // Giáo viên công ty ăn lương + phụ cấp xăng, không nhận theo tiết.
  if (isCompanyTeacher) return null;
  if (
    teacher?.defaultRatePerPeriod !== null &&
    teacher?.defaultRatePerPeriod !== undefined
  ) {
    return teacher.defaultRatePerPeriod;
  }
  return null;
}
