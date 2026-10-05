import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  ORG_LEADER_ROLES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES,
} from '../org-policy';
import { SCOPE_OPTION_TYPES } from '../org-scope-options';
import type { ScopeOptionType } from '../org-scope-options';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class ReasonField {
  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Lý do tối thiểu 5 ký tự' })
  @MaxLength(2000)
  reason: string;
}

export class AsOfQuery {
  /** Ngày xem cơ cấu (giờ Việt Nam). Mặc định hôm nay. */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'asOf phải có dạng YYYY-MM-DD' })
  asOf?: string;

  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === 'true' || value === true,
  )
  @IsBoolean()
  includeInactive?: boolean;
}

/** Ô chọn phạm vi khi cấp quyền HR (ACCESS_ADMIN). */
export class ScopeOptionsQuery {
  @IsIn(SCOPE_OPTION_TYPES as unknown as string[], {
    message: 'scopeType chỉ nhận BRANCH hoặc ORG_UNIT',
  })
  scopeType: ScopeOptionType;

  /** Ngày bắt đầu hiệu lực của quyền định cấp (giờ Việt Nam). Mặc định hôm nay. */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'asOf phải có dạng YYYY-MM-DD' })
  asOf?: string;
}

/** Không có `code`: hệ thống sinh `DV` + 4 số. Gửi `code` → 400. */
export class CreateOrgUnitDto extends ReasonField {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsIn(ORG_UNIT_TYPES as unknown as string[])
  unitType: (typeof ORG_UNIT_TYPES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number;

  /** Mặc định hôm nay. Được lùi ngày khi thiết lập ban đầu. */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'effectiveFrom phải có dạng YYYY-MM-DD' })
  effectiveFrom?: string;
}

export class ReviseOrgUnitDto extends ReasonField {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @Matches(ISO_DATE, { message: 'effectiveFrom phải có dạng YYYY-MM-DD' })
  effectiveFrom: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsIn(ORG_UNIT_TYPES as unknown as string[])
  unitType?: (typeof ORG_UNIT_TYPES)[number];

  /** `null` chỉ hợp lệ khi đơn vị là COMPANY. Bỏ trống = giữ nguyên. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  parentId?: number | null;

  @IsOptional()
  @IsIn(ORG_UNIT_STATUSES as unknown as string[])
  status?: (typeof ORG_UNIT_STATUSES)[number];
}

export class AssignOrgLeaderDto extends ReasonField {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId: number;

  @IsIn(ORG_LEADER_ROLES as unknown as string[])
  leaderRole: (typeof ORG_LEADER_ROLES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionId?: number;

  @IsBoolean()
  isApprovalAuthority: boolean;

  @Matches(ISO_DATE, { message: 'effectiveFrom phải có dạng YYYY-MM-DD' })
  effectiveFrom: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'effectiveTo phải có dạng YYYY-MM-DD' })
  effectiveTo?: string;
}

export class EndOrgLeaderDto extends ReasonField {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  /** Ngày cuối còn giữ vai trò (inclusive). */
  @Matches(ISO_DATE, { message: 'effectiveTo phải có dạng YYYY-MM-DD' })
  effectiveTo: string;
}

/** Không có `code`: hệ thống sinh `CD` + 4 số. Gửi `code` → 400. */
export class CreatePositionDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  level?: number;
}

export class UpdatePositionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  level?: number | null;
}

export class VersionReasonDto extends ReasonField {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}

export class CreateLegacyOrgMappingDto {
  @IsIn(['DEPARTMENT', 'ROLE'])
  sourceType: 'DEPARTMENT' | 'ROLE';

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sourceValue: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  orgUnitId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priority?: number;
}
