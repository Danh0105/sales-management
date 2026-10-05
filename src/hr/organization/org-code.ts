import { EntityManager } from 'typeorm';

/**
 * Mã do hệ thống sinh cho danh mục tổ chức (quyết định 30/09/2026):
 * đơn vị `DV` + 4 số, chức danh `CD` + 4 số. Người dùng không nhập/sửa mã.
 *
 * - Lấy số từ sequence (migration 1791700000900) — không tái sử dụng số đã
 *   cấp; số bị bỏ qua khi transaction rollback là chấp nhận được.
 * - Mã tạo tay trước đây trùng định dạng (vd. DV0003) → bỏ qua, lấy số kế.
 * - Mã đã cấp không đổi (immutable) — không có API sửa mã.
 */
export interface CodeSeries {
  prefix: 'DV' | 'CD';
  sequence: string;
  table: string;
  label: string;
}

export const ORG_CODE_DIGITS = 4;
export const ORG_CODE_MAX = 10 ** ORG_CODE_DIGITS - 1;

export const ORG_UNIT_CODES: CodeSeries = {
  prefix: 'DV',
  sequence: '"hr"."org_unit_code_seq"',
  table: '"hr"."org_units"',
  label: 'đơn vị',
};

export const POSITION_CODES: CodeSeries = {
  prefix: 'CD',
  sequence: '"hr"."position_code_seq"',
  table: '"hr"."positions"',
  label: 'chức danh',
};

/** Số mã tạo tay liên tiếp tối đa được bỏ qua trong một lần cấp. */
const MAX_SKIP = 100;

export function formatSeriesCode(series: CodeSeries, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > ORG_CODE_MAX)
    throw new Error(
      `Số thứ tự mã ${series.label} phải trong khoảng 1–${ORG_CODE_MAX}`,
    );
  return `${series.prefix}${String(n).padStart(ORG_CODE_DIGITS, '0')}`;
}

export interface SequenceState {
  lastValue: number;
  isCalled: boolean;
}

/**
 * DỰ ĐOÁN `count` mã kế tiếp (xem trước, không tiêu số): bắt đầu từ trạng
 * thái sequence, bỏ qua mã đã có. Kết quả thật khi ghi có thể khác nếu có
 * người tạo thêm trong lúc đó — CLI in lại mã thật sau khi ghi.
 */
export function predictCodes(
  series: CodeSeries,
  count: number,
  state: SequenceState,
  taken: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  let n = state.isCalled ? state.lastValue + 1 : state.lastValue;
  while (out.length < count) {
    if (n > ORG_CODE_MAX)
      throw new Error(
        `Hết mã ${series.label} (${series.prefix}${ORG_CODE_MAX})`,
      );
    const code = formatSeriesCode(series, n++);
    if (!taken.has(code)) out.push(code);
  }
  return out;
}

export async function readSequenceState(
  manager: EntityManager,
  series: CodeSeries,
): Promise<SequenceState> {
  const [row] = await manager.query<
    { last_value: string; is_called: boolean }[]
  >(`SELECT "last_value", "is_called" FROM ${series.sequence}`);
  return { lastValue: Number(row.last_value), isCalled: row.is_called };
}

/**
 * Cấp mã mới trong transaction của thao tác tạo. Đơn vị: nơi gọi đã giữ
 * advisory lock của cơ cấu (mọi đường tạo đơn vị đều giữ) → kiểm tra tồn tại
 * rồi ghi không bị đua. Chức danh: unique index vẫn là lưới an toàn.
 */
export async function allocateCode(
  manager: EntityManager,
  series: CodeSeries,
): Promise<string> {
  for (let i = 0; i < MAX_SKIP; i++) {
    const [{ seq }] = await manager.query<{ seq: string }[]>(
      `SELECT nextval('${series.sequence}') AS seq`,
    );
    const code = formatSeriesCode(series, Number(seq));
    const [{ taken }] = await manager.query<{ taken: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM ${series.table} WHERE "code" = $1) AS taken`,
      [code],
    );
    if (!taken) return code;
  }
  throw new Error(
    `Không cấp được mã ${series.label}: quá nhiều mã tạo tay liên tiếp`,
  );
}
