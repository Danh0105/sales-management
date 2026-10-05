import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

const toNullableTrimmedString = ({ value }: { value: unknown }) => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  return value.trim() || null;
};

/**
 * Trước đây endpoint sửa nhân viên nhận thẳng `body: any` rồi đẩy nguyên vào
 * `repo.update()`. Khai rõ từng field ở đây để không ai ghi được cột không
 * được phép — đáng kể nhất là `password` (ghi thẳng chuỗi thô vào cột băm sẽ
 * khoá luôn tài khoản đó) và các ID Zalo dùng để nhận diện người đăng nhập.
 */
export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @Transform(toNullableTrimmedString)
  @IsString()
  @MaxLength(50)
  bankAccountNumber?: string | null;

  @IsOptional()
  @Transform(toNullableTrimmedString)
  @IsString()
  @MaxLength(255)
  bankName?: string | null;

  /** Gửi lên thì được băm trước khi lưu, y như lúc tạo tài khoản. */
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsNumber()
  departmentId?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
