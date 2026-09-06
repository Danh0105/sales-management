import { Teacher } from './entities/teacher.entity';

/** Chọn giá để chốt vào buổi; phép so sánh rõ ràng giữ nguyên giá 0 hợp lệ. */
export function effectiveRatePerPeriod(
  teacher: Pick<Teacher, 'defaultRatePerPeriod'> | null | undefined,
  subjectRate: number | null | undefined,
  isCompanyTeacher: boolean,
): number | null {
  if (isCompanyTeacher) return null;
  if (
    teacher?.defaultRatePerPeriod !== null &&
    teacher?.defaultRatePerPeriod !== undefined
  ) {
    return teacher.defaultRatePerPeriod;
  }
  return subjectRate ?? null;
}
