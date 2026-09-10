import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { ExpenseRequestKind } from '../../enums/expense-request-kind.enum';

export class CreateExpenseRequestDto {
  @IsString()
  content!: string;

  /**
   * CASH (mặc định) → kế toán lên lệnh chi.
   * EQUIPMENT       → phòng kỹ thuật lên lệnh xuất kho.
   */
  @IsOptional()
  @IsEnum(ExpenseRequestKind)
  requestKind?: ExpenseRequestKind;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  participants?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString()
  expectedPaymentDate!: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  schoolId?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'Năm học không hợp lệ' })
  schoolYear?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  wardId?: number;

  /** Giữ tương thích với client cũ của module đề xuất chi. */
  @IsOptional()
  @IsString()
  beneficiaryInfo?: string;
}
