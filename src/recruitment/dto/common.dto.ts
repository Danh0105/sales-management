import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  Max,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

import { normalizeText } from '../utils/text-normalize';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/** Bỏ khoảng trắng hai đầu; chuỗi rỗng coi như không gửi. */
export function Trim(): PropertyDecorator {
  return Transform((params: TransformFnParams): unknown => {
    const value: unknown = params.value;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  });
}

/** Mảng chuỗi: trim từng phần tử, bỏ phần tử rỗng. */
export function TrimEach(): PropertyDecorator {
  return Transform((params: TransformFnParams): unknown => {
    const value: unknown = params.value;
    return Array.isArray(value)
      ? value
          .map((v: unknown) => (typeof v === 'string' ? v.trim() : v))
          .filter((v) => v !== '')
      : value;
  });
}

/** `"true"/"false"` trong query string → boolean. */
export function QueryBoolean(): PropertyDecorator {
  return Transform((params: TransformFnParams): unknown => {
    const value: unknown = params.value;
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    return value;
  });
}

/** `?status=NEW,SCREENING` hoặc `?status=NEW&status=SCREENING` → mảng. */
export function QueryList(): PropertyDecorator {
  return Transform((params: TransformFnParams): unknown => {
    const value: unknown = params.value;
    if (value === undefined || value === null || value === '') return undefined;
    const list: unknown[] = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [value];
    return list
      .map((v) => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== '');
  });
}

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Thuộc tính nhạy cảm — không được nằm trong metadata của ứng viên/tin nhắn,
 * vì không tiêu chí nào được phép dùng chúng để đánh giá (giới tính, tuổi,
 * tôn giáo, dân tộc, hôn nhân, sức khoẻ, ngoại hình, chính trị...).
 */
export const SENSITIVE_KEY_TOKENS = new Set([
  'gender',
  'sex',
  'gioitinh',
  'religion',
  'tongiao',
  'ethnic',
  'ethnicity',
  'race',
  'dantoc',
  'marital',
  'married',
  'honnhan',
  'health',
  'suckhoe',
  'disease',
  'disability',
  'politic',
  'political',
  'chinhtri',
  'appearance',
  'ngoaihinh',
  'height',
  'chieucao',
  'weight',
  'cannang',
  'age',
  'tuoi',
  'dob',
  'birth',
  'birthday',
  'birthdate',
  'ngaysinh',
  'namsinh',
  'pregnant',
  'pregnancy',
  'mangthai',
]);

export function isSensitiveKey(key: string): boolean {
  const spaced = normalizeText(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
  const tokens = spaced.split(' ').filter(Boolean);
  return (
    tokens.some((t) => SENSITIVE_KEY_TOKENS.has(t)) ||
    SENSITIVE_KEY_TOKENS.has(tokens.join(''))
  );
}

const METADATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const METADATA_MAX_KEYS = 30;
const METADATA_MAX_STRING = 1000;

/** Lý do metadata không hợp lệ, `null` nếu hợp lệ. */
export function metadataProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'metadata phải là object phẳng';
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > METADATA_MAX_KEYS) {
    return `metadata tối đa ${METADATA_MAX_KEYS} khoá`;
  }
  for (const [key, v] of entries) {
    if (!METADATA_KEY.test(key)) return `Khoá metadata "${key}" không hợp lệ`;
    if (isSensitiveKey(key)) {
      return `Không được lưu thuộc tính nhạy cảm "${key}" trong metadata`;
    }
    const ok =
      v === null ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.length <= METADATA_MAX_STRING);
    if (!ok) {
      return `Giá trị metadata "${key}" chỉ được là chuỗi (≤ ${METADATA_MAX_STRING} ký tự), số, boolean hoặc null`;
    }
  }
  return null;
}

/** JSONB metadata: object phẳng, giới hạn kích thước, cấm khoá nhạy cảm. */
export function IsSafeMetadata(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isSafeMetadata',
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate: (value: unknown) => metadataProblem(value) === null,
        defaultMessage: (args: ValidationArguments) =>
          metadataProblem(args.value) ?? 'metadata không hợp lệ',
      },
    });
  };
}
