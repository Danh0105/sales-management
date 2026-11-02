/**
 * Phần "môn – lớp, trường" trong tin yêu cầu xác nhận lịch dạy, để giáo viên
 * biết ngay là lịch nào mà không phải mở app. Thiếu phần nào thì bỏ phần đó.
 */
export function formatConfirmationPlace(
  row?: {
    schoolName?: string | null;
    className?: string | null;
    subjectName?: string | null;
  } | null,
): string {
  if (!row) return '';
  const where = [row.className, row.schoolName].filter(Boolean).join(', ');
  return [row.subjectName ? `môn ${row.subjectName}` : '', where]
    .filter(Boolean)
    .join(' – ');
}

/** "2026-11-03" → "03/11/2026". */
export function toVietnameseDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}
