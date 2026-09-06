import { ValueTransformer } from 'typeorm';

/**
 * Postgres `numeric` được driver `pg` trả về dưới dạng chuỗi.
 * Transformer này chuyển về `number` khi đọc và giữ nguyên khi ghi
 * (không làm tròn — cột `numeric` không precision lưu raw input).
 */
export const numericTransformer: ValueTransformer = {
    to: (value?: number | null) => value,
    from: (value?: string | null) =>
        value === null || value === undefined ? value : Number(value),
};
