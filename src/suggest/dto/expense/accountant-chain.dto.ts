import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Kế toán gửi Kế toán trưởng / Kế toán trưởng duyệt — ghi chú tuỳ chọn. */
export class ChainNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Kế toán trưởng từ chối — bắt buộc lý do. */
export class ChainRejectDto {
  @IsString()
  @IsNotEmpty({ message: 'Phải ghi lý do từ chối' })
  @MaxLength(1000)
  reason!: string;
}

/** Số tiền Kế toán nhập cho một khoản của "Đề xuất chi tháng" tích chọn. */
export class MonthlyItemAmountDto {
  /** Id dòng `suggest_monthly_items`. */
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  id!: number;

  /** 0 = không chi khoản này (khoản bị bỏ khỏi đề xuất). */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Số tiền không hợp lệ' })
  @Min(0, { message: 'Số tiền không được âm' })
  amount!: number;
}

/** Kế toán / Kế toán công nợ nhập số tiền từng khoản rồi gửi Giám đốc. */
export class SubmitMonthlyAmountsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Nhập số tiền cho các khoản' })
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MonthlyItemAmountDto)
  items!: MonthlyItemAmountDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
