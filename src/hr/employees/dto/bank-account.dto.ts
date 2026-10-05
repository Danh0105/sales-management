import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SENSITIVE_MAX_INPUT, Trim, TrimToNull } from './common';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateBankAccountDto {
  /** Mã ngân hàng viết tắt (VCB, TCB, ...) — cùng số tài khoản ở 2 ngân hàng là 2 tài khoản. */
  @Transform(upper)
  @Matches(/^[A-Z0-9]{2,20}$/, { message: 'bankCode gồm 2–20 chữ/số' })
  bankCode: string;

  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  bankName: string;

  @IsOptional()
  @TrimToNull()
  @IsString()
  @MaxLength(200)
  branchName?: string | null;

  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  accountHolderName: string;

  @IsString()
  @MaxLength(SENSITIVE_MAX_INPUT)
  accountNumber: string;
}

export class UpdateBankAccountDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z0-9]{2,20}$/, { message: 'bankCode gồm 2–20 chữ/số' })
  bankCode?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @TrimToNull()
  @IsString()
  @MaxLength(200)
  branchName?: string | null;

  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  accountHolderName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SENSITIVE_MAX_INPUT)
  accountNumber?: string;
}
