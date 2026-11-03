import { PartialType } from '@nestjs/mapped-types';
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  CashflowDirection,
  MAX_AMOUNT,
  MAX_COSTS,
  MAX_ITEMS,
  OrderKind,
  OtherCashflowForm,
  OtherCashflowStatus,
  VAT_RATES,
} from '../other-cashflow.constants';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Chuỗi rỗng từ form = không chọn. */
const emptyToNull = ({ value }: { value: unknown }) =>
  value === '' || value === undefined ? null : value;

/** Khoá chống gửi lặp do client sinh (UUID...). */
const IDEMPOTENCY = /^[A-Za-z0-9_\-:.]{8,100}$/;

const DECIMAL = /^\d+(\.\d+)?$/;

/** Nhận số hoặc chuỗi, luôn chuyển về chuỗi thập phân để tính bằng BigInt. */
const toDecimalString = ({ value }: { value: unknown }) =>
  typeof value === 'number' || typeof value === 'string'
    ? String(value).trim()
    : value;

/** Thuế suất từ form: rỗng / null = không thuế. */
const toVatRate = ({ value }: { value: unknown }) =>
  value === '' || value === undefined || value === null ? null : Number(value);

/** SL × đơn giá + thuế của một khoản — thành tiền do backend tính. */
abstract class OtherCashflowLineDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  itemCode?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  unit?: string | null;

  @Transform(toDecimalString)
  @Matches(DECIMAL, { message: 'Số lượng phải là số không âm' })
  quantity!: string;

  @Transform(toDecimalString)
  @Matches(DECIMAL, { message: 'Đơn giá phải là số không âm' })
  unitPrice!: string;

  @IsOptional()
  @Transform(toVatRate)
  @IsIn(VAT_RATES, { message: `Thuế suất chỉ nhận ${VAT_RATES.join('/')}% hoặc không thuế` })
  vatRate?: number | null;
}

/** Khoản thu (bán hàng, dịch vụ…). */
export class OtherCashflowItemDto extends OtherCashflowLineDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng nhập nội dung khoản thu' })
  @MaxLength(255)
  itemName!: string;
}

/** Khoản chi — công ty chi qua quỹ. */
export class OtherCashflowCostDto extends OtherCashflowLineDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng nhập nội dung khoản chi' })
  @MaxLength(255)
  description!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  payee?: string | null;
}

export class CreateOtherCashflowDto {
  /** Mặc định Thông thường. */
  @IsOptional()
  @IsEnum(OtherCashflowForm)
  form?: OtherCashflowForm;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  documentNo?: string | null;

  /** Khoản thu + khoản chi: cần ít nhất một khoản; số tiền hợp đồng tính từ các khoản. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => OtherCashflowItemDto)
  items?: OtherCashflowItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_COSTS)
  @ValidateNested({ each: true })
  @Type(() => OtherCashflowCostDto)
  costs?: OtherCashflowCostDto[];

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng nhập tên/nội dung hợp đồng' })
  @MaxLength(255)
  title!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng nhập đối tác' })
  @MaxLength(255)
  partnerName!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  schoolId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString({ strict: true }, { message: 'Ngày ký không hợp lệ' })
  signedDate?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString({ strict: true }, { message: 'Ngày dự kiến không hợp lệ' })
  expectedDate?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

/** Người lập sửa khi còn chờ duyệt / bị từ chối — lưu xong là gửi duyệt lại. */
export class UpdateOtherCashflowDto extends PartialType(CreateOtherCashflowDto) {}

export class ReviewOtherCashflowDto {
  @IsIn([OtherCashflowStatus.APPROVED, OtherCashflowStatus.REJECTED])
  decision!: OtherCashflowStatus.APPROVED | OtherCashflowStatus.REJECTED;

  /** Bắt buộc khi từ chối (kiểm tra ở service). */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class ReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng nhập lý do' })
  @MaxLength(2000)
  reason!: string;
}

/** Thủ quỹ thu/chi trực tiếp (hình thức Thông thường). */
export class RecordEntryDto {
  @IsEnum(CashflowDirection, { message: 'Vui lòng chọn thu hay chi' })
  flow!: CashflowDirection;

  /** Lần chi: khoản chi được chi (bắt buộc). */
  @ValidateIf((dto: RecordEntryDto) => dto.flow === CashflowDirection.OUT)
  @Type(() => Number)
  @IsInt({ message: 'Vui lòng chọn khoản chi' })
  costId?: number;

  @IsDateString({ strict: true }, { message: 'Ngày thu/chi không hợp lệ' })
  date!: string;

  @Type(() => Number)
  @IsInt({ message: 'Số tiền phải là số nguyên (đồng)' })
  @Min(1, { message: 'Số tiền phải lớn hơn 0' })
  @Max(MAX_AMOUNT)
  amount!: number;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng chọn tài khoản tiền' })
  @MaxLength(20)
  cashAccountCode!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;

  @Matches(IDEMPOTENCY, { message: 'Khoá chống trùng không hợp lệ' })
  idempotencyKey!: string;
}

/** Kế toán công nợ lập phiếu thu (tổng phải thu) / lệnh chi (một khoản chi). */
export class CreateOrderDto {
  @IsEnum(OrderKind)
  kind!: OrderKind;

  /** Bắt buộc với lệnh chi. */
  @ValidateIf((dto: CreateOrderDto) => dto.kind === OrderKind.PAYMENT)
  @Type(() => Number)
  @IsInt({ message: 'Vui lòng chọn khoản chi' })
  costId?: number;

  @Type(() => Number)
  @IsInt({ message: 'Số tiền phải là số nguyên (đồng)' })
  @Min(1, { message: 'Số tiền phải lớn hơn 0' })
  @Max(MAX_AMOUNT)
  amount!: number;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString({ strict: true }, { message: 'Hạn thu/chi không hợp lệ' })
  dueDate?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** Thủ quỹ thu/chi theo phiếu — số tiền đúng bằng phiếu. */
export class ExecuteOrderDto {
  @IsDateString({ strict: true }, { message: 'Ngày thu/chi không hợp lệ' })
  date!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Vui lòng chọn tài khoản tiền' })
  @MaxLength(20)
  cashAccountCode!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;

  @Matches(IDEMPOTENCY, { message: 'Khoá chống trùng không hợp lệ' })
  idempotencyKey!: string;
}

export class UploadAttachmentDto {
  /** Chứng từ của lần ghi nhận nào; bỏ trống = tệp hợp đồng. */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  entryId?: number | null;
}

export class ListOtherCashflowDto {
  @IsOptional()
  @IsEnum(OtherCashflowStatus)
  status?: OtherCashflowStatus;

  @IsOptional()
  @IsEnum(OtherCashflowForm)
  form?: OtherCashflowForm;

  /** Tìm theo tên hợp đồng, đối tác, người lập, mã TCN-xxxxx. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class FileQueryDto {
  @IsOptional()
  @IsIn(['inline', 'attachment'])
  disposition?: 'inline' | 'attachment';
}
