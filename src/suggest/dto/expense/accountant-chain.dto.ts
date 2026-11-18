import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Kế toán gửi Kế toán trưởng / Kế toán trưởng duyệt — ghi chú tuỳ chọn. */
export class ChainNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Kế toán trưởng từ chối — bắt buộc lý do. */
export class ChainRejectDto {
  @IsString()
  @IsNotEmpty({ message: 'Phải ghi lý do từ chối' })
  @MaxLength(1000)
  reason!: string;
}
