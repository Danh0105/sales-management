/**
 * Chuẩn hoá số tiền nhận từ client.
 *
 * `@Type(() => Number)` một mình là không đủ, và nguy hiểm: nó gọi thẳng
 * `Number()`, mà quy ước số của tiếng Việt ngược với JavaScript — dấu `.` là
 * phân cách nghìn, không phải dấu thập phân. Hệ quả là `"500.000"` (năm trăm
 * nghìn) bị hiểu thành `500` và **lưu vào database mà không báo lỗi gì**. Sai
 * một phần nghìn số tiền, im lặng, là kiểu lỗi tệ nhất.
 *
 * Ở đây phân cách nghìn chỉ được chấp nhận khi nó thật sự là nhóm 3 chữ số
 * (`1.234.567` hoặc `1,234,567`). Chuỗi mập mờ thì trả `NaN` để `@IsNumber()`
 * bắt và người dùng nhận thông báo, thay vì nhận một con số sai.
 */

/** Nhóm nghìn kiểu Việt Nam: 1.234 · 1.234.567 */
const VN_GROUPED = /^\d{1,3}(\.\d{3})+$/;

/** Nhóm nghìn kiểu Anh: 1,234 · 1,234,567 */
const EN_GROUPED = /^\d{1,3}(,\d{3})+$/;

/** Số thường, cho phép tối đa 2 chữ số thập phân sau dấu chấm. */
const PLAIN = /^\d+(\.\d{1,2})?$/;

/**
 * `NaN` cho mọi thứ không chắc chắn — cố ý, để tầng validate báo lỗi thay vì
 * đoán bừa. `undefined`/`null`/chuỗi rỗng giữ nguyên `undefined` để thông báo
 * là "thiếu số tiền" chứ không phải "số tiền sai".
 */
export function parseMoney(value: unknown): number | undefined | typeof NaN {
    if (value === undefined || value === null || value === '') return undefined;

    if (typeof value === 'number') return value;

    if (typeof value !== 'string') return NaN;

    // Bỏ khoảng trắng (kể cả khoảng trắng hẹp mà một số bàn phím chèn vào) và
    // ký hiệu tiền tệ người dùng hay gõ kèm.
    const cleaned = value
        .replace(/[\s  ]/g, '')
        .replace(/(đ|VND|vnd|₫)$/u, '');

    if (cleaned === '') return undefined;

    if (VN_GROUPED.test(cleaned)) return Number(cleaned.replace(/\./g, ''));
    if (EN_GROUPED.test(cleaned)) return Number(cleaned.replace(/,/g, ''));
    if (PLAIN.test(cleaned)) return Number(cleaned);

    return NaN;
}

/** Dùng trong DTO: `@Transform(toMoney)` thay cho `@Type(() => Number)`. */
export const toMoney = ({ value }: { value: unknown }) => parseMoney(value);
