/**
 * Ngày hiệu lực của HR luôn tính theo giờ Việt Nam và so sánh dạng chuỗi
 * `YYYY-MM-DD` — cột `date` của Postgres cũng trả về đúng dạng này, nên không
 * có chuyện lệch một ngày vì múi giờ của server/Node.
 */
export const HR_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function hrToday(now: Date = new Date()): string {
  // `en-CA` định dạng sẵn YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: HR_TIME_ZONE }).format(
    now,
  );
}

export function assertIsoDate(value: string, field = 'date'): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} phải có dạng YYYY-MM-DD, nhận được "${value}"`);
  }
}

/**
 * Bản ghi có hiệu lực vào ngày `on` không.
 *
 * Quy ước của HR: `effective_to` là ngày cuối CÒN hiệu lực (inclusive), khớp
 * cách nghiệp vụ đọc "01/01/2026 → 30/09/2026"; `null` = chưa kết thúc.
 */
export function isEffectiveOn(
  effectiveFrom: string,
  effectiveTo: string | null,
  on: string,
): boolean {
  return effectiveFrom <= on && (effectiveTo === null || effectiveTo >= on);
}
