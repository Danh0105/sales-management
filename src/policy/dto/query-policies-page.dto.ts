import { OmitType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { QueryPoliciesDto } from './query-policies.dto';

export const POLICY_PAGE_DEFAULT_LIMIT = 12;
export const POLICY_PAGE_MAX_LIMIT = 100;

/**
 * page/limit được ép về khoảng hợp lệ thay vì trả 400 — FE đổi filter liên tục,
 * một page thừa không nên làm hỏng cả tab. Các ID và ngày vẫn validate chặt (400).
 * Math.trunc để offset luôn là số nguyên (page=2.7 -> 2).
 */
export function clampPage(value: unknown): number {
    return Math.trunc(Math.max(Number(value) || 1, 1));
}

export function clampLimit(value: unknown): number {
    return Math.trunc(
        Math.min(
            Math.max(Number(value) || POLICY_PAGE_DEFAULT_LIMIT, 1),
            POLICY_PAGE_MAX_LIMIT,
        ),
    );
}

/**
 * Query cho GET /policies/all — cùng bộ filter với GET /policies/admin/all,
 * bỏ search/sortBy/sortOrder (endpoint này cố định createdAt DESC, id DESC)
 * và thay validate page/limit bằng clamp.
 */
export class QueryPoliciesPageDto extends OmitType(QueryPoliciesDto, [
    'search',
    'page',
    'limit',
    'sortBy',
    'sortOrder',
] as const) {
    // @Transform chạy trước validator, nên các ràng buộc dưới đây luôn đúng sau khi
    // clamp — chúng tồn tại để `whitelist: true` không loại bỏ hai field này
    // (whitelist chỉ giữ property có decorator của class-validator).
    @Transform(({ value }) => clampPage(value))
    @IsOptional()
    @IsInt()
    @Min(1)
    page: number = 1;

    @Transform(({ value }) => clampLimit(value))
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(POLICY_PAGE_MAX_LIMIT)
    limit: number = POLICY_PAGE_DEFAULT_LIMIT;
}
