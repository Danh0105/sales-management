import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsCalendarDate } from '../../policy/dto/query-policies.dto';
import { SessionStatus } from '../teaching.enum';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class QueryLessonImagesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30, { message: 'limit không được lớn hơn 30' })
  limit: number = 30;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  provinceId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  schoolId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  schoolLocationId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  teacherId?: number;

  @IsOptional() @IsCalendarDate()
  fromDate?: string;

  @IsOptional() @IsCalendarDate()
  toDate?: string;

  @IsOptional()
  @IsEnum(SessionStatus, { message: 'status không hợp lệ' })
  status?: SessionStatus;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['createdAt', 'sessionDate'], { message: 'sortBy không hợp lệ' })
  sortBy: 'createdAt' | 'sessionDate' = 'createdAt';

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(['ASC', 'DESC'], { message: 'sortOrder không hợp lệ' })
  sortOrder: 'ASC' | 'DESC' = 'DESC';
}
