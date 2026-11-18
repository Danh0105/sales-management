import { BadRequestException } from '@nestjs/common';

import { MAX_MONEY } from './financial-request.constants';

/**
 * Số học tiền tệ của phân hệ tài chính — KHÔNG dùng số thực.
 *
 * - Tiền VND lưu số nguyên (`bigint` trong DB, `number` an toàn trong JS vì
 *   luôn ≤ MAX_MONEY < Number.MAX_SAFE_INTEGER).
 * - Số lượng (4 chữ số thập phân) và đơn giá (2 chữ số thập phân) đi dạng
 *   chuỗi thập phân, quy về BigInt có hệ số rồi mới nhân.
 * - Thành tiền = SL × đơn giá, làm tròn nửa lên (half-up) tới đồng.
 */

export const QUANTITY_SCALE = 4;
export const UNIT_PRICE_SCALE = 2;

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/** "12.5" với scale 4 → 125000n. Không chấp nhận số âm hoặc vượt số chữ số thập phân. */
export function parseDecimal(
  value: string | number,
  scale: number,
  field = 'Giá trị',
): bigint {
  const text = typeof value === 'number' ? numberToPlain(value) : value.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new BadRequestException(`${field} không hợp lệ: "${value}"`);
  }
  const [, whole, fraction = ''] = match;
  if (fraction.length > scale) {
    const extra = fraction.slice(scale);
    if (/[1-9]/.test(extra)) {
      throw new BadRequestException(
        `${field} chỉ được tối đa ${scale} chữ số thập phân`,
      );
    }
  }
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  return BigInt(whole + padded);
}

function numberToPlain(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value);
  // toFixed(10) tránh dạng 1e-7; phần thừa bị parseDecimal kiểm tra.
  return value.toFixed(10).replace(/\.?0+$/, '');
}

/** 125000n, scale 4 → "12.5000" (định dạng lưu vào cột numeric). */
export function formatDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale ? `.${fraction}` : ''}`;
}

/** Chia rồi làm tròn nửa lên (chỉ cho số không âm). */
function divideRoundHalfUp(value: bigint, divisor: bigint): bigint {
  return (value * 2n + divisor) / (divisor * 2n);
}

/** Thành tiền (VND, số nguyên) của một dòng. */
export function lineAmount(
  quantity: string | number,
  unitPrice: string | number,
): number {
  const qty = parseDecimal(quantity, QUANTITY_SCALE, 'Số lượng');
  const price = parseDecimal(unitPrice, UNIT_PRICE_SCALE, 'Đơn giá');
  const scaled = qty * price; // hệ số 10^(4+2)
  const amount = divideRoundHalfUp(
    scaled,
    10n ** BigInt(QUANTITY_SCALE + UNIT_PRICE_SCALE),
  );
  return toSafeMoney(amount);
}

export function toSafeMoney(value: bigint | number, field = 'Số tiền'): number {
  const big = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (big > BigInt(MAX_MONEY) || big < -BigInt(MAX_MONEY)) {
    throw new BadRequestException(`${field} vượt giới hạn cho phép`);
  }
  return Number(big);
}

/** Kiểm tra một số tiền nhập tay: số nguyên VND, > 0 (hoặc ≥ 0 khi cho phép). */
export function assertMoney(
  value: unknown,
  field: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): number {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isInteger(num)) {
    throw new BadRequestException(`${field} phải là số nguyên VND`);
  }
  if (num < 0 || (!allowZero && num === 0)) {
    throw new BadRequestException(
      `${field} phải ${allowZero ? 'không âm' : 'lớn hơn 0'}`,
    );
  }
  return toSafeMoney(num, field);
}

export function sumMoney(values: Array<number | null | undefined>): number {
  const total = values.reduce<bigint>(
    (acc, value) => acc + BigInt(Math.trunc(Number(value ?? 0))),
    0n,
  );
  return toSafeMoney(total);
}

/** Chia đều một khoản thành n kỳ; phần lẻ dồn vào kỳ cuối. */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const result = Array.from({ length: parts }, () => base);
  result[parts - 1] = total - base * (parts - 1);
  return result;
}

/** Lý do/ý kiến bắt buộc — kiểm tra cả ở service, không chỉ dựa vào DTO. */
export function requireText(
  value: string | null | undefined,
  message: string,
): string {
  const text = value?.trim();
  if (!text) throw new BadRequestException(message);
  return text;
}

/** Bigint của Postgres về number; null giữ nguyên. */
export const bigintTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) =>
    value === null || value === undefined ? value : Number(value),
};

// ---------------------------------------------------------------------------
// Đọc số tiền bằng chữ tiếng Việt
// ---------------------------------------------------------------------------

const DIGITS = [
  'không',
  'một',
  'hai',
  'ba',
  'bốn',
  'năm',
  'sáu',
  'bảy',
  'tám',
  'chín',
];

const GROUP_UNITS = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];

function readTriple(value: number, full: boolean): string {
  const hundreds = Math.floor(value / 100);
  const tens = Math.floor((value % 100) / 10);
  const units = value % 10;
  const words: string[] = [];

  if (full || hundreds > 0) words.push(DIGITS[hundreds], 'trăm');

  if (tens === 0) {
    if (units > 0) {
      if (full || hundreds > 0) words.push('linh');
      words.push(DIGITS[units]);
    }
  } else if (tens === 1) {
    words.push('mười');
    if (units === 5) words.push('lăm');
    else if (units > 0) words.push(DIGITS[units]);
  } else {
    words.push(DIGITS[tens], 'mươi');
    if (units === 1) words.push('mốt');
    else if (units === 4) words.push('tư');
    else if (units === 5) words.push('lăm');
    else if (units > 0) words.push(DIGITS[units]);
  }

  return words.join(' ');
}

/** 1250000 → "Một triệu hai trăm năm mươi nghìn đồng". */
export function vndToWords(amount: number): string {
  if (!Number.isInteger(amount)) amount = Math.round(amount);
  if (amount === 0) return 'Không đồng';

  const negative = amount < 0;
  let rest = Math.abs(amount);
  const groups: number[] = [];
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  const parts: string[] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === 0) continue;
    const isMostSignificant = index === groups.length - 1;
    const text = readTriple(group, !isMostSignificant);
    parts.push(GROUP_UNITS[index] ? `${text} ${GROUP_UNITS[index]}` : text);
  }

  const sentence = `${negative ? 'âm ' : ''}${parts.join(' ')} đồng`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** 1250000 → "1.250.000". */
export function formatVnd(amount: number | null | undefined): string {
  const value = Math.trunc(Number(amount ?? 0));
  const sign = value < 0 ? '-' : '';
  return (
    sign +
    Math.abs(value)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  );
}
