import { Expose, Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 1 khoản "Chi khác" trong 1 dòng chi ngoài.
 * Chấp nhận alias `id` từ FE và map sang `policyOtherCostId`.
 */
export class ManagementExpenseOtherCostDto {
  @IsOptional()
  @Expose()
  // FE có thể gửi `id` (ID khoản chi trong chính sách) hoặc `policyOtherCostId`.
  @Transform(({ obj, value }) =>
    value ?? obj?.id ?? null,
  )
  @Type(() => Number)
  @IsInt()
  policyOtherCostId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice!: number;

  /** Đơn giá thuế (tuyệt đối), optional. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tax?: number;
}
