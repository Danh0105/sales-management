import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsPositive, Max, Min } from 'class-validator';

import { CASHFLOW_SOURCES, type CashflowSource } from '../../cashflow-sources';

/** Màn tạo đề xuất: lấy khoản chưa chi của một bảng nguồn ở QL thu chi. */
export class CashflowItemsQueryDto {
  @IsIn(CASHFLOW_SOURCES as unknown as string[], {
    message: 'Loại đề xuất chi tháng không hợp lệ',
  })
  source!: CashflowSource;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @IsPositive()
  schoolId?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  /** Kỳ tuỳ chỉnh có "tháng" > 12 nên không giới hạn 12. */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @IsPositive()
  month?: number;

  /** Đang sửa đề xuất của chính mình: khoản của đề xuất đó không tính là đang bị giữ. */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @IsPositive()
  excludeSuggestId?: number;
}
