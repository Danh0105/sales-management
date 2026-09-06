import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsEnum,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    Max,
    Min,
    ValidateNested,
} from 'class-validator';
import { AssignmentStatus, DAY_OF_WEEK_VALUES } from '../teaching.enum';
import { TIME_PATTERN } from './teaching-schedule.dto';
import { IsCalendarDate } from '../../policy/dto/query-policies.dto';

const trim = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value;

const toBool = ({ value }: { value: unknown }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
};

/** Mỗi lần gọi tối đa bấy nhiêu lớp — chặn một cú bấm nhầm tạo cả nghìn bản ghi. */
export const MAX_BULK_ITEMS = 200;

/** Số buổi tối đa một lần tạo hàng loạt (số lớp × số ngày). */
export const MAX_BULK_SESSIONS = 500;

export const MAX_BULK_DATES = 31;

/**
 * Một lớp trong lô. Mọi field ngoài `classId` đều tuỳ chọn — bỏ trống thì lấy
 * giá trị mặc định ở cấp lô, có thì ghi đè riêng cho lớp này.
 */
export class BulkScheduleItemDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    classId!: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    teacherId?: number;

    /** Chỉ định thẳng môn của trường, bỏ qua việc tra theo `catalogId`. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    subjectId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsIn(DAY_OF_WEEK_VALUES, {
        message: 'dayOfWeek phải từ 2 (Thứ Hai) đến 8 (Chủ Nhật)',
    })
    dayOfWeek?: number;

    @IsOptional()
    @Matches(TIME_PATTERN, { message: 'startTime phải có dạng HH:mm' })
    startTime?: string;

    @IsOptional()
    @Matches(TIME_PATTERN, { message: 'endTime phải có dạng HH:mm' })
    endTime?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(20)
    periods?: number;

    @IsOptional()
    @IsCalendarDate()
    effectiveFrom?: string;

    @IsOptional()
    @IsCalendarDate()
    effectiveTo?: string;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(1000)
    note?: string;
}

/** Khoảng ngày sinh buổi ngay sau khi tạo mẫu lịch. */
export class BulkGenerateSessionsDto {
    @IsCalendarDate()
    fromDate!: string;

    @IsCalendarDate()
    toDate!: string;
}

/**
 * Áp một môn cho nhiều lớp của nhiều trường trong một lần gọi.
 *
 * `catalogId` là môn trong **danh mục dùng chung** (STEM, Kỹ năng sống…);
 * backend tự tra ra môn tương ứng của **từng trường** theo năm học của lớp,
 * nên Nhân sự chỉ chọn môn một lần thay vì mở từng trường.
 */
export class BulkCreateSchedulesDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    catalogId?: number;

    /**
     * Năm học dùng để tra môn của trường. Bỏ trống = lấy theo năm học của
     * từng lớp (thường là đúng), truyền vào khi lớp và môn khai lệch năm.
     */
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(20)
    schoolYear?: string;

    // ---- Giá trị mặc định áp cho mọi lớp trong lô ----

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    teacherId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsIn(DAY_OF_WEEK_VALUES, {
        message: 'dayOfWeek phải từ 2 (Thứ Hai) đến 8 (Chủ Nhật)',
    })
    dayOfWeek?: number;

    @IsOptional()
    @Matches(TIME_PATTERN, { message: 'startTime phải có dạng HH:mm' })
    startTime?: string;

    @IsOptional()
    @Matches(TIME_PATTERN, { message: 'endTime phải có dạng HH:mm' })
    endTime?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(20)
    periods?: number;

    @IsOptional()
    @IsCalendarDate()
    effectiveFrom?: string;

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

    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_BULK_ITEMS, {
        message: `Mỗi lần tối đa ${MAX_BULK_ITEMS} lớp`,
    })
    @ValidateNested({ each: true })
    @Type(() => BulkScheduleItemDto)
    items!: BulkScheduleItemDto[];

    /** Có thì sinh luôn buổi dạy cho các mẫu vừa tạo — gộp 2 bước làm 1. */
    @IsOptional()
    @ValidateNested()
    @Type(() => BulkGenerateSessionsDto)
    generateSessions?: BulkGenerateSessionsDto;
}

export class BulkSessionItemDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    classId!: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    teacherId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    subjectId?: number;

    @IsOptional()
    @IsCalendarDate()
    date?: string;

    @IsOptional()
    @Matches(TIME_PATTERN, { message: 'startTime phải có dạng HH:mm' })
    startTime?: string;

    @IsOptional()
    @Matches(TIME_PATTERN, { message: 'endTime phải có dạng HH:mm' })
    endTime?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(20)
    periods?: number;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(1000)
    note?: string;
}

/**
 * Tạo tiết lẻ cho nhiều lớp × nhiều ngày trong một lần gọi.
 * Không có `teacherId` thì tiết được tạo ở trạng thái `OPEN` để giáo viên đăng ký.
 */
export class BulkCreateSessionsDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    catalogId?: number;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(20)
    schoolYear?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    teacherId?: number;

    @IsOptional()
    @IsEnum(AssignmentStatus, { message: 'assignmentStatus không hợp lệ' })
    assignmentStatus?: AssignmentStatus;

    /** Một ngày duy nhất; dùng `dates` khi cần nhiều ngày. */
    @IsOptional()
    @IsCalendarDate()
    date?: string;

    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_BULK_DATES, {
        message: `Mỗi lần tối đa ${MAX_BULK_DATES} ngày`,
    })
    @IsCalendarDate({ each: true })
    dates?: string[];

    @IsOptional()
    @Matches(TIME_PATTERN, { message: 'startTime phải có dạng HH:mm' })
    startTime?: string;

    @IsOptional()
    @Matches(TIME_PATTERN, { message: 'endTime phải có dạng HH:mm' })
    endTime?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(20)
    periods?: number;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(1000)
    note?: string;

    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_BULK_ITEMS, {
        message: `Mỗi lần tối đa ${MAX_BULK_ITEMS} lớp`,
    })
    @ValidateNested({ each: true })
    @Type(() => BulkSessionItemDto)
    items!: BulkSessionItemDto[];
}
