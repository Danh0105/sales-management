import {
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDateString,
  IsString,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  REVENUE_INVOICE_STATUSES,
  REVENUE_INVOICE_TYPES,
} from '../revenue-invoice-status.enum';

export class CreateRevenueItemDto {
  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  schoolExpenseId!: number;

  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  subjectId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  content?: string;

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
  unitPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rowIndex?: number;

  @IsOptional()
  @IsString()
  @IsIn(REVENUE_INVOICE_STATUSES)
  invoiced?: string;

  @IsOptional()
  @IsString()
  @IsIn(REVENUE_INVOICE_TYPES)
  invoiceType?: string;

  @IsOptional()
  @IsString()
  invoiceOther?: string;

  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  paidAmount?: number;

  @IsOptional()
  @IsString()
  @IsIn(['cash', 'bank_transfer'])
  paymentMethod?: string;

  @IsOptional()
  @IsDateString()
  paymentDate?: string;
}
