import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  ApplicationStatus,
  ChannelEventExcludeReason,
  ChannelOutboxStatus,
  HrAlertStatus,
  HrAlertType,
} from '../recruitment.enums';

/** HR gửi tin cho ứng viên qua kênh (Zalo OA tuyển dụng). */
export class HrMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;

  /**
   * Khoá idempotent do client sinh (vd. UUID) — bấm gửi lại / mạng chập chờn không
   * tạo tin thứ hai.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  clientMessageId!: string;
}

export class ResumeConversationAiDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** Trạng thái hồ sơ khi rời NEEDS_HR_REVIEW (mặc định COLLECTING_INFO). */
  @IsOptional()
  @IsEnum(ApplicationStatus)
  applicationStatus?: ApplicationStatus;
}

export class MarkOutboxSentDto {
  /** Id tin phía Zalo nếu người vận hành tra được. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,128}$/)
  providerMessageId?: string;
}

/** R1 — loại event inbox khỏi xử lý nghiệp vụ; lý do bắt buộc, chỉ giá trị đã định nghĩa. */
export class ExcludeChannelEventDto {
  @IsEnum(ChannelEventExcludeReason)
  reason!: ChannelEventExcludeReason;
}

export class RetryOutboxDto {
  /** Bắt buộc `true`: người vận hành chấp nhận khả năng ứng viên nhận trùng tin. */
  @IsOptional()
  @IsBoolean()
  confirmDuplicateRisk?: boolean;
}

export class OutboxQueryDto {
  @IsOptional()
  @IsEnum(ChannelOutboxStatus)
  status?: ChannelOutboxStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class HrAlertQueryDto {
  @IsOptional()
  @IsEnum(HrAlertStatus)
  status?: HrAlertStatus;

  @IsOptional()
  @IsEnum(HrAlertType)
  type?: HrAlertType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class OperationsListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
