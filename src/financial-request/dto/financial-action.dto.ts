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
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { AttachmentKind, PaymentMethod } from '../financial-request.constants';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Khoá chống gửi lặp do client sinh (UUID...). */
const IDEMPOTENCY = /^[A-Za-z0-9_\-:.]{8,100}$/;

export class ItemAdjustmentDto {
  @Type(() => Number)
  @IsInt()
  itemId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  approvedAmount!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ApproveStepDto {
  /** Bước đang duyệt — sai/đã xử lý thì từ chối (chống bấm lặp, duyệt nhầm bước). */
  @Type(() => Number)
  @IsInt()
  stepId!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  comment?: string;

  /** Số tiền chấp nhận theo dòng (chỉ bước được phép điều chỉnh). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ItemAdjustmentDto)
  adjustments?: ItemAdjustmentDto[];
}

export class DecideStepDto {
  @Type(() => Number)
  @IsInt()
  stepId!: number;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng nhập ý kiến/lý do' })
  @MaxLength(2000)
  comment!: string;
}

export class AdjustItemsDto {
  @Type(() => Number)
  @IsInt()
  stepId!: number;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ItemAdjustmentDto)
  adjustments!: ItemAdjustmentDto[];
}

export class ReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng nhập lý do' })
  @MaxLength(2000)
  reason!: string;
}

export class WithdrawDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class MoneyMovementDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  /** Ngày chi / ngày thu (YYYY-MM-DD). */
  @IsDateString()
  date!: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /** Tài khoản tiền 111/112 — bắt buộc khi thủ quỹ chi tiền, tuỳ chọn khi thu. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  cashAccountCode?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  transactionRef?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;

  @Matches(IDEMPOTENCY, { message: 'idempotencyKey không hợp lệ' })
  idempotencyKey!: string;
}

export class ConfirmDeductionDto {
  /** Số tiền thực trừ kỳ này; bỏ trống = theo kế hoạch. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;

  @Matches(IDEMPOTENCY, { message: 'idempotencyKey không hợp lệ' })
  idempotencyKey!: string;
}

export class UploadAttachmentDto {
  @IsOptional()
  @IsEnum(AttachmentKind)
  kind?: AttachmentKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  itemId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  paymentId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  refundId?: number;
}

export class ExportQueryDto {
  @IsOptional()
  @IsIn(['inline', 'attachment'])
  disposition?: 'inline' | 'attachment';
}

export class PaymentQueueQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  companyId?: number;

  @IsOptional()
  @IsIn(['payable', 'receivable'])
  kind?: 'payable' | 'receivable';
}

export class BalanceQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  companyId?: number;
}

export class DateRangeDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
