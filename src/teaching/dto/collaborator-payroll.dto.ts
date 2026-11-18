import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { IsCalendarDate } from '../../policy/dto/query-policies.dto';

/** Bộ lọc tổng hợp lương giáo viên cộng tác viên theo trường / môn. */
export class QueryCollaboratorPayrollDto {
  @IsCalendarDate()
  fromDate!: string;

  @IsCalendarDate()
  toDate!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  schoolId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  subjectId?: number;
}
