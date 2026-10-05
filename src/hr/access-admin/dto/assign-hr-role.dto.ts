import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { HR_SCOPES, HrScope } from '../../access/hr-permission';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AssignHrRoleDto {
  @Matches(/^[A-Z][A-Z0-9_]{1,63}$/, { message: 'roleCode không hợp lệ' })
  roleCode: string;

  @IsIn(HR_SCOPES, {
    message: `scope phải là một trong ${HR_SCOPES.join(', ')}`,
  })
  scope: HrScope;

  /** Bắt buộc với ORG_UNIT / BRANCH, cấm với scope khác (kiểm tra ở service). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  scopeRefId?: number;

  /** Mặc định hôm nay (giờ Việt Nam). Không được ở quá khứ. */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'effectiveFrom phải có dạng YYYY-MM-DD' })
  effectiveFrom?: string;

  /** Ngày cuối còn hiệu lực (inclusive). Bỏ trống = không thời hạn. */
  @IsOptional()
  @Matches(ISO_DATE, { message: 'effectiveTo phải có dạng YYYY-MM-DD' })
  effectiveTo?: string;

  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Lý do cấp quyền tối thiểu 5 ký tự' })
  @MaxLength(2000)
  reason: string;
}
