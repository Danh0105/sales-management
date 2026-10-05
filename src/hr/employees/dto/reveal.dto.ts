import { IsString, MaxLength, MinLength } from 'class-validator';
import { Trim } from './common';

/** Lý do xem đầy đủ — bắt buộc, nằm trong body (không bao giờ trên URL). */
export class RevealSensitiveDto {
  @Trim()
  @IsString()
  @MinLength(5, { message: 'Lý do xem dữ liệu tối thiểu 5 ký tự' })
  @MaxLength(2000)
  reason: string;
}
