import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Endpoint gửi multipart/form-data (kèm file) nên `items` tới dưới dạng chuỗi JSON. */
export const parseJsonArray = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

/** Endpoint gửi multipart/form-data nên boolean tới dưới dạng chuỗi "true"/"false". */
export const parseBoolean = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class RequestedEquipmentItemDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @Type(() => Number)
  @IsInt({ message: 'Số lượng phải là số nguyên' })
  @IsPositive({ message: 'Số lượng phải lớn hơn 0' })
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  /** Chọn từ thiết bị có sẵn trong kho — bỏ trống nếu cần mua mới. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseItemId?: number;
}

export class CreateExpenseRequestDto {
  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  participants?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString()
  expectedPaymentDate!: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  schoolId?: number;

  /** Không bắt buộc — bỏ trống thì server tự điền năm học hiện tại. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'Năm học không hợp lệ' })
  schoolYear?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  wardId?: number;

  /** Giữ tương thích với client cũ của module đề xuất chi. */
  @IsOptional()
  @IsString()
  beneficiaryInfo?: string;

  /**
   * Kinh doanh tự đánh dấu: đề xuất này nên trừ vào chính sách liên quan.
   * Chỉ để hiển thị/thống kê, không có logic trừ tiền tự động kèm theo.
   */
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  deductPolicy?: boolean;
}
