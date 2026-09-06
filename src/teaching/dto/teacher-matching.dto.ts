import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import { IsCalendarDate } from '../../policy/dto/query-policies.dto';
import { DAY_OF_WEEK_VALUES } from '../teaching.enum';
import { TIME_PATTERN } from './teaching-schedule.dto';

/**
 * Ô lịch cần tìm giáo viên. Cố ý **không** yêu cầu mẫu lịch đã tồn tại: luồng
 * nhập thời khoá biểu từ ảnh cần xếp hạng giáo viên *trước khi* tạo bản ghi nào.
 */
export class FindTeacherCandidatesDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId!: number;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    subjectId!: number;

    @Type(() => Number)
    @IsInt()
    @IsIn(DAY_OF_WEEK_VALUES, {
        message: 'dayOfWeek phải từ 2 (Thứ Hai) đến 8 (Chủ Nhật)',
    })
    dayOfWeek!: number;

    @Matches(TIME_PATTERN, { message: 'startTime phải có dạng HH:mm' })
    startTime!: string;

    @Matches(TIME_PATTERN, { message: 'endTime phải có dạng HH:mm' })
    endTime!: string;

    @IsCalendarDate()
    effectiveFrom!: string;

    @IsOptional()
    @IsCalendarDate()
    effectiveTo?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(20)
    periods?: number;

    /** Bỏ qua khi xét trùng lịch — dùng khi đang đổi giáo viên của chính mẫu này. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    exceptScheduleId?: number;
}
