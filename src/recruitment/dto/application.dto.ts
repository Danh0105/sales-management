import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import {
  AiMatchLevel,
  ApplicationStatus,
  CandidateSource,
} from '../recruitment.enums';
import {
  DATE_ONLY,
  PaginationQueryDto,
  QueryBoolean,
  QueryList,
  Trim,
} from './common.dto';

export class CreateApplicationDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  candidateId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  jobId!: number;

  @IsOptional()
  @IsEnum(CandidateSource)
  source?: CandidateSource;
}

export const APPLICATION_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'aiMatchScore',
] as const;

export class QueryApplicationDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  jobId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  candidateId?: number;

  /** Một hoặc nhiều trạng thái: `?status=NEW,SCREENING`. */
  @IsOptional()
  @QueryList()
  @IsEnum(ApplicationStatus, { each: true })
  status?: ApplicationStatus[];

  @IsOptional()
  @IsEnum(CandidateSource)
  source?: CandidateSource;

  @IsOptional()
  @IsEnum(AiMatchLevel)
  matchLevel?: AiMatchLevel;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  aiPaused?: boolean;

  /** Theo ngày tạo hồ sơ (giờ Việt Nam), `YYYY-MM-DD`. */
  @IsOptional()
  @Matches(DATE_ONLY)
  fromDate?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  toDate?: string;

  /** Tên, SĐT hoặc email ứng viên. */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsIn(APPLICATION_SORT_FIELDS)
  sort?: (typeof APPLICATION_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';
}

export class UpdateApplicationStatusDto {
  @IsEnum(ApplicationStatus)
  status!: ApplicationStatus;

  /** Bắt buộc khi chuyển REJECTED. */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  rejectedReason?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** HR trả hồ sơ về cho AI tiếp tục. */
export class ResumeAiDto {
  /** Trạng thái để AI làm tiếp khi hồ sơ đang NEEDS_HR_REVIEW. Mặc định COLLECTING_INFO. */
  @IsOptional()
  @IsIn([
    ApplicationStatus.COLLECTING_INFO,
    ApplicationStatus.SCREENING,
    ApplicationStatus.QUALIFIED,
  ])
  status?: ApplicationStatus;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
