import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { InterviewStatus } from '../recruitment.enums';
import { PaginationQueryDto, QueryBoolean, Trim } from './common.dto';

/** Tên múi giờ IANA, vd. `Asia/Ho_Chi_Minh`. */
const IANA_TZ = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

class InterviewPlaceDto {
  @IsOptional()
  @Matches(IANA_TZ, {
    message: 'timezone phải là tên IANA, vd. Asia/Ho_Chi_Minh',
  })
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  location?: string;

  @IsOptional()
  @Trim()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(1000)
  meetingUrl?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  interviewerId?: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CreateInterviewSlotDto extends InterviewPlaceDto {
  /** Trống = slot dùng chung cho mọi vị trí. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  jobId?: number;

  /** ISO 8601 có múi giờ, vd. `2026-10-12T09:00:00+07:00`. */
  @IsISO8601({ strict: true })
  startAt!: string;

  @IsISO8601({ strict: true })
  endAt!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  capacity?: number;
}

export class UpdateInterviewSlotDto extends PartialType(
  CreateInterviewSlotDto,
) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QueryInterviewSlotDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  jobId?: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  activeOnly?: boolean;
}

/**
 * HR tạo lịch: chọn `slotId` (giờ lấy theo slot) hoặc tự nhập giờ
 * `scheduledStart/End` — HR được hẹn ngoài slot, AI thì không.
 */
export class CreateInterviewDto extends InterviewPlaceDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  applicationId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  slotId?: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledStart?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledEnd?: string;
}

export class UpdateInterviewDto extends InterviewPlaceDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledStart?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledEnd?: string;

  @IsOptional()
  @IsEnum(InterviewStatus)
  status?: InterviewStatus;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  cancellationReason?: string;
}

export class QueryInterviewDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  applicationId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  candidateId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  jobId?: number;

  @IsOptional()
  @IsEnum(InterviewStatus)
  status?: InterviewStatus;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
