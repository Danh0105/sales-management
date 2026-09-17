import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    Max,
    Min,
} from 'class-validator';
import { ConfirmationStatus, DAY_OF_WEEK_VALUES } from '../teaching.enum';
import { IsCalendarDate } from '../../policy/dto/query-policies.dto';

/** "HH:mm" hoặc "HH:mm:ss" — Postgres trả về dạng "HH:mm:ss". */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const trim = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value;

const toBool = ({ value }: { value: unknown }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
};

export class CreateTeachingScheduleDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    teacherId!: number;

    /** Lớp được xếp lịch. Trường lấy theo lớp, không xếp lịch cho cả trường nữa. */
    @Type(() => Number)
    @IsInt()
    @Min(1)
    classId!: number;

    /** Tuỳ chọn — chỉ để đối chiếu: phải đúng trường của `classId`, nếu không 400. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId?: number;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    subjectId!: number;

    /** 2 = Thứ Hai … 7 = Thứ Bảy, 8 = Chủ Nhật. */
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

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(20)
    periods?: number;

    @IsCalendarDate()
    effectiveFrom!: string;

    @IsOptional()
    @IsCalendarDate()
    effectiveTo?: string;

    @IsOptional()
    @Transform(toBool)
    @IsBoolean()
    isActive?: boolean;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(1000)
    note?: string;
}

export class UpdateTeachingScheduleDto extends PartialType(
    CreateTeachingScheduleDto,
) {}

export class QueryTeachingSchedulesDto {
    /**
     * Lọc theo trạng thái phản hồi của giáo viên. Đặc biệt dùng
     * `confirmationStatus=REJECTED` ở màn xếp lịch để hiện các tiết cần xếp lại.
     */
    @IsOptional()
    @IsIn(Object.values(ConfirmationStatus), {
        message: 'confirmationStatus phải là PENDING, CONFIRMED hoặc REJECTED',
    })
    confirmationStatus?: ConfirmationStatus;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    teacherId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId?: number;

    /**
     * Khu vực (tỉnh/thành) của trường — suy qua `school.ward.province_id`.
     * Có ở đây để màn Chấm công lọc theo khu vực thì các lịch chờ xác nhận vẽ
     * đè lên thời khoá biểu cũng thu theo đúng khu vực đó.
     */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    provinceId?: number;

    /**
     * Thu hẹp về một điểm trường (cơ sở) của trường đã chọn — trường nhiều cơ
     * sở thì mỗi cơ sở có thời khoá biểu riêng. `0` = chỉ lịch của trường chính
     * (lớp không gắn điểm trường).
     */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    schoolLocationId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    classId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    subjectId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsIn(DAY_OF_WEEK_VALUES)
    dayOfWeek?: number;

    @IsOptional()
    @Transform(toBool)
    @IsBoolean()
    isActive?: boolean;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number = 20;
}

/** Sinh buổi dạy cụ thể từ mẫu lặp cho khoảng ngày chỉ định. */
export class GenerateSessionsDto {
    @IsCalendarDate()
    fromDate!: string;

    @IsCalendarDate()
    toDate!: string;
}

/** Giáo viên xác nhận hoặc từ chối mẫu lịch được giao. */
export class ConfirmTeachingScheduleDto {
    @IsIn([ConfirmationStatus.CONFIRMED, ConfirmationStatus.REJECTED], {
        message: 'status phải là CONFIRMED hoặc REJECTED',
    })
    status!: ConfirmationStatus.CONFIRMED | ConfirmationStatus.REJECTED;

    /** Bắt buộc khi status = REJECTED. */
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(1000)
    reason?: string;
}

/**
 * Xoá cả một mảng thời khoá biểu: toàn bộ tiết của một trường, hoặc chỉ tiết
 * của một môn trong trường đó.
 *
 * `schoolId` bắt buộc và không có "xoá tất cả": một request thiếu tham số
 * không được phép quét sạch thời khoá biểu của mọi trường.
 */
export class RemoveSchedulesBySchoolDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId!: number;

    /** Bỏ trống = xoá mọi môn của trường. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    subjectId?: number;
}

/**
 * Áp một khoảng hiệu lực cho **mọi tiết** của một trường (tuỳ chọn: một
 * điểm trường / một môn) trong một lần gọi — thay vì sửa từng tiết trên TKB.
 */
export class ApplyEffectiveRangeDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId!: number;

    /** Bỏ trống = mọi điểm trường; 0 = chỉ trường chính (tiết chưa gắn điểm). */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    schoolLocationId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    subjectId?: number;

    @IsCalendarDate()
    effectiveFrom!: string;

    /** Bỏ trống hoặc null = không thời hạn. */
    @IsOptional()
    @IsCalendarDate()
    effectiveTo?: string | null;

    /** Mặc định chỉ áp cho tiết đang áp dụng; bật để áp cả tiết đã tắt. */
    @IsOptional()
    @Transform(toBool)
    @IsBoolean()
    includeInactive?: boolean;
}
