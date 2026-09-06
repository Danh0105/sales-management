import { Transform, Type } from 'class-transformer';
import {
    IsEnum,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidationOptions,
    registerDecorator,
} from 'class-validator';
import { PolicyStatus } from '../policy.enum';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Năm học trong hệ thống: "2026-2027" hoặc "Hè 2026-2027". */
export const SCHOOL_YEAR_PATTERN = /^(Hè\s)?\d{4}-\d{4}$/;

/**
 * YYYY-MM-DD và phải là ngày có thật — chặn "2026-02-31", "2026-13-01".
 * ValidationPipe sẽ tự trả 400 khi không hợp lệ.
 */
export function IsCalendarDate(options?: ValidationOptions) {
    return function (object: object, propertyName: string) {
        registerDecorator({
            name: 'isCalendarDate',
            target: object.constructor,
            propertyName,
            options: {
                message: `${propertyName} phải có dạng YYYY-MM-DD và là ngày hợp lệ`,
                ...options,
            },
            validator: {
                validate(value: unknown) {
                    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
                        return false;
                    }

                    const [year, month, day] = value.split('-').map(Number);
                    const date = new Date(Date.UTC(year, month - 1, day));

                    return (
                        date.getUTCFullYear() === year &&
                        date.getUTCMonth() === month - 1 &&
                        date.getUTCDate() === day
                    );
                },
            },
        });
    };
}

export const POLICY_SORT_FIELDS = [
    'createdAt',
    'updatedAt',
    'schoolName',
    'employeeName',
] as const;

export type PolicySortField = (typeof POLICY_SORT_FIELDS)[number];

export const POLICY_SORT_ORDERS = ['asc', 'desc'] as const;

export type PolicySortOrder = (typeof POLICY_SORT_ORDERS)[number];

export const POLICY_LIST_MAX_LIMIT = 100;

export class QueryPoliciesDto {
    @IsOptional()
    @IsEnum(PolicyStatus, { message: 'status không hợp lệ' })
    status?: PolicyStatus;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    subjectId?: number;

    @IsOptional()
    @IsString()
    @Matches(SCHOOL_YEAR_PATTERN, {
        message: 'schoolYear phải có dạng "2026-2027" hoặc "Hè 2026-2027"',
    })
    schoolYear?: string;

    /**
     * Nhân viên phụ trách trường (schools.employee_id).
     * Chỉ là bộ lọc — phạm vi dữ liệu luôn lấy từ access token, không từ tham số này.
     */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    employeeId?: number;

    /** Lọc theo policy.created_at >= fromDate 00:00:00.000 (giờ hệ thống). */
    @IsOptional()
    @IsCalendarDate()
    fromDate?: string;

    /** Lọc theo policy.created_at <= toDate 23:59:59.999 (giờ hệ thống). */
    @IsOptional()
    @IsCalendarDate()
    toDate?: string;

    /** Tìm không phân biệt hoa thường theo tên trường, tên môn, tên nhân viên, mã hợp đồng. */
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100)
    search?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(POLICY_LIST_MAX_LIMIT)
    limit?: number = 20;

    @IsOptional()
    @IsIn(POLICY_SORT_FIELDS, {
        message: `sortBy phải là một trong: ${POLICY_SORT_FIELDS.join(', ')}`,
    })
    sortBy?: PolicySortField = 'createdAt';

    @IsOptional()
    @Transform(({ value }) =>
        typeof value === 'string' ? value.toLowerCase() : value,
    )
    @IsIn(POLICY_SORT_ORDERS, { message: 'sortOrder phải là asc hoặc desc' })
    sortOrder?: PolicySortOrder = 'desc';
}
