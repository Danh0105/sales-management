import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Kế toán trưởng / giám đốc cập nhật số dư gốc đã đối chiếu và trạng thái sử
 * dụng. Số dư và ngày đi theo cặp: gửi cả hai, hoặc cả hai null để xoá (trở
 * về "chưa xác minh").
 */
export class UpdateCashAccountDto {
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
