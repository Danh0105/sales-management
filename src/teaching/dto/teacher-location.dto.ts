import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TeacherLocationChangeStatus } from '../entities/teacher-location-change.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CaptureTeacherLocationDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-180)
  @Max(180)
  longitude!: number;
}

export class ReviewTeacherLocationDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class QueryTeacherLocationChangesDto {
  @IsOptional()
  @IsEnum(TeacherLocationChangeStatus)
  status?: TeacherLocationChangeStatus = TeacherLocationChangeStatus.PENDING;
}
