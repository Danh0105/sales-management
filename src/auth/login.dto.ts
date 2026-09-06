import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsNotEmpty()
  phone: string;

  @IsNotEmpty()
  password: string;

  /** ID người dùng do Zalo Mini App cấp (userInfo.id). */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  uid?: string;

  /** ID theo OA (userInfo.idByOA), dùng làm đích gửi cảnh báo Zalo. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  zaloId?: string;
}
