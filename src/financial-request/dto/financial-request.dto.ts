import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  FinancialRequestType,
  InvoiceType,
} from '../financial-request.constants';

const DECIMAL = /^\d+(\.\d+)?$/;

/** Nhận số hoặc chuỗi, luôn chuyển về chuỗi thập phân để tính bằng BigInt. */
const toDecimalString = ({ value }: { value: unknown }) =>
  typeof value === 'number' || typeof value === 'string'
    ? String(value).trim()
    : value;

const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

export class FinancialRequestItemDto {
  /** Có id = sửa dòng cũ (giữ liên kết hoá đơn đính kèm); không có = dòng mới. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  id?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(50)
  unit?: string | null;

  @Transform(toDecimalString)
  @Matches(DECIMAL, { message: 'Số lượng phải là số không âm' })
  quantity!: string;

  @Transform(toDecimalString)
  @Matches(DECIMAL, { message: 'Đơn giá phải là số không âm' })
  unitPrice!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  incurredDate?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(100)
  invoiceNumber?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEnum(InvoiceType)
  invoiceType?: InvoiceType | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(255)
  supplierName?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

export class AdvanceAllocationDto {
  @Type(() => Number)
  @IsInt()
  advanceId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;
}

class FinancialRequestBaseDto {
  @IsOptional()
  @IsDateString()
  requestDate?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(5000)
  purpose?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(255)
  projectName?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  expectedUseDate?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  settlementDueDate?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(255)
  location?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  tripStartDate?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  tripEndDate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  directManagerId?: number | null;

  // ---- Tạm ứng lương ----
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  salaryYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  salaryMonth?: number;

  /** Số tiền đề nghị ứng lương (VND). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requestedAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  deductionStartYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  deductionStartMonth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  deductionPeriods?: number;

  // ---- Nhận tiền ----
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(255)
  payeeName?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(255)
  bankAccountHolder?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(255)
  bankName?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(/^[0-9A-Za-z\- ]{4,50}$/, {
    message: 'Số tài khoản chỉ gồm chữ số/chữ cái, 4–50 ký tự',
  })
  bankAccountNumber?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(2000)
  paymentNote?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FinancialRequestItemDto)
  items?: FinancialRequestItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AdvanceAllocationDto)
  allocations?: AdvanceAllocationDto[];
}

export class CreateFinancialRequestDto extends FinancialRequestBaseDto {
  @IsEnum(FinancialRequestType)
  type!: FinancialRequestType;

  @Type(() => Number)
  @IsInt()
  companyId!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title!: string;
}

export class UpdateFinancialRequestDto extends FinancialRequestBaseDto {
  /** Phiên bản đang sửa — lệch nghĩa là người khác vừa lưu, phải tải lại. */
  @Type(() => Number)
  @IsInt()
  version!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  companyId?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title?: string;
}

export const LIST_SCOPES = ['mine', 'approvals', 'all', 'payments'] as const;
export type ListScope = (typeof LIST_SCOPES)[number];

export const LIST_SORTS = [
  'requestDate',
  'createdAt',
  'totalAmount',
  'code',
] as const;

export class FinancialRequestQueryDto {
  @IsOptional()
  @IsIn(LIST_SCOPES)
  scope?: ListScope;

  @IsOptional()
  @IsEnum(FinancialRequestType)
  type?: FinancialRequestType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  companyId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  departmentId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  requesterId?: number;

  @IsOptional()
  @IsString()
  approvalStatus?: string;

  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @IsOptional()
  @IsString()
  settlementStatus?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountMax?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Chỉ tạm ứng đã quá hạn hoàn ứng. */
  @IsOptional()
  @IsIn(['true', 'false'])
  overdue?: string;

  @IsOptional()
  @IsIn(LIST_SORTS)
  sort?: (typeof LIST_SORTS)[number];

  @IsOptional()
  @IsIn(['ASC', 'DESC', 'asc', 'desc'])
  order?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class FinancialReportQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  companyId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  departmentId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  requesterId?: number;

  @IsOptional()
  @IsEnum(FinancialRequestType)
  type?: FinancialRequestType;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}

export class AvailableAdvancesQueryDto {
  @Type(() => Number)
  @IsInt()
  companyId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  excludeSettlementId?: number;
}

export class SalaryAdvanceCheckQueryDto {
  @Type(() => Number)
  @IsInt()
  companyId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  excludeRequestId?: number;
}

export class DeductionQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  companyId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsIn(['PLANNED', 'DEDUCTED', 'CANCELLED'])
  status?: string;
}
