import { Transform } from 'class-transformer';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Chuỗi rỗng → null: trường không có giá trị lưu NULL, không lưu "". */
export const TrimToNull = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });

/**
 * Số định danh nhận dạng chuỗi thô; chuẩn hoá + kiểm tra định dạng ở
 * `prepareIdentifier` (thông báo lỗi không lặp lại giá trị).
 */
export const SENSITIVE_MAX_INPUT = 64;
