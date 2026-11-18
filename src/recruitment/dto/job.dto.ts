import { PartialType } from '@nestjs/mapped-types';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  EmploymentType,
  RecruitmentEducationLevel,
  RecruitmentExperienceLevel,
  RecruitmentJobStatus,
  RecruitmentSalaryStructure,
  RecruitmentSeniority,
} from '../recruitment.enums';
import { PaginationQueryDto, Trim, TrimEach } from './common.dto';

const MAX_MONEY = 1_000_000_000_000;

function UpperTrim(): PropertyDecorator {
  return Transform((params: TransformFnParams): unknown => {
    const value: unknown = params.value;
    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  });
}

function NormalizePhone(): PropertyDecorator {
  return Transform((params: TransformFnParams): unknown => {
    const value: unknown = params.value;
    return typeof value === 'string' ? value.replace(/[\s.()-]/g, '') : value;
  });
}

function NormalizePhones(): PropertyDecorator {
  return Transform((params: TransformFnParams): unknown => {
    const value: unknown = params.value;
    return Array.isArray(value)
      ? value.map((item) =>
          typeof item === 'string' ? item.replace(/[\s.()-]/g, '') : item,
        )
      : value;
  });
}

export class RecruitmentWorkLocationDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  provinceId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  wardId!: number;

  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  address!: string;
}

/**
 * Schema cố định của `screening_criteria`. Controller bật
 * `forbidNonWhitelisted`, nên mọi khoá ngoài danh sách này (giới tính, tuổi,
 * tôn giáo...) bị trả 400 thay vì lặng lẽ lưu.
 */
export class ScreeningCriteriaDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  minimumExperienceMonths?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @TrimEach()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  requiredSkills?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @TrimEach()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  preferredSkills?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @TrimEach()
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  locations?: string[];

  @IsOptional()
  @IsBoolean()
  availableImmediatelyPreferred?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  maxStartDelayDays?: number;
}

export class CreateJobDto {
  // Optional ở DTO để PATCH vị trí cũ vẫn tương thích; create bắt buộc ở service.
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(50)
  positionRole?: string;

  /** Mã vị trí do HR đặt, vd. `SALES-CM-01`. Lưu chữ hoa. */
  @UpperTrim()
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,49}$/, {
    message: 'code chỉ gồm chữ, số, "-" hoặc "_" (2–50 ký tự)',
  })
  code!: string;

  @Trim()
  @IsString()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  /**
   * Danh mục ngành nghề riêng chưa tồn tại; giai đoạn này tái sử dụng danh mục
   * phòng ban đã được quản trị trong hệ thống, tối đa ba lựa chọn.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  industryIds?: number[];

  @IsOptional()
  @IsEnum(RecruitmentSeniority)
  seniority?: RecruitmentSeniority;

  @IsOptional()
  @IsEnum(RecruitmentExperienceLevel)
  experienceLevel?: RecruitmentExperienceLevel;

  @IsOptional()
  @IsDateString({ strict: true })
  applicationDeadline?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  numberOfPositions?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY)
  salaryMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY)
  salaryMax?: number;

  @IsOptional()
  @IsBoolean()
  salaryNegotiable?: boolean;

  @IsOptional()
  @IsEnum(RecruitmentSalaryStructure)
  salaryStructure?: RecruitmentSalaryStructure;

  @IsOptional()
  @UpperTrim()
  @Matches(/^[A-Z]{3}$/, { message: 'currency là mã ISO 3 chữ cái, vd. VND' })
  currency?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(20000)
  requirements?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(20000)
  responsibilities?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(20000)
  benefits?: string;

  @IsOptional()
  @IsEnum(RecruitmentEducationLevel)
  educationLevel?: RecruitmentEducationLevel;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  probationPeriod?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => RecruitmentWorkLocationDto)
  workLocations?: RecruitmentWorkLocationDto[];

  @IsOptional()
  @IsBoolean()
  allowApplicationsWithoutCv?: boolean;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  contactName?: string;

  @IsOptional()
  @Trim()
  @IsEmail()
  @MaxLength(255)
  contactEmail?: string;

  @IsOptional()
  @NormalizePhone()
  @Matches(/^(?:\+84|0)\d{9,10}$/, {
    message: 'contactPhone phải là số điện thoại Việt Nam hợp lệ',
  })
  contactPhone?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @NormalizePhones()
  @Matches(/^(?:\+84|0)\d{9,10}$/, {
    each: true,
    message: 'additionalPhones phải là số điện thoại Việt Nam hợp lệ',
  })
  additionalPhones?: string[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ScreeningCriteriaDto)
  screeningCriteria?: ScreeningCriteriaDto;
}

/** Trạng thái không sửa qua PATCH — dùng publish/pause/close. */
export class UpdateJobDto extends PartialType(CreateJobDto) {}

export class QueryJobDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(RecruitmentJobStatus)
  status?: RecruitmentJobStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  keyword?: string;
}
