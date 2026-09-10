import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches } from 'class-validator';

export class QueryActivityLogDto {
  @IsOptional() @Type(() => Number) @IsInt()
  actorId?: number;

  /** Đoạn đầu của path: `teachers`, `employees`, `teaching-sessions`... */
  @IsOptional() @IsString()
  resource?: string;

  @IsOptional() @IsString()
  method?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  success?: boolean;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  fromDate?: string;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  toDate?: string;

  /** Chỉ lấy thao tác chạm tới trường này (theo id, không theo tên). */
  @IsOptional() @Type(() => Number) @IsInt()
  schoolId?: number;

  /** Chỉ lấy thao tác chạm tới giáo viên này. */
  @IsOptional() @Type(() => Number) @IsInt()
  teacherId?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  limit?: number;
}
