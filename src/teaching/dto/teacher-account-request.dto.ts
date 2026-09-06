import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { TeacherAccountRequestStatus } from '../entities/teacher-account-request.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class QueryTeacherAccountRequestsDto {
  /** Bỏ trống = các hồ sơ đang chờ Nhân sự duyệt. */
  @IsOptional()
  @IsEnum(TeacherAccountRequestStatus)
  status?: TeacherAccountRequestStatus;

  /** Lọc theo người gửi đề nghị; Giáo vụ luôn bị ép về chính mình. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requestedBy?: number;
}

export class ReviewTeacherAccountRequestDto {
  /** Lý do từ chối — hiển thị lại cho Giáo vụ đã gửi đề nghị. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}
