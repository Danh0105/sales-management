import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDateString,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ManagementExpenseOtherCostDto } from './management-expense-other-cost.dto';

export class CreateManagementExpenseItemDto {
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
  ql1UnitPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  ql2UnitPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  ql1Tax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  ql2Tax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  invoiceAmount?: number;

  @IsOptional()
  @IsDateString()
  collectedDate?: string;

  @IsOptional()
  @IsDateString()
  expenseDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  contractAmount?: number;

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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManagementExpenseOtherCostDto)
  otherCosts?: ManagementExpenseOtherCostDto[];
}
