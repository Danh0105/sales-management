import {
    IsOptional,
    IsNumber,
    IsString,
    IsDateString,
    IsObject,
    Max,
    Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Trần đơn giá mỗi tiết (VND) — chặn gõ thừa số 0, không phải giới hạn nghiệp vụ. */
export const MAX_RATE_PER_PERIOD = 100_000_000;

export class CreateSubjectDto {
    /**
     * Môn học chọn từ danh mục (`GET /subject-catalogs`). Ưu tiên dùng field này —
     * tên môn sẽ lấy theo danh mục.
     */
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    catalogId?: number;

    /**
     * Client cũ: gửi tên môn. Tên phải khớp một môn có trong danh mục,
     * nếu không sẽ bị từ chối (không còn cho nhập tự do).
     */
    @IsOptional()
    @IsString()
    name?: string;

    @Type(() => Number)
    @IsNumber()
    schoolId!: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    schoolLocationId?: number | null;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    status?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    studentCount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    totalLessons?: number;

    /** Cho phép số lẻ (8.5); chốt 2 chữ số thập phân đúng bằng cột DB. */
    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    contractDuration?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    appendixDuration?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    classCount?: number;

    @IsOptional()
    @IsDateString()
    startDate?: string;

    @IsOptional()
    @IsString()
    contractNumber?: string;

    @IsOptional()
    @IsObject()
    data?: Record<string, any>;

    @IsOptional()
    @IsString()
    schoolYear?: string;

    /** Đơn giá mỗi tiết dạy môn này tại trường này — chỉ Nhân sự được khai. */
    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @Max(MAX_RATE_PER_PERIOD)
    ratePerPeriod?: number | null;
}