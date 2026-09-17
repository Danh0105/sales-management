import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
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

import { ExpenseRequestKind } from '../../enums/expense-request-kind.enum';

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

  /**
   * CASH (mặc định) → kế toán lên lệnh chi.
   * EQUIPMENT       → phòng kỹ thuật lên lệnh xuất kho.
   */
  @IsOptional()
  @IsEnum(ExpenseRequestKind)
  requestKind?: ExpenseRequestKind;

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
   * Danh sách thiết bị mong muốn — chỉ áp dụng khi `requestKind = EQUIPMENT`.
   * Kinh doanh có thể chọn thiết bị có sẵn trong kho (`warehouseItemId`) hoặc
   * để trống nếu cần mua mới; phòng kỹ thuật chốt danh sách thật khi lập lệnh
   * xuất kho.
   */
  @IsOptional()
  @Transform(parseJsonArray)
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RequestedEquipmentItemDto)
  items?: RequestedEquipmentItemDto[];
}
