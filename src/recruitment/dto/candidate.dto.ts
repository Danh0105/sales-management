import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CandidateSource } from '../recruitment.enums';
import {
  DATE_ONLY,
  IsSafeMetadata,
  PaginationQueryDto,
  QueryBoolean,
  Trim,
  TrimEach,
} from './common.dto';

const MAX_MONEY = 1_000_000_000_000;

export const ZALO_USER_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Thông tin hồ sơ ứng viên — dùng chung cho HR và AI. Không có field nhạy
 * cảm nào (giới tính, tuổi...) và `forbidNonWhitelisted` chặn gửi thêm.
 */
export class CandidateProfileDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  fullName?: string;

  /** Số VN, chấp nhận "+84 90 123 4567"; lưu về dạng `0901234567`. */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @Trim()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  education?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  experienceSummary?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  totalExperienceMonths?: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  currentJob?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY)
  expectedSalary?: number;

  @IsOptional()
  @Matches(DATE_ONLY, { message: 'availableFrom phải có dạng YYYY-MM-DD' })
  availableFrom?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @TrimEach()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  skills?: string[];

  /** Chỉ lưu đường dẫn tới CV ở kho riêng — không upload vào `/uploads/` public. */
  @IsOptional()
  @Trim()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(1000)
  cvUrl?: string;

  @IsOptional()
  @IsSafeMetadata()
  metadata?: Record<string, string | number | boolean | null>;
}

export class CreateCandidateDto extends CandidateProfileDto {
  @IsOptional()
  @Matches(ZALO_USER_ID, { message: 'zaloUserId không hợp lệ' })
  zaloUserId?: string;

  @IsOptional()
  @IsEnum(CandidateSource)
  source?: CandidateSource;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  /**
   * HR đã xem cảnh báo trùng SĐT/email và vẫn muốn tạo. Ứng viên mới được
   * gắn `suspectedDuplicateIds` để còn đối chiếu sau. Không áp dụng cho trùng
   * `zaloUserId` — trường hợp đó luôn bị chặn.
   */
  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;
}

export class UpdateCandidateDto extends PartialType(CreateCandidateDto) {}

export class QueryCandidateDto extends PaginationQueryDto {
  /** Tìm theo tên, SĐT, email. */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsEnum(CandidateSource)
  source?: CandidateSource;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  deletionRequested?: boolean;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  suspectedDuplicate?: boolean;
}

export class DeletionRequestDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
