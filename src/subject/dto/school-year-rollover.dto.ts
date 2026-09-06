import { Type } from 'class-transformer';
import {
    ArrayNotEmpty,
    IsArray,
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    MaxLength,
    Min,
} from 'class-validator';

export class SchoolYearRolloverDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId!: number;

    /** Năm học nguồn, VD "2025-2026". */
    @IsString()
    @MaxLength(20)
    fromYear!: string;

    @IsString()
    @MaxLength(20)
    toYear!: string;

    /**
     * Chỉ áp những môn này (id môn **của năm nguồn**). Bỏ trống = áp toàn bộ
     * môn của năm nguồn, giữ nguyên hành vi cũ.
     */
    @IsOptional()
    @IsArray()
    @ArrayNotEmpty()
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    subjectIds?: number[];

    /**
     * Mặc định **true**: gọi mà quên tham số thì chỉ xem trước. Muốn tạo dữ
     * liệu thật phải gửi `false` một cách có ý thức.
     */
    @IsOptional()
    @Type(() => Boolean)
    @IsBoolean()
    dryRun?: boolean = true;
}
