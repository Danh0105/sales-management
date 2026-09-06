import {
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDateString,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSchoolExpenseItemDto {
  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  schoolExpenseId!: number;

  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  subjectId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  totalPeriods?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  studentCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  monthsCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rowIndex?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  giaovien?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  thue?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  csvc?: number;

  @IsOptional()
  @IsDateString()
  expenseDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  paidAmount?: number;

  @IsOptional()
  @IsString()
  payer?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
