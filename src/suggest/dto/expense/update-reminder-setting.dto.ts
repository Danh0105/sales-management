import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateReminderSettingDto {
    /** Số ngày nhắc trước ngày dự kiến chi */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(30)
    remindBeforeDays?: number;

    /** Bật/tắt toàn bộ cảnh báo đến hạn của đề xuất chi */
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}
