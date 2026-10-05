/**
 * Hồ sơ nhân viên cơ bản (Phase 1.2.3) — chuẩn hoá, tìm kiếm, che dữ liệu.
 * Thuần (không truy cập DB) để test đầy đủ.
 */

/**
 * Kiểu chấm công. `UNASSIGNED` = CHƯA PHÂN LOẠI — trạng thái nghiệp vụ có
 * nghĩa (không phải "mặc định theo ca"). Không tự đổi UNASSIGNED → SHIFT khi
 * không có rule rõ ràng; trước khi dùng chấm công (Phase 3) mọi hồ sơ ACTIVE
 * phải được phân loại.
 */
export const ATTENDANCE_MODES = [
  'SHIFT',
  'TEACHING_SESSION',
  'UNASSIGNED',
] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export type Gender = (typeof GENDERS)[number];

/* ------------------------------------------------------------------------ */
/* Chuẩn hoá tên để tìm kiếm không dấu                                        */
/* ------------------------------------------------------------------------ */

/**
 * HỢP ĐỒNG CHUẨN HOÁ (v1) — phải cho kết quả GIỐNG HỆT biểu thức SQL trong
 * migration 1791700000800 (`FULL_NAME_SEARCH_SQL`); test đối chiếu trên DB.
 *
 * 1. Unicode NFD (tách dấu khỏi chữ; NFC và NFD cho cùng kết quả).
 * 2. Bỏ mọi dấu kết hợp U+0300–U+036F.
 * 3. `Đ`/`đ` → `d`; CHỈ chữ ASCII A–Z → a–z. Không dùng toLowerCase()/lower()
 *    vì kết quả phụ thuộc locale (vd. `I` trong locale Thổ Nhĩ Kỳ) — ký tự
 *    ngoài bảng này giữ nguyên ở cả hai phía.
 * 4. Gộp mọi khoảng trắng (danh sách cố định bên dưới) thành một dấu cách,
 *    bỏ dấu cách đầu/cuối.
 */
// Dựng từ code point — không viết ký tự đặc biệt trực tiếp trong mã nguồn.
const cp = (n: number) => String.fromCharCode(n);
const range = (a: number, b: number) => `${cp(a)}-${cp(b)}`;
const D_UPPER = cp(0x0110);
const D_LOWER = cp(0x0111);
const COMBINING_MARKS = new RegExp(`[${range(0x0300, 0x036f)}]`, 'g');
/** Tab..CR, dấu cách, NBSP, U+1680, U+2000–200A, U+2028/2029, U+202F, U+205F, U+3000, BOM. */
export const WHITESPACE_CODE_POINTS: [number, number?][] = [
  [0x09, 0x0d],
  [0x20],
  [0xa0],
  [0x1680],
  [0x2000, 0x200a],
  [0x2028],
  [0x2029],
  [0x202f],
  [0x205f],
  [0x3000],
  [0xfeff],
];
const WHITESPACE = new RegExp(
  `[${WHITESPACE_CODE_POINTS.map(([a, b]) => (b ? range(a, b) : cp(a))).join('')}]+`,
  'g',
);
const UPPER_OR_D = new RegExp(`[A-Z${D_UPPER}${D_LOWER}]`, 'g');

export function normalizeVietnameseName(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(UPPER_OR_D, (c) =>
      c === D_UPPER || c === D_LOWER ? 'd' : c.toLowerCase(),
    )
    .replace(WHITESPACE, ' ')
    .replace(/^ | $/g, '');
}

/* ------------------------------------------------------------------------ */
/* Liên hệ                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * SĐT: chỉ bỏ khoảng trắng, dấu chấm, dấu gạch nối — không đổi +84 ↔ 0,
 * không thêm/bớt chữ số. Kết quả hợp lệ: `+` tuỳ chọn + 8–15 chữ số.
 */
const PHONE_SEPARATORS = /[\s.-]/g;
export const PHONE_PATTERN = /^\+?[0-9]{8,15}$/;

export function normalizeProfilePhone(value: string): string {
  return value.replace(PHONE_SEPARATORS, '');
}

export function normalizeProfileEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Biến thể quốc gia của cùng một số (chỉ để CẢNH BÁO trùng, không lưu). */
export function phoneVariants(phone: string): string[] {
  if (phone.startsWith('+84')) return [phone, `0${phone.slice(3)}`];
  if (phone.startsWith('0')) return [phone, `+84${phone.slice(1)}`];
  return [phone];
}

/* ------------------------------------------------------------------------ */
/* Tìm kiếm                                                                  */
/* ------------------------------------------------------------------------ */

export const SEARCH_MAX_LENGTH = 100;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

const CODE_QUERY = /^[A-Za-z0-9._-]+$/;
const PHONE_QUERY = /^\+?[0-9]{3,15}$/;

/** Thoát ký tự đặc biệt của LIKE (dùng với `ESCAPE '\'`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface SearchTerms {
  /** Mã NV: khớp chính xác hoặc tiền tố (không phân biệt hoa thường). */
  codePrefix: string | null;
  /** Họ tên: chứa chuỗi, sau chuẩn hoá. */
  nameContains: string | null;
  /** SĐT: chứa chuỗi, sau khi bỏ khoảng trắng/chấm/gạch nối. */
  phoneContains: string | null;
  /** Email công việc / cá nhân: chứa chuỗi, không phân biệt hoa thường. */
  emailContains: string | null;
}

/**
 * Một ô `q` → các điều kiện OR. Mỗi điều kiện chỉ bật khi chuỗi hỏi có dạng
 * phù hợp (vd. "nguyen van" không so với SĐT). Giá trị trả về CHƯA thoát LIKE.
 */
export function buildSearchTerms(q: string | undefined | null): SearchTerms {
  const raw = (q ?? '').trim();
  const none: SearchTerms = {
    codePrefix: null,
    nameContains: null,
    phoneContains: null,
    emailContains: null,
  };
  if (!raw) return none;
  const name = normalizeVietnameseName(raw);
  const phone = normalizeProfilePhone(raw);
  return {
    codePrefix: CODE_QUERY.test(raw) ? raw.toUpperCase() : null,
    nameContains: name || null,
    phoneContains: PHONE_QUERY.test(phone) ? phone : null,
    emailContains: /\s/.test(raw) ? null : raw.toLowerCase(),
  };
}

/* ------------------------------------------------------------------------ */
/* Che dữ liệu trong audit                                                   */
/* ------------------------------------------------------------------------ */

/** `0912345678` → `*******678`. */
export function maskPhone(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= 3) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 3)}${value.slice(-3)}`;
}

/** `nguyen.a@kido.vn` → `n***@kido.vn`. */
export function maskEmail(value: string | null): string | null {
  if (value === null) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${value[0]}***${value.slice(at)}`;
}

/* ------------------------------------------------------------------------ */
/* Ngày sinh                                                                 */
/* ------------------------------------------------------------------------ */

export const MIN_DATE_OF_BIRTH = '1900-01-01';

/** Ngày lịch có thật (loại 2026-02-30), trong [1900-01-01, hôm nay]. */
export function isValidDateOfBirth(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    return false;
  return value >= MIN_DATE_OF_BIRTH && value <= today;
}
