import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import {
  HandoffPriority,
  HandoffReason,
  HandoffStatus,
} from '../recruitment.enums';
import { DATE_ONLY, PaginationQueryDto, Trim } from './common.dto';

export class QueryHandoffDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(HandoffStatus)
  status?: HandoffStatus;

  @IsOptional()
  @IsEnum(HandoffReason)
  reason?: HandoffReason;

  @IsOptional()
  @IsEnum(HandoffPriority)
  priority?: HandoffPriority;

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
}

export class ResolveHandoffDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class DashboardQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  jobId?: number;

  /** Lọc theo ngày tạo hồ sơ, `YYYY-MM-DD` (giờ Việt Nam). */
  @IsOptional()
  @Matches(DATE_ONLY)
  fromDate?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  toDate?: string;
}
