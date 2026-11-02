import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  MANUAL_ENTRY_KINDS,
  type ManualEntryKind,
} from '../cash-manual-entry.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** Bút toán nhập tay; tài khoản và ngày được kiểm thêm ở service. */
export class CreateManualEntryDto {
  @IsIn(MANUAL_ENTRY_KINDS, {
    message: 'Loại bút toán phải là Thu, Chi hoặc Chuyển nội bộ',
  })
  kind!: ManualEntryKind;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Ngày hạch toán phải có dạng YYYY-MM-DD',
  })
  entryDate!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Chọn tài khoản' })
  @MaxLength(20)
  accountCode!: string;

  /** Chỉ dùng cho Chuyển nội bộ: tài khoản nhận. */
  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  counterAccountCode?: string | null;

  /** Số tiền dương, tối đa 2 chữ số thập phân. */
  @Transform(({ value }) => (typeof value === 'number' ? String(value) : value))
  @Matches(/^\d{1,16}(\.\d{1,2})?$/, {
    message: 'Số tiền phải là số dương, tối đa 2 chữ số thập phân',
  })
  amount!: string;

  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(50)
  documentNo?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Nhập diễn giải' })
  @MaxLength(500)
  description!: string;

  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  partnerName?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

export class UpdateManualEntryDto extends PartialType(CreateManualEntryDto) {}
