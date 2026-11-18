import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
} from 'class-validator';

import { parseJsonArray } from './create-expense-request.dto';

/**
 * Chi một phần: chỉ chọn trường (dòng) đã chi, không nhập số tiền. Endpoint
 * gửi multipart (kèm chứng từ) nên danh sách tới dạng chuỗi JSON hoặc lặp
 * trường; ép từng phần tử về số.
 */
export class ConfirmPartiallySpentDto {
  @Transform(({ value }) => {
    const parsed = parseJsonArray({ value });
    if (Array.isArray(parsed)) return parsed.map((item) => Number(item));
    return typeof parsed === 'string' && parsed.trim() !== ''
      ? [Number(parsed)]
      : parsed;
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Chọn ít nhất một trường đã chi' })
  @IsInt({ each: true, message: 'Trường đã chọn không hợp lệ' })
  spentItemIds!: number[];

  @IsString()
  @IsNotEmpty({ message: 'Phải có lý do các trường không chi' })
  reason!: string;
}
