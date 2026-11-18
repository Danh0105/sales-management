import { BadRequestException } from '@nestjs/common';

/**
 * Tiền trong báo cáo thu chi tính bằng BigInt "xu" (1/100 đồng) — cộng trừ
 * không qua số thực dấu phẩy động. Cột numeric của Postgres về dạng chuỗi
 * ("1085860000.00") nên parse thẳng từ chuỗi, không qua Number.
 */
export type Cents = bigint;

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function toCents(value: unknown): Cents {
  if (value === undefined || value === null || value === '') {
    return 0n;
  }

  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toFixed(2)
        : ''
      : typeof value === 'string'
        ? value.trim()
        : '';
  const match = DECIMAL_RE.exec(text);

  if (!match) {
    throw new BadRequestException(
      `Số tiền không hợp lệ: ${text || typeof value}`,
    );
  }

  const [, sign, whole, fraction = ''] = match;
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));

  return sign ? -cents : cents;
}

/** "-1234.5" → "-1234.50"; giữ đủ độ chính xác cho JSON. */
export function centsToString(cents: Cents): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Cho ô số của Excel / hiển thị. An toàn tới ±90.071.992.547.409,91 đồng
 * (2^53 xu) — vượt ngưỡng thì báo lỗi thay vì lặng lẽ làm tròn.
 */
export function centsToNumber(cents: Cents): number {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);

  if (cents > limit || cents < -limit) {
    throw new BadRequestException('Số tiền vượt giới hạn hiển thị');
  }

  return Number(cents) / 100;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
