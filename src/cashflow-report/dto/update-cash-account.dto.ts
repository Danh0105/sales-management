import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Kế toán trưởng / thủ quỹ / giám đốc sửa tên, thứ tự, số dư gốc đã đối chiếu
 * và trạng thái sử dụng. Mã và nhóm không đổi được (chứng từ lưu theo mã). Số
 * dư và ngày đi theo cặp: gửi cả hai, hoặc cả hai null để xoá (trở về "chưa
 * xác minh").
 */
export class UpdateCashAccountDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Nhập tên tài khoản' })
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;

  /** Chuỗi số tiền, tối đa 2 chữ số thập phân, có thể âm (vd thấu chi). */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(/^-?\d{1,16}(\.\d{1,2})?$/, {
    message: 'openingBalance phải là số tiền hợp lệ, tối đa 2 chữ số thập phân',
  })
  openingBalance?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'openingBalanceDate phải có dạng YYYY-MM-DD',
  })
  openingBalanceDate?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}
