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

import { TRYON_SIZES } from '../virtual-tryon.constants';
import { TryOnJobStatus } from '../virtual-tryon.enum';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateVirtualTryOnDto {
  /**
   * Yêu cầu riêng cho lần thử này; bỏ trống thì dùng prompt mặc định (giữ mặt
   * và dáng người, chỉ thay trang phục).
   */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(10, { message: 'Prompt quá ngắn, tối thiểu 10 ký tự' })
  @MaxLength(2000)
  prompt?: string;

  @IsOptional()
  @Transform(trim)
  @IsIn(TRYON_SIZES, {
    message: `size phải là một trong: ${TRYON_SIZES.join(', ')}`,
  })
  size?: string;
}

export class QueryVirtualTryOnDto {
  @IsOptional()
  @IsIn(Object.values(TryOnJobStatus), {
    message: `status phải là một trong: ${Object.values(TryOnJobStatus).join(', ')}`,
  })
  status?: TryOnJobStatus;

  /**
   * Chỉ vai trò quản lý mới xem được job của người khác; người dùng thường
   * luôn bị ép về chính mình ở controller, không tin tham số này.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  createdBy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
