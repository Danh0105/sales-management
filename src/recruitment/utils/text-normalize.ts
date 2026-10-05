import { extractVietnamPhone } from '../../zalo-oa/zalo-phone';

/**
 * Chuẩn hoá để so khớp kỹ năng/địa điểm: chữ thường, bỏ dấu tiếng Việt,
 * gộp ký tự đặc biệt thành một khoảng trắng. "Bán hàng B2B" → "ban hang b2b".
 */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
}

/**
 * Số điện thoại dạng đang lưu (`0xxxxxxxxx`). Dùng lại bộ tách số của Zalo OA
 * để "+84 90 123 4567" và "0901234567" so được với nhau. `null` = không phải
 * số VN hợp lệ.
 */
export function normalizePhone(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const phone = extractVietnamPhone(value);
  // Chỉ nhận khi cả chuỗi là một số điện thoại, không nhặt số trong câu dài.
  if (!phone) return null;
  const digits = value.replace(/[^\d]/g, '').replace(/^(?:84|0084)/, '0');
  return digits === phone ? phone : null;
}

export function normalizeEmail(
  value: string | null | undefined,
): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

/** `0901234567` → `09******67` — đủ để HR/AI nhận ra mà không lộ số. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length <= 4) return '*'.repeat(phone.length);
  return `${phone.slice(0, 2)}${'*'.repeat(phone.length - 4)}${phone.slice(-2)}`;
}

/** `nguyenvana@gmail.com` → `ng***@gmail.com`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

/** Ngày hôm nay theo giờ Việt Nam, dạng `YYYY-MM-DD`. */
export function todayInVietnam(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
