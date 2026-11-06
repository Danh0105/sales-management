import { Type } from 'class-transformer';
import {
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
} from 'class-validator';

export class SchoolDirectoryQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    /** Tìm theo tên trường hoặc mã số thuế. */
    @IsOptional()
    @IsString()
    @MaxLength(100)
    keyword?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    provinceId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    wardId?: number;
}
