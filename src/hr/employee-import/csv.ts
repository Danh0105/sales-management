/**
 * CSV cho file trao đổi với người duyệt (mở bằng Excel): UTF-8 có BOM, CRLF,
 * RFC 4180 (dấu nháy kép, `""` thoát). Thuần — không I/O.
 *
 * Chống công thức Excel khi GHI: ô bắt đầu bằng = + - @ tab CR được thêm `'`.
 * Khi ĐỌC, bỏ đúng tiền tố `'` đó (chỉ khi theo sau là một ký tự nguy hiểm),
 * để `+84912…` ghi ra rồi đọc lại vẫn là `+84912…`.
 */
export const UTF8_BOM = String.fromCharCode(0xfeff);
const DANGEROUS_START = /^[=+\-@\t\r]/;

export type CsvValue = string | number | boolean | null | undefined;

export function csvCell(value: CsvValue): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (DANGEROUS_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvText(header: string[], rows: CsvValue[][]): string {
  const lines = [
    header.map(csvCell).join(','),
    ...rows.map((r) => r.map(csvCell).join(',')),
  ];
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/** Bỏ tiền tố chống công thức `'` mà `csvCell` đã thêm. */
function unguard(cell: string): string {
  return cell.startsWith("'") && DANGEROUS_START.test(cell.slice(1))
    ? cell.slice(1)
    : cell;
}

/**
 * Đọc CSV → mảng dòng (mỗi dòng là mảng ô). Bỏ BOM, chấp nhận CRLF/LF, bỏ
 * dòng trống hoàn toàn. Dấu nháy không đóng → lỗi (không đoán).
 */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endCell = () => {
    row.push(unguard(cell));
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i++;
    } else if (c === ',') {
      endCell();
      i++;
    } else if (c === '\r' && src[i + 1] === '\n') {
      endRow();
      i += 2;
    } else if (c === '\n' || c === '\r') {
      endRow();
      i++;
    } else {
      cell += c;
      i++;
    }
  }
  if (quoted) throw new Error('CSV lỗi: dấu nháy kép không được đóng');
  if (cell !== '' || row.length) endRow();
  return rows;
}
