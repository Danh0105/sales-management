import {
  IsArray,
  IsOptional,
  IsNumber,
  IsDateString,
  IsIn,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { INVOICE_CASH_ACCOUNT_CODES } from '../../revenue-item/invoice-cash-account';
import { ManagementExpenseOtherCostDto } from './management-expense-other-cost.dto';

export class UpdateManagementExpenseItemDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subjectId?: number;

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
  @IsIn(INVOICE_CASH_ACCOUNT_CODES)
  cashAccount?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManagementExpenseOtherCostDto)
  otherCosts?: ManagementExpenseOtherCostDto[];
}
