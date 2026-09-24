import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  Max,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { AssignmentStatus, ConfirmationStatus, SessionStatus } from '../teaching.enum';
import { TIME_PATTERN } from './teaching-schedule.dto';
import { IsCalendarDate } from '../../policy/dto/query-policies.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toBool = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

/** Tạo buổi lẻ hoặc buổi dạy bù (không thuộc mẫu lặp nào). */
export class CreateTeachingSessionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teacherId?: number | null;

  @IsOptional()
  @IsEnum(AssignmentStatus, { message: 'assignmentStatus không hợp lệ' })
  assignmentStatus?: AssignmentStatus;

  /** Lớp được dạy buổi này. Bỏ trống thì phải gửi `schoolId` (buổi cũ xếp theo trường). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  classId?: number;

  /** Tuỳ chọn khi đã có `classId` — khi đó trường lấy theo lớp. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  schoolId?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  subjectId!: number;

  @IsCalendarDate()
  date!: string;

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

  /** Buổi này dạy bù cho buổi nào — tự động bật isMakeup. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  makeupForSessionId?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Sửa buổi: đổi giờ, đổi giáo viên dạy thay, huỷ buổi. */
export class UpdateTeachingSessionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teacherId?: number | null;

  @IsOptional()
  @IsEnum(AssignmentStatus, { message: 'assignmentStatus không hợp lệ' })
  assignmentStatus?: AssignmentStatus;

  /** Đổi lớp cho buổi này — lớp phải cùng trường với buổi đang sửa. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  classId?: number;

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

/** Chấm công một buổi. */
export class AttendanceOtherCostDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000_000)
  amount!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CheckAttendanceDto {
  @IsEnum(SessionStatus, { message: 'status không hợp lệ' })
  status!: SessionStatus;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  attendanceNote?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AttendanceOtherCostDto)
  otherCosts?: AttendanceOtherCostDto[];
}

const requiredMultipartNumber = ({ value }: { value: unknown }) =>
  value === '' || value === null || value === undefined
    ? Number.NaN
    : Number(value);

export class CheckinTeachingSessionDto {
  @Transform(requiredMultipartNumber)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Transform(requiredMultipartNumber)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;
}

const optionalMultipartNumber = ({ value }: { value: unknown }) => {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 'null'
  ) {
    return undefined;
  }
  return Number(value);
};

export class CheckoutTeachingSessionDto {
  @Transform(requiredMultipartNumber)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Transform(requiredMultipartNumber)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @Transform(optionalMultipartNumber)
  @IsInt()
  @Min(0)
  accuracy?: number;
}

/**
 * Nộp nội dung bài dạy không cần GPS — cho tiết giữa/tiết đầu của một block
 * nhiều tiết liên tiếp cùng trường (tiết đó không phải check-in/check-out
 * riêng, nhưng vẫn phải ghi nội dung bài dạy như mọi tiết khác).
 */
export class SubmitLessonDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  lessonName!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  lessonEvaluation!: string;

  @Transform(optionalMultipartNumber)
  @IsInt()
  @Min(0)
  actualStudentCount!: number;
}

export class ApplyTeachingSessionDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  accuracy?: number | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class AssignTeachingSessionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teacherId!: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  override?: boolean;
}

/**
 * Đổi/gán giáo viên cho nhiều buổi đã chọn trên bảng Chấm công cùng lúc.
 * Mỗi buổi vẫn qua đủ kiểm tra của gán 1 buổi (khoá chấm công, trùng lịch,
 * định mức tuần) — buổi nào lỗi bị bỏ qua và báo lại riêng.
 */
export class BulkAssignTeachingSessionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200, { message: 'Mỗi lần đổi tối đa 200 buổi' })
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  sessionIds!: number[];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  teacherId!: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  override?: boolean;
}

/** Giáo viên xác nhận hoặc từ chối buổi dạy được giao. */
export class ConfirmTeachingSessionDto {
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

/** Giáo viên xin rút khỏi buổi đã phân công vì có việc đột xuất. */
export class DeclineTeachingSessionDto {
  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Vui lòng nhập lý do ít nhất 5 ký tự' })
  @MaxLength(500)
  reason!: string;
}

export class NotifyTeachingScheduleDto {
  @IsCalendarDate()
  fromDate!: string;

  @IsCalendarDate()
  toDate!: string;

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
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class BulkAttendanceItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sessionId!: number;

  @IsEnum(SessionStatus, { message: 'status không hợp lệ' })
  status!: SessionStatus;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  attendanceNote?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AttendanceOtherCostDto)
  otherCosts?: AttendanceOtherCostDto[];
}

/** Chấm công nhiều buổi một lần — màn chấm công theo ngày/tuần. */
export class BulkCheckAttendanceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200, { message: 'Mỗi lần chấm tối đa 200 buổi' })
  @ValidateNested({ each: true })
  @Type(() => BulkAttendanceItemDto)
  items!: BulkAttendanceItemDto[];
}

export class QueryTeachingSessionsDto {
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
   * Khu vực (tỉnh/thành) của trường dạy. Buổi dạy không tự giữ khu vực — suy ra
   * qua `school.ward.province_id`. Lọc ở đây chứ không lọc ở client vì danh
   * sách phân trang phía server: lọc trang hiện tại sẽ ra số liệu sai.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  provinceId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  subjectId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  classId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  scheduleId?: number;

  @IsOptional()
  @IsEnum(SessionStatus, { message: 'status không hợp lệ' })
  status?: SessionStatus;

  /** true = chỉ buổi chưa chấm công. */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  unchecked?: boolean;

  @IsOptional()
  @IsCalendarDate()
  fromDate?: string;

  @IsOptional()
  @IsCalendarDate()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}

/** Bảng tổng hợp chấm công theo giáo viên trong khoảng ngày. */
/**
 * Rà soát quãng đường di chuyển. Cố ý không có lọc trường/lớp: lọc bớt điểm
 * dừng là cắt đứt lộ trình trong ngày, số km liên trường sẽ sai.
 */
export class QueryTravelReviewDto {
  @IsCalendarDate()
  fromDate!: string;

  @IsCalendarDate()
  toDate!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teacherId?: number;
}

export class QueryAttendanceSummaryDto {
  @IsCalendarDate()
  fromDate!: string;

  @IsCalendarDate()
  toDate!: string;

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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  classId?: number;
}
