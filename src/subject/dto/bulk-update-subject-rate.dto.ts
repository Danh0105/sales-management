import { Type } from 'class-transformer';
import {
    ArrayMinSize,
    IsArray,
    IsInt,
    IsNumber,
    Max,
    Min,
} from 'class-validator';
import { MAX_RATE_PER_PERIOD } from './create-subject.dto';

/**
 * Áp một đơn giá cho nhiều môn học (mỗi dòng là môn của một trường) cùng lúc —
 * dùng khi nhiều trường dạy cùng một môn và Nhân sự thoả cùng một mức giá.
 * Nhận `subjectIds` tường minh (không phải `catalogId` + "áp cho tất cả") để
 * Nhân sự tự chọn đúng những trường muốn áp, tránh đè giá của trường có hợp
 * đồng khác.
 */
export class BulkUpdateSubjectRateDto {
    @IsArray()
    @ArrayMinSize(1)
    @Type(() => Number)
    @IsInt({ each: true })
    subjectIds!: number[];

    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @Max(MAX_RATE_PER_PERIOD)
    ratePerPeriod!: number;
}
