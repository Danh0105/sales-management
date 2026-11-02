import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ISO_DATE, Trim, TrimToNull } from '../../employees/dto/common';
import { DOCUMENT_TYPES } from '../document-policy';
import type { DocumentType } from '../document-policy';

/** Trường metadata dùng chung cho tạo/sửa. `null`/chuỗi rỗng = xoá giá trị. */
class DocumentMetadataFields {
  @IsOptional()
  @TrimToNull()
  @IsString()
  @MaxLength(200)
  issuer?: string | null;

  @IsOptional()
  @TrimToNull()
  @Matches(ISO_DATE, { message: 'issuedOn phải có dạng YYYY-MM-DD' })
  issuedOn?: string | null;

  @IsOptional()
  @TrimToNull()
  @Matches(ISO_DATE, { message: 'expiresOn phải có dạng YYYY-MM-DD' })
  expiresOn?: string | null;

  @IsOptional()
  @TrimToNull()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

/**
 * Trường text của multipart khi tạo tài liệu. KHÔNG có `classification` hay
 * loại file — server suy ra từ `documentType`.
 */
export class CreateDocumentDto extends DocumentMetadataFields {
  @IsIn(DOCUMENT_TYPES as unknown as string[], {
    message: `documentType phải là một trong ${DOCUMENT_TYPES.join(', ')}`,
  })
  documentType: DocumentType;

  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;
}

export class UpdateDocumentDto extends DocumentMetadataFields {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;
}

export class AddDocumentVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @TrimToNull()
  @IsString()
  @MaxLength(500)
  changeNote?: string | null;
}

export class ArchiveDocumentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @Trim()
  @IsString()
  @MinLength(5, { message: 'Lý do lưu trữ tối thiểu 5 ký tự' })
  @MaxLength(2000)
  reason: string;
}

export class ListDocumentsQuery {
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED', 'ALL'])
  status?: 'ACTIVE' | 'ARCHIVED' | 'ALL';

  @IsOptional()
  @IsIn(DOCUMENT_TYPES as unknown as string[])
  type?: DocumentType;
}

export class ExpiringDocumentsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  withinDays?: number;
}
