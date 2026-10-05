import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { HrIdentityDocumentType } from '../entities/hr-employee-identity-document.entity';
import { ISO_DATE, SENSITIVE_MAX_INPUT, TrimToNull } from './common';

const TYPES = Object.values(HrIdentityDocumentType) as string[];

export class CreateIdentityDocumentDto {
  @IsIn(TYPES, {
    message: `documentType phải là một trong ${TYPES.join(', ')}`,
  })
  documentType: HrIdentityDocumentType;

  @IsString()
  @MaxLength(SENSITIVE_MAX_INPUT)
  number: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'issuedOn phải có dạng YYYY-MM-DD' })
  issuedOn?: string | null;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'expiresOn phải có dạng YYYY-MM-DD' })
  expiresOn?: string | null;

  @IsOptional()
  @TrimToNull()
  @IsString()
  @MaxLength(255)
  issuedPlace?: string | null;
}

/** `documentType` không đổi được — đổi loại giấy tờ = tạo bản ghi mới. */
export class UpdateIdentityDocumentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @IsString()
  @MaxLength(SENSITIVE_MAX_INPUT)
  number?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'issuedOn phải có dạng YYYY-MM-DD' })
  issuedOn?: string | null;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'expiresOn phải có dạng YYYY-MM-DD' })
  expiresOn?: string | null;

  @IsOptional()
  @TrimToNull()
  @IsString()
  @MaxLength(255)
  issuedPlace?: string | null;
}
