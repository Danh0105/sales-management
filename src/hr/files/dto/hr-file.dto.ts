import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { HR_FILE_DOCUMENT_TYPES, HrFileDocumentType } from '../hr-file-policy';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Trường text của multipart. KHÔNG có `classification` — server quyết định. */
export class UploadHrFileDto {
  @IsIn(HR_FILE_DOCUMENT_TYPES, {
    message: `documentType phải là một trong ${HR_FILE_DOCUMENT_TYPES.join(', ')}`,
  })
  documentType: HrFileDocumentType;

  /** Bắt buộc với IDENTITY_FRONT / IDENTITY_BACK, cấm với loại khác. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  identityDocumentId?: number;
}

export class RequestHrFileAccessDto {
  /** Bắt buộc với file CONFIDENTIAL / RESTRICTED (kiểm tra ở service). */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Lý do xem tài liệu tối thiểu 5 ký tự' })
  @MaxLength(2000)
  reason?: string;
}

export class ArchiveHrFileDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Lý do lưu trữ tối thiểu 5 ký tự' })
  @MaxLength(2000)
  reason: string;
}
