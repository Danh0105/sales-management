import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { HR_AUDIT_ACTIONS } from '../hr-audit-action';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class QueryHrAuditLogDto {
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_.]{0,63}$/)
  entity?: string;

  @IsOptional()
  @MaxLength(64)
  entityId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  actorAccountId?: number;

  @IsOptional()
  @IsIn(HR_AUDIT_ACTIONS)
  action?: string;

  /** Ngày theo giờ Việt Nam, inclusive. */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'from phải có dạng YYYY-MM-DD' })
  from?: string;

  /** Ngày theo giờ Việt Nam, inclusive. */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'to phải có dạng YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
